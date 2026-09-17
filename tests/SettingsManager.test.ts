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

		await manager.reset("config");

		expect(manager.getModuleSettings("mcp")).toEqual({});
		expect((getStored() as any).schemaVersion).toBe(1);
	});
});
