import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventBus } from "../src/core/EventBus";

describe("EventBus", () => {
	// Timers FALSOS nos testes de throttle: janela e espera avançam juntas
	// (advanceTimersByTimeAsync) — com timers reais + sleeps fixos, a suíte
	// paralela podia dessincronizar as duas coisas e gerar flake.
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});
	it("entrega um evento para todos os inscritos", async () => {
		const bus = new EventBus();
		const received: unknown[] = [];
		bus.on("test:event", "mod-a", (e) => received.push(e.payload));
		bus.on("test:event", "mod-b", (e) => received.push(e.payload));

		await bus.emit("test:event", { value: 42 }, "mod-a");

		expect(received).toEqual([{ value: 42 }, { value: 42 }]);
	});

	it("isola falhas: um handler que lança erro não impede os outros de rodar", async () => {
		const bus = new EventBus();
		const calledOrder: string[] = [];

		bus.on("test:event", "mod-a", () => {
			calledOrder.push("a");
			throw new Error("boom");
		});
		bus.on("test:event", "mod-b", () => {
			calledOrder.push("b");
		});

		await bus.emit("test:event", {}, "mod-a");

		expect(calledOrder).toEqual(["a", "b"]);
	});

	it("offAll remove todas as inscrições de um módulo", async () => {
		const bus = new EventBus();
		const handler = vi.fn();
		bus.on("test:event", "mod-a", handler);
		bus.offAll("mod-a");

		await bus.emit("test:event", {}, "core");

		expect(handler).not.toHaveBeenCalled();
	});

	it("throttle AGRUPA emissões dentro da janela e entrega no fim dela (sem perder evento)", async () => {
		const bus = new EventBus();
		const received: unknown[] = [];
		bus.on("vault:modify", "mod-a", (e) => received.push(e.payload));
		bus.setThrottle("vault:modify", 20);

		await bus.emit("vault:modify", { n: 1 }, "mod-a"); // sai na hora
		await bus.emit("vault:modify", { n: 2 }, "mod-a"); // coalescida
		await bus.emit("vault:modify", { n: 3 }, "mod-a"); // coalescida

		// Imediato: só a 1ª emissão saiu (a janela não fechou ainda):
		expect(received).toEqual([{ n: 1 }]);

		// Fim da janela: as coalescidas chegam juntas como { coalesced: [...] }.
		await vi.advanceTimersByTimeAsync(20); // adianta até o fim da janela de 20ms
		expect(received).toEqual([
			{ n: 1 },
			{ coalesced: [{ n: 2 }, { n: 3 }] },
		]);
	});

	it("rajada de 200 emissões numa janela: NADA é perdido (todas chegam coalescidas)", async () => {
		const bus = new EventBus();
		const received: unknown[] = [];
		bus.on("file:created", "history", (e) => {
			const p = e.payload as { coalesced?: unknown[]; path?: string };
			if (p.coalesced) received.push(...p.coalesced);
			else received.push(p);
		});
		bus.setThrottle("file:created", 30);

		await bus.emit("file:created", { path: "n-0.md" }, "filelifecycle"); // sai na hora
		for (let i = 1; i < 200; i++) {
			await bus.emit("file:created", { path: `n-${i}.md` }, "filelifecycle");
		}
		await vi.advanceTimersByTimeAsync(30); // fim da janela de 30ms

		expect(received.length).toBe(200); // antes do coalescing: 1 (199 descartados)
		expect(received.some((p) => (p as { path: string }).path === "n-199.md")).toBe(true);
	});

	it("coalescing não vaza para a janela seguinte nem entre fontes distintas", async () => {
		const bus = new EventBus();
		const received: unknown[] = [];
		bus.on("demo", "mod-a", (e) => received.push(e.payload));
		bus.setThrottle("demo", 15);

		await bus.emit("demo", { n: 1 }, "mod-a");
		await bus.emit("demo", { n: 2 }, "mod-a"); // coalescida (mesma fonte)
		await bus.emit("demo", { n: 3 }, "mod-b"); // fonte diferente: NÃO é coalescida
		await vi.advanceTimersByTimeAsync(15); // fim da janela de 15ms

		expect(received).toEqual([
			{ n: 1 },
			{ n: 3 }, // fontes distintas nunca se misturam
			{ coalesced: [{ n: 2 }] },
		]);
	});

	it("mantém histórico consultável por nome e origem", async () => {
		const bus = new EventBus();
		await bus.emit("a", {}, "mod-a");
		await bus.emit("b", {}, "mod-b");

		expect(bus.getHistory({ eventName: "a" })).toHaveLength(1);
		expect(bus.getHistory({ source: "mod-b" })).toHaveLength(1);
		expect(bus.getHistory()).toHaveLength(2);
	});
});
