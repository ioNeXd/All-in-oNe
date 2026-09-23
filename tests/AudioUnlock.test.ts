import { describe, it, expect } from "vitest";
import { AudioUnlocker, type AudioContextLike, type GestureSource } from "../src/core/AudioUnlock";

/**
 * Contrato do desbloqueio de áudio: contexto criado/resumido no PRIMEIRO
 * gesto do usuário (política de autoplay do Chromium), disparos automáticos
 * antes disso recebem `undefined` (popup sem som — nunca fingir que toca),
 * e o ciclo arm/disarm sobrevive a desligar/ligar do módulo.
 *
 * Fakes de DOM/AudioContext — nada de jsdom: os listeners são registrados
 * manualmente e disparamos os gestos à mão.
 */

class FakeContext implements AudioContextLike {
	state: string;
	resumeCalls = 0;
	constructor(initialState = "suspended") {
		this.state = initialState;
	}
	async resume(): Promise<void> {
		this.resumeCalls += 1;
		this.state = "running";
	}
}

class FakeWindow implements GestureSource {
	private listeners = new Map<string, Set<() => void>>();
	addEventListener(type: string, listener: () => void, options?: { once?: boolean }): void {
		void options; // once é tratado pelo unlocker via disarm()
		let set = this.listeners.get(type);
		if (!set) {
			set = new Set();
			this.listeners.set(type, set);
		}
		set.add(listener);
	}
	removeEventListener(type: string, listener: () => void): void {
		this.listeners.get(type)?.delete(listener);
	}
	fire(type: string): void {
		for (const listener of [...(this.listeners.get(type) ?? [])]) listener();
	}
	listenerCount(): number {
		let n = 0;
		for (const set of this.listeners.values()) n += set.size;
		return n;
	}
}

describe("AudioUnlocker — destravamento por gesto", () => {
	it("antes de qualquer gesto: sem contexto tocável (getRunningContext = undefined)", () => {
		const win = new FakeWindow();
		const unlocker = new AudioUnlocker(() => new FakeContext(), win);
		unlocker.arm();
		expect(unlocker.isUnlocked()).toBe(false);
		expect(unlocker.getRunningContext()).toBeUndefined();
	});

	it("primeiro gesto (pointerdown): contexto criado, resume() chamado, tocável", async () => {
		const win = new FakeWindow();
		const ctx = new FakeContext();
		const unlocker = new AudioUnlocker(() => ctx, win);
		unlocker.arm();
		win.fire("pointerdown");
		await Promise.resolve(); // await do resume()
		expect(unlocker.isUnlocked()).toBe(true);
		expect(ctx.resumeCalls).toBe(1);
		expect(unlocker.getRunningContext()).toBeUndefined ?? undefined; // saneamento: linha seguinte é a real
		expect(unlocker.getRunningContext()).toBe(ctx);
	});

	it("keydown também destrava; o segundo gesto não recria nem re-resume", async () => {
		const win = new FakeWindow();
		const ctx = new FakeContext();
		const unlocker = new AudioUnlocker(() => ctx, win);
		unlocker.arm();
		win.fire("keydown");
		await Promise.resolve();
		win.fire("pointerdown");
		await Promise.resolve();
		expect(unlocker.isUnlocked()).toBe(true);
		expect(ctx.resumeCalls).toBe(1); // idempotente
	});

	it("contexto já running (ambiente sem política de autoplay): unlock não chama resume", async () => {
		const win = new FakeWindow();
		const ctx = new FakeContext("running");
		const unlocker = new AudioUnlocker(() => ctx, win);
		unlocker.arm();
		win.fire("pointerdown");
		await Promise.resolve();
		expect(ctx.resumeCalls).toBe(0);
		expect(unlocker.isUnlocked()).toBe(true);
	});

	it("resume() que falha (política adversa): unlocked continua false e o som é pulado, não quebra", async () => {
		const win = new FakeWindow();
		const ctx = new FakeContext();
		ctx.resume = async () => {
			ctx.resumeCalls += 1;
			throw new Error("NotAllowedError");
		};
		const unlocker = new AudioUnlocker(() => ctx, win);
		unlocker.arm();
		win.fire("pointerdown");
		await Promise.resolve();
		expect(unlocker.isUnlocked()).toBe(false);
		expect(unlocker.getRunningContext()).toBeUndefined();
	});

	it("unlock() direto (botão de teste = gesto garantido) destrava sem listener", async () => {
		const unlocker = new AudioUnlocker(() => new FakeContext());
		const ok = await unlocker.unlock();
		expect(ok).toBe(true);
		expect(unlocker.getRunningContext()).toBeDefined();
	});

	it("arm() depois de destravado é no-op (não re-registra listeners)", async () => {
		const win = new FakeWindow();
		const unlocker = new AudioUnlocker(() => new FakeContext(), win);
		unlocker.arm();
		win.fire("pointerdown");
		await Promise.resolve(); // o unlock() é async — listeners saem dentro dele
		// re-arm (ex.: religar módulo) — não deve acumular listeners:
		unlocker.arm();
		unlocker.arm();
		expect(win.listenerCount()).toBe(0);
	});
});

describe("AudioUnlocker — ciclo arm/disarm", () => {
	it("disarm() remove os listeners; contexto destravado sobrevive (religar módulo não re-trava)", async () => {
		const win = new FakeWindow();
		const ctx = new FakeContext();
		const unlocker = new AudioUnlocker(() => ctx, win);
		unlocker.arm();
		win.fire("pointerdown");
		await Promise.resolve();
		unlocker.disarm();
		expect(win.listenerCount()).toBe(0);
		// contexto continua tocável após o disarm:
		expect(unlocker.getRunningContext()).toBe(ctx);
	});

	it("desligar antes do primeiro gesto: listeners somem, destravado continua false", () => {
		const win = new FakeWindow();
		const unlocker = new AudioUnlocker(() => new FakeContext(), win);
		unlocker.arm();
		unlocker.disarm();
		expect(win.listenerCount()).toBe(0);
		expect(unlocker.isUnlocked()).toBe(false);
	});

	it("contexto fechado: getRunningContext devolve undefined (não toca em contexto morto)", async () => {
		const win = new FakeWindow();
		const ctx = new FakeContext();
		const unlocker = new AudioUnlocker(() => ctx, win);
		unlocker.arm();
		win.fire("pointerdown");
		await Promise.resolve();
		ctx.state = "closed";
		expect(unlocker.getRunningContext()).toBeUndefined();
	});
});
