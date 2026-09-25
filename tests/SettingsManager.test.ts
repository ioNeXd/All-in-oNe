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
		expect(settings.schemaVersion).toBe(3);
		expect(settings.enabledModules).toContain("mcp");
		// Perfis foram removidos do schema (nunca tiveram implementação):
		expect(settings).not.toHaveProperty("profiles");
		expect(settings).not.toHaveProperty("activeProfileId");
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
		expect((getStored() as any).schemaVersion).toBe(3);
	});

	it("reset 'config' zera fatias de módulo E caminhos globais", async () => {
		const { manager } = makeManager(null);
		await manager.init();
		await manager.updateModuleSettings("history", { maxEntries: 42 });

		await manager.reset();

		expect(manager.getModuleSettings("history")).toEqual({});
		expect(manager.get().paths.calendarFolder).toBe("01 - Calendario"); // voltou ao default
	});

	it("reset 'all' também zera configuração (dados são zerados via hook, no HubCore)", async () => {
		const { manager } = makeManager(null);
		await manager.init();
		await manager.updateModuleSettings("history", { maxEntries: 42 });

		await manager.reset();

		expect(manager.getModuleSettings("history")).toEqual({});
	});

	it("MIGRAÇÃO v1→v3: descarta perfis mortos e PRESERVA a configuração real", async () => {
		// data.json de quem usou versões antigas: schema v1, com os campos de
		// perfil que nunca tiveram leitor — e configuração REAL que não pode
		// se perder na remoção.
		const oldSettings = {
			schemaVersion: 1,
			onboardingCompleted: true,
			activeProfileId: "trabalho",
			profiles: [
				{ id: "default", name: "Padrão", modules: {} },
				{ id: "trabalho", name: "Trabalho", modules: { mcp: { port: 1234 } } },
			],
			modules: { mcp: { port: 27931, readOnly: true }, history: { maxEntries: 500 } },
			enabledModules: ["mcp"],
			lobby: { openMode: "tab", theme: "custom" },
			paths: { calendarFolder: "Agenda", calendarTemplatesFolder: "Agenda/tpl" },
			sync: { lastWrittenBy: "abc", lastWrittenAt: 1000 },
			telemetry: { enabled: false },
		};
		const { manager, getStored } = makeManager(oldSettings);

		const settings = await manager.init();

		// Migrou para v3 e os campos mortos sumiram:
		expect(settings.schemaVersion).toBe(3);
		expect(settings).not.toHaveProperty("activeProfileId");
		expect(settings).not.toHaveProperty("profiles");
		// A configuração REAL ficou intacta:
		expect(manager.getModuleSettings("mcp")).toEqual({ port: 27931, readOnly: true });
		expect(manager.getModuleSettings("history")).toEqual({ maxEntries: 500 });
		expect(settings.enabledModules).toEqual(["mcp"]);
		expect(settings.paths.calendarFolder).toBe("Agenda");
		expect(settings.onboardingCompleted).toBe(true);

		// Persistiu a versão migrada (o disco também fica limpo no próximo save):
		const stored = getStored() as { schemaVersion: number; profiles?: unknown };
		expect(stored.schemaVersion).toBe(3);
		expect(stored).not.toHaveProperty("profiles");
	});

	it("MIGRAÇÃO v3 é idempotente: rodar sobre v3 não re-migra nem recria campos", async () => {
		const { manager } = makeManager(createDefaultSettings());
		const settings = await manager.init();
		expect(settings.schemaVersion).toBe(3);
		expect(manager.get().schemaVersion).toBe(3);
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


describe("defaults e sincronização de caminhos derivados", () => {
	it("usa os novos caminhos padrão", () => {
		const { manager } = makeManager(null);
		expect(manager.get().paths.calendarFolder).toBe("01 - Calendario");
		expect(manager.get().paths.calendarTemplatesFolder).toBe("99 - Sistema/Templates/Calendário");
	});

	it("migra os caminhos antigos do schema v2 para os novos defaults", async () => {
		const oldSettings = {
			schemaVersion: 2,
			onboardingCompleted: true,
			modules: {},
			enabledModules: [],
			lobby: { openMode: "tab", theme: "custom" },
			paths: { calendarFolder: "Calendario", calendarTemplatesFolder: "Calendario/templates" },
			sync: { lastWrittenBy: "abc", lastWrittenAt: 1000 },
			telemetry: { enabled: false },
		};
		const { manager, getStored } = makeManager(oldSettings);
		const settings = await manager.init();
		expect(settings.schemaVersion).toBe(3);
		expect(settings.paths.calendarFolder).toBe("01 - Calendario");
		expect(settings.paths.calendarTemplatesFolder).toBe("99 - Sistema/Templates/Calendário");
		expect((getStored() as { schemaVersion: number }).schemaVersion).toBe(3);
	});

	it("valida conflitos depois de sincronizar caminhos derivados", async () => {
		const { manager } = makeManager(null);
		await manager.init();

		const next = createDefaultSettings();
		next.paths.systemFolder = "Sistema-Novo";
		next.paths.calendarFolder = "Sistema-Novo/Templates/Calendário";

		const issues = await manager.save(next);
		expect(issues.some((i) => i.level === "error")).toBe(true);
		expect(manager.get().paths.systemFolder).toBe("99 - Sistema");
		expect(manager.get().paths.calendarFolder).toBe("01 - Calendario");
	});

	it("acompanha templates e arquivos quando o sistema muda, sem sobrescrever customização", async () => {
		const { manager } = makeManager(null);
		await manager.init();
		const next = createDefaultSettings();
		next.paths.systemFolder = "Sistema-Novo";
		await manager.save(next);
		expect(manager.get().paths.calendarTemplatesFolder).toBe("Sistema-Novo/Templates/Calendário");
		expect(manager.get().paths.filesFolder).toBe("Sistema-Novo/arquivos");

		const custom = { ...manager.get(), paths: { ...manager.get().paths, calendarTemplatesFolder: "Templates-Custom" } };
		custom.paths.systemFolder = "Sistema-Final";
		await manager.save(custom);
		expect(manager.get().paths.calendarTemplatesFolder).toBe("Templates-Custom");
		expect(manager.get().paths.filesFolder).toBe("Sistema-Final/arquivos");
	});
});
