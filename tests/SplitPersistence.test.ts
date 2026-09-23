import { describe, it, expect } from "vitest";
import {
	createSplitPersistence,
	stubSlices,
	moduleFilePath,
	SPLIT_MODULE_IDS,
} from "../src/core/SplitPersistence";
import { SettingsManager } from "../src/core/SettingsManager";
import { createDefaultSettings, type HubSettings } from "../src/core/types";

/**
 * PERSISTÊNCIA SPLIT — o motivo de existir: o write-behind do Histórico e
 * das Notificações regravava o data.json INTEIRO a cada ~2s. Aqui a fatia
 * de cada módulo splitado vai para arquivo próprio e o principal só é
 * tocado quando o resto da config muda.
 */

/** Store em memória com contagem de gravações por caminho. */
function makeStore(initial: Record<string, unknown> = {}) {
	const files = new Map<string, unknown>(Object.entries(initial));
	const writes: string[] = [];
	const adapter = {
		exists: async (p: string) => files.has(p),
		read: async (p: string) => files.get(p) as string,
		write: async (p: string, data: string) => {
			writes.push(p);
			files.set(p, data);
		},
		mkdir: async () => {},
	};
	const app = { vault: { adapter } } as never;
	const handle = createSplitPersistence(app, ".obsidian/plugins/All-in-oNe");
	return { handle, writes, files, countWrites: (p: string) => writes.filter((w) => w.includes(p)).length };
}

function makeSettings(): HubSettings {
	return createDefaultSettings();
}

describe("SplitPersistence — layout e stubs", () => {
	it("caminho do arquivo por módulo", () => {
		expect(moduleFilePath("history")).toBe("data.modules/history.json");
	});

	it("stubSlices zera as fatias splitadas e preserva as outras", () => {
		const s = makeSettings();
		s.modules["history"] = { entries: [1, 2, 3] };
		s.modules["mcp"] = { port: 27931 };
		const stubbed = stubSlices(s, SPLIT_MODULE_IDS);
		expect(stubbed.modules["history"]).toEqual({});
		expect(stubbed.modules["notifications"]).toEqual({});
		expect(stubbed.modules["mcp"]).toEqual({ port: 27931 }); // não-splitado: intacto
	});
});

describe("SplitPersistence — gravação direcionada via SettingsManager", () => {
	function makeManagerWithSplit() {
		const store = makeStore();
		const manager = new SettingsManager(
			async () => store.handle.loadMain(),
			async () => {} // persist monolítico NÃO deve ser chamado com split
		);
		manager.setSplitPersistence(store.handle);
		return { manager, store };
	}

	it("updateModuleSettings do Histórico grava SÓ o arquivo do Histórico", async () => {
		const { manager, store } = makeManagerWithSplit();
		await manager.init();

		store.writes.length = 0;
		await manager.updateModuleSettings("history", { maxEntries: 500 });

		expect(store.countWrites("history.json")).toBe(1);
		expect(store.countWrites("data.json")).toBe(0); // principal INTEIRO
		expect(store.countWrites("notifications.json")).toBe(0);
	});

	it("mudança fora das fatias (Lobby/paths) grava SÓ o data.json principal", async () => {
		const { manager, store } = makeManagerWithSplit();
		await manager.init();

		store.writes.length = 0;
		const next = { ...manager.get(), onboardingCompleted: true };
		await manager.save(next);

		expect(store.countWrites("data.json")).toBe(1);
		expect(store.countWrites("history.json")).toBe(0);
		expect(store.countWrites("notifications.json")).toBe(0);
	});

	it("flush repetido com a MESMA fatia não regrava nada (diff, nãoTimer)", async () => {
		const { manager, store } = makeManagerWithSplit();
		await manager.init();
		await manager.updateModuleSettings("history", { maxEntries: 42 });
		store.writes.length = 0;

		// Re-salvar a config com a fatia do Histórico IDÊNTICA (ex.: outro
		// módulo gravou algo): nada de history.json de novo.
		const next = JSON.parse(JSON.stringify(manager.get())) as HubSettings;
		next.sync = { lastWrittenBy: "outro", lastWrittenAt: 999 };
		await manager.save(next);

		expect(store.countWrites("history.json")).toBe(0);
	});

	it("loadMain reconstitui as fatias dos arquivos por módulo (merge transparente)", async () => {
		const { manager, store } = makeManagerWithSplit();
		await manager.init();
		await manager.updateModuleSettings("history", { maxEntries: 77 });
		await manager.updateModuleSettings("notifications", { doNotDisturb: true });

		// Um load NOVO (reboot do Obsidian) lê o principal + as fatias:
		const { manager: manager2 } = (() => {
			const m = new SettingsManager(
				async () => store.handle.loadMain(),
				async () => {}
			);
			m.setSplitPersistence(store.handle);
			return { manager: m };
		})();
		const settings = await manager2.init();
		expect(manager2.getModuleSettings("history")).toEqual({ maxEntries: 77 });
		expect(manager2.getModuleSettings("notifications")).toEqual({ doNotDisturb: true });
		expect(settings.paths.calendarFolder).toBe("Calendario"); // resto do principal
	});
});

describe("SplitPersistence — compatibilidade", () => {
	it("data.json gravado contém stubs (legível por versão antiga)", async () => {
		const store = makeStore();
		const settings = makeSettings();
		settings.modules["history"] = { entries: [{ id: "a" }] };
		await store.handle.persistMain(settings);

		const raw = JSON.parse(store.files.get(".obsidian/plugins/All-in-oNe/data.json") as string) as {
			modules: Record<string, unknown>;
		};
		expect(raw.modules["history"]).toEqual({}); // stub
		// Fatia NÃO-splitada continua no principal (mcp entra quando o módulo salva settings):
		settings.modules["mcp"] = { port: 27931 };
		await store.handle.persistMain(settings);
		const raw2 = JSON.parse(store.files.get(".obsidian/plugins/All-in-oNe/data.json") as string) as {
			modules: Record<string, unknown>;
		};
		expect(raw2.modules["mcp"]).toEqual({ port: 27931 }); // intacta
	});
});
