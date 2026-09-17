import { describe, it, expect } from "vitest";
import { SettingsManager } from "../src/core/SettingsManager";
import { createDefaultSettings } from "../src/core/types";

function makeManager(initial: unknown = null) {
	let stored = initial;
	const load = async () => stored as any;
	const persist = async (data: any) => {
		stored = data;
	};
	return { manager: new SettingsManager(load, persist), getStored: () => stored };
}

describe("SettingsManager", () => {
	it("cria configuração padrão quando não há nada salvo", async () => {
		const { manager } = makeManager(null);
		const settings = await manager.init();
		expect(settings.schemaVersion).toBe(1);
		expect(settings.enabledModules).toContain("mcp");
	});

	it("detecta conflito de caminho entre dois módulos apontando para a mesma pasta", async () => {
		const { manager } = makeManager(null);
		await manager.init();

		const next = createDefaultSettings();
		next.paths.calendarFolder = "Estudos";
		next.paths.calendarTemplatesFolder = "estudos"; // mesmo caminho, case diferente

		const issues = manager.validate(next);
		expect(issues.some((i) => i.level === "error")).toBe(true);
	});

	it("não acusa conflito quando os caminhos são diferentes", async () => {
		const { manager } = makeManager(null);
		await manager.init();

		const next = createDefaultSettings();
		next.paths.calendarFolder = "Calendar";
		next.paths.calendarTemplatesFolder = "templates-calendario";

		const issues = manager.validate(next);
		expect(issues).toHaveLength(0);
	});

	it("reset 'config' volta para o padrão sem afetar histórico externo (fora do escopo do manager)", async () => {
		const { manager, getStored } = makeManager(null);
		await manager.init();
		await manager.updateModuleSettings("mcp", { port: 9999 });

		await manager.reset();

		expect(manager.getModuleSettings("mcp")).toEqual({});
		expect((getStored() as any).schemaVersion).toBe(1);
	});

	it("reset 'config' zera fatias de módulo E caminhos globais", async () => {
		const { manager } = makeManager(null);
		await manager.init();
		await manager.updateModuleSettings("history", { maxEntries: 42 });

		await manager.reset();

		expect(manager.getModuleSettings("history")).toEqual({});
		expect(manager.get().paths.calendarFolder).toBe("Calendario"); // voltou ao default
	});

	it("reset 'all' também zera configuração (dados são zerados via hook, no HubCore)", async () => {
		const { manager } = makeManager(null);
		await manager.init();
		await manager.updateModuleSettings("history", { maxEntries: 42 });

		await manager.reset();

		expect(manager.getModuleSettings("history")).toEqual({});
	});

	it("gravações concorrentes de módulos diferentes chegam TODAS ao disco (sem lost update)", async () => {
		// Regressão do hazard de persist fora de ordem: dois eventos quase
		// simultâneos (Histórico e Notificações disparam updateSettings a cada
		// evento) com persist de latência variável faziam o disco terminar com
		// a versão ANTIGA — o patch mais novo era sobrescrito pelo persist
		// lento do save anterior e a perda só aparecia ao reiniciar o Obsidian.
		let stored: unknown = null;
		let first = true;
		const persist = async (data: unknown) => {
			// 1º persist lento, demais rápidos — a ordem de TÉRMINO fica
			// invertida em relação à ordem de chamada.
			const slow = first;
			first = false;
			await new Promise((r) => setTimeout(r, slow ? 50 : 5));
			stored = data;
		};
		const manager = new SettingsManager(async () => null, persist);
		await manager.init();
		await manager.updateModuleSettings("mcp", { port: 1111 }); // consome o persist lento

		await Promise.all([
			manager.updateModuleSettings("history", { max: 1 }),
			manager.updateModuleSettings("notifications", { enabled: true }),
		]);

		// A memória sempre teve os dois; o DISCO é que perdia o segundo:
		const disk = (stored as { modules: Record<string, Record<string, unknown>> }).modules;
		expect(disk["history"]).toEqual({ max: 1 });
		expect(disk["notifications"]).toEqual({ enabled: true });
		expect(manager.getModuleSettings("history")).toEqual({ max: 1 });
	});

	it("falha de persist não trava a fila: a gravação seguinte chega ao disco", async () => {
		let stored: unknown = null;
		let failNext = false;
		const persist = async (data: unknown) => {
			if (failNext) {
				failNext = false;
				throw new Error("disco cheio");
			}
			stored = data;
		};
		const manager = new SettingsManager(async () => null, persist);
		await manager.init();

		failNext = true;
		// A falha PROPAGA ao chamador (contrato pré-existente — quem chamou
		// precisa saber que não foi gravado), mas não envenena a fila:
		await expect(manager.updateModuleSettings("history", { max: 1 })).rejects.toThrow("disco cheio");

		await manager.updateModuleSettings("history", { max: 2 }); // tem que funcionar
		expect((stored as { modules: Record<string, Record<string, unknown>> }).modules["history"]).toEqual({ max: 2 });
	});
});
