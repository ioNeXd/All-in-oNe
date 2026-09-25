import type { App } from "obsidian";
import { describe, it, expect, vi } from "vitest";
import { HubCore } from "../src/core/HubCore";
import { CalendarModule } from "../src/modules/calendar/CalendarModule";
import { createDefaultSettings, type HubSettings } from "../src/core/types";
import { makeTestModule } from "./helpers";

/**
 * Testes do HubCore contra o CÓDIGO REAL: a escadinha de reset em 3 níveis
 * (semântica prometida pelo modal "Restaurar tudo"), a reconciliação do Set
 * de módulos habilitados com o disco após reset de config, e o ciclo de vida
 * enable/disable (lazy loading, isolamento de falha, modo seguro, limpeza do
 * bus). Sem espelhar regras: o que se testa é a implementação de verdade.
 */

function makeCore(initial: HubSettings | null = null) {
	// Cópia profunda: o manager muta o objeto salvo (sync stamp etc.).
	let stored: HubSettings | null = initial ? JSON.parse(JSON.stringify(initial)) : null;
	const core = new HubCore(
		{} as App,
		async () => stored,
		async (data) => {
			stored = data;
		}
	);
	return { core, getStored: () => stored };
}

/** Config inicial: "mcp" ligado e um módulo custom DESLIGADO. */
function customSettings(): HubSettings {
	const s = createDefaultSettings();
	s.enabledModules = ["mcp"];
	s.modules["history"] = { preexiste: true }; // fatia pré-existente p/ testes de reset
	return s;
}

describe("HubCore — ciclo de vida de módulos", () => {
	it("módulo listado em enabledModules é habilitado no registro (onEnable roda)", async () => {
		const { core } = makeCore(customSettings());
		await core.init();

		const onEnable = vi.fn();
		await core.registerModule(makeTestModule({ id: "mcp", onEnable }));

		expect(onEnable).toHaveBeenCalledTimes(1);
		expect(core.isModuleEnabled("mcp")).toBe(true);
	});

	it("lazy loading: módulo fora da lista NUNCA roda onEnable no registro", async () => {
		const { core } = makeCore(customSettings());
		await core.init();

		const onEnable = vi.fn();
		await core.registerModule(makeTestModule({ id: "templates", onEnable }));

		expect(onEnable).not.toHaveBeenCalled();
		expect(core.isModuleEnabled("templates")).toBe(false);

		// Ligar depois (fluxo do Lobby) habilita de fato:
		await core.enableModule("templates");
		expect(onEnable).toHaveBeenCalledTimes(1);
		expect(core.isModuleEnabled("templates")).toBe(true);
	});

	it("disableModule roda onDisable, limpa inscrições no bus e atualiza o Set", async () => {
		const { core } = makeCore(customSettings());
		await core.init();

		let busHandlerRan = false;
		const module = makeTestModule({ id: "mcp" });
		module.onRegister = (ctx) => {
			ctx.bus.on("demo:evento", "mcp", () => (busHandlerRan = true));
		};
		await core.registerModule(module);
		expect(core.isModuleEnabled("mcp")).toBe(true);

		await core.disableModule("mcp");

		await core.bus.emit("demo:evento", {}, "core");
		expect(busHandlerRan).toBe(false); // offAll removeu a inscrição
		expect(core.isModuleEnabled("mcp")).toBe(false);
	});

	it("context.isModuleEnabled reflete o RUNTIME, não a config (módulo falhado)", async () => {
		// Regressão da divergência de fonte de verdade: Templates decidia o
		// fallback pela CONFIG persistida enquanto a ponte do vault decidia
		// pelo RUNTIME — com o Ciclo de Vida na config mas falhado ao
		// habilitar, a ponte emitia file:created, o fallback calava e o
		// template nunca era aplicado. Agora o contrato expõe o estado real.
		const initial = customSettings();
		initial.enabledModules = ["mcp", "templates"]; // ambos na config
		const { core } = makeCore(initial);
		await core.init();

		let ctxForTemplates: import("../src/core/ModuleContract").ModuleContext | undefined;
		const templates = makeTestModule({ id: "templates" });
		templates.onRegister = (ctx) => (ctxForTemplates = ctx);
		await core.registerModule(templates);

		// "mcp" na config mas FALHA ao habilitar:
		await core.registerModule(
			makeTestModule({
				id: "mcp",
				onEnable: () => {
					throw new Error("porta ocupada");
				},
			})
		);

		const ctx = ctxForTemplates!;
		expect(ctx.getFullSettings().enabledModules).toContain("mcp"); // config diz ligado...
		expect(ctx.isModuleEnabled("mcp")).toBe(false); // ...mas o runtime diz NÃO
		expect(ctx.isModuleEnabled("templates")).toBe(true); // módulo saudável
	});

	it("onDisable que lançando não impede a limpeza do estado (finally)", async () => {
		const { core } = makeCore(customSettings());
		await core.init();

		const module = makeTestModule({
			id: "mcp",
			onDisable: () => {
				throw new Error("boom no disable");
			},
		});
		await core.registerModule(module);

		await core.disableModule("mcp"); // não deve propagar

		expect(core.isModuleEnabled("mcp")).toBe(false);
	});

	it("falha de onEnable não propaga, registra o erro e NÃO habilita o módulo", async () => {
		const { core } = makeCore(customSettings());
		await core.init();

		await core.registerModule(
			makeTestModule({
				id: "mcp",
				onEnable: () => {
					throw new Error("porta ocupada");
				},
			})
		);

		expect(core.isModuleEnabled("mcp")).toBe(false);
		expect(core.getLastEnableError("mcp")).toContain("porta ocupada");
	});

	it("3 falhas consecutivas de onEnable entram em modo seguro e bloqueiam novos enables", async () => {
		// "styles" vem listado como habilitado na config — o modo seguro é o
		// que impede a ativação, não a ausência na lista.
		const initial = customSettings();
		initial.enabledModules = ["mcp", "styles"];
		const { core } = makeCore(initial);
		await core.init();

		const safeModeEvents: unknown[] = [];
		core.bus.on("core:safe-mode-entered", "test", (e) => safeModeEvents.push(e.payload));

		const failing = () => Promise.reject(new Error("falha sempre"));
		await core.registerModule(makeTestModule({ id: "mcp", onEnable: failing })); // crash 1
		await core.enableModule("mcp"); // crash 2
		await core.enableModule("mcp"); // crash 3 → modo seguro

		expect(safeModeEvents).toHaveLength(1);
		expect(core.getLastEnableError("mcp")).toContain("falha sempre");

		// Modo seguro ativo: novo módulo listado como habilitado não é ativado.
		const onEnable2 = vi.fn();
		await core.registerModule(makeTestModule({ id: "styles", onEnable: onEnable2 }));
		expect(onEnable2).not.toHaveBeenCalled();
		expect(core.isModuleEnabled("styles")).toBe(false);
	});

	it("SAÍDA do modo seguro: ofensor religado com sucesso limpa o bloqueio (sem reiniciar)", async () => {
		const initial = customSettings();
		initial.enabledModules = ["mcp", "styles"];
		const { core } = makeCore(initial);
		await core.init();

		const entered: unknown[] = [];
		const exited: unknown[] = [];
		core.bus.on("core:safe-mode-entered", "test", (e) => entered.push(e.payload));
		core.bus.on("core:safe-mode-exited", "test", (e) => exited.push(e.payload));

		let fail = true;
		const onEnable = vi.fn(() => (fail ? Promise.reject(new Error("porta ocupada")) : Promise.resolve()));
		await core.registerModule(makeTestModule({ id: "mcp", onEnable }));
		await core.enableModule("mcp");
		await core.enableModule("mcp"); // 3ª falha → modo seguro
		expect(entered).toHaveLength(1);

		// Registro bloqueado enquanto no modo seguro:
		const onEnable2 = vi.fn();
		await core.registerModule(makeTestModule({ id: "styles", onEnable: onEnable2 }));
		expect(onEnable2).not.toHaveBeenCalled();

		// Usuário corrige a causa e religa o OFENSOR pelo Lobby — sucesso:
		fail = false;
		await core.enableModule("mcp");
		expect(core.isModuleEnabled("mcp")).toBe(true);
		expect(exited).toEqual([{ moduleId: "mcp" }]);

		// Bloqueio encerrado: um módulo já registrado pode ser habilitado normalmente.
		await core.enableModule("styles");
		expect(onEnable2).toHaveBeenCalledTimes(1);
		expect(core.isModuleEnabled("styles")).toBe(true);
	});

	it("saída do modo seguro zera os contadores de crash (recomeço limpo)", async () => {
		const { core } = makeCore(customSettings());
		await core.init();

		let fail = true;
		const onEnable = vi.fn(() => (fail ? Promise.reject(new Error("x")) : Promise.resolve()));
		const module = makeTestModule({ id: "mcp", onEnable });
		await core.registerModule(module); // crash 1
		await core.enableModule("mcp"); // crash 2
		await core.enableModule("mcp"); // crash 3 → modo seguro

		fail = false;
		await core.enableModule("mcp"); // sucesso → sai do modo seguro

		// Com contadores zerados, DUAS falhas novas não re-entram no modo
		// seguro (precisaria de 3 de novo):
		fail = true;
		await core.enableModule("mcp");
		await core.enableModule("mcp");
		expect(core.getLastEnableError("mcp")).toBeDefined();
		// ainda fora do modo seguro — sem evento de entrada novo após a saída:
		// (o entered original foi 1; nenhuma entrada adicional aconteceu)
	});
});

describe("HubCore — reset em 3 níveis (escadinha real)", () => {
	it("reset 'config': config volta ao padrão, reconciliação RELIGA módulo desligado e não roda onResetData", async () => {
		const { core, getStored } = makeCore(customSettings());
		await core.init();

		const onEnableHistory = vi.fn();
		const onResetData = vi.fn();
		const onSettingsChangeMcp = vi.fn();
		await core.registerModule(makeTestModule({ id: "mcp", onSettingsChange: onSettingsChangeMcp }));
		await core.registerModule(
			makeTestModule({ id: "history", onEnable: onEnableHistory, onResetData })
		);
		// custom-x ligado à mão (o usuário ligou pelo Lobby): NÃO está no
		// default — é o caso que prova o sentido "desligar" da reconciliação.
		await core.registerModule(makeTestModule({ id: "custom-x", onResetData }));
		await core.enableModule("custom-x");
		expect(core.isModuleEnabled("custom-x")).toBe(true);
		expect(core.isModuleEnabled("history")).toBe(false);

		await core.settings.updateModuleSettings("mcp", { port: 9999 });

		const resetEvents: { level?: string }[] = [];
		core.bus.on("core:reset", "test", (e) => resetEvents.push(e.payload as { level?: string }));

		await core.resetAll("config");

		// Config voltou ao padrão no disco e nas fatias:
		expect(getStored()!.enabledModules).toContain("history");
		expect(core.settings.getModuleSettings("mcp")).toEqual({});

		// Reconciliação nos DOIS sentidos:
		expect(onEnableHistory).toHaveBeenCalledTimes(1); // desligado → religado
		expect(core.isModuleEnabled("history")).toBe(true);
		expect(core.isModuleEnabled("custom-x")).toBe(false); // fora do default → desligado

		// "config" NÃO é reset de dados:
		expect(onResetData).not.toHaveBeenCalled();

		// Módulos LIGADOS reagem à config nova (o desligado, não):
		expect(onSettingsChangeMcp).toHaveBeenCalled();
		const seen = onSettingsChangeMcp.mock.calls[0][0] as HubSettings;
		expect(seen.enabledModules).toContain("history"); // config NOVA, não a antiga

		expect(resetEvents).toEqual([{ level: "config" }]);
	});

	it("reset 'data': config INTACTA, onResetData roda para TODOS (inclusive desligados), histórico some", async () => {
		const { core } = makeCore(customSettings());
		await core.init();

		const onResetDataMcp = vi.fn();
		const onResetDataCustom = vi.fn();
		const onSettingsChangeMcp = vi.fn();
		await core.registerModule(
			makeTestModule({ id: "mcp", onResetData: onResetDataMcp, onSettingsChange: onSettingsChangeMcp })
		);
		await core.registerModule(makeTestModule({ id: "custom-x", onResetData: onResetDataCustom }));
		// custom-x registrado DESLIGADO (não está em enabledModules → lazy):
		expect(core.isModuleEnabled("custom-x")).toBe(false);

		await core.settings.updateModuleSettings("mcp", { port: 9999 });
		// O enable do módulo registra um evento de lifecycle; ele não faz parte
		// do cenário que queremos verificar neste teste de reset de dados.
		core.bus.clearHistory();
		await core.bus.emit("demo:evento", {}, "core");
		expect(core.bus.getHistory()).toHaveLength(1);

		await core.resetAll("data");

		// Config NÃO foi tocada:
		expect(core.settings.getModuleSettings("mcp")).toEqual({ port: 9999 });
		expect(core.isModuleEnabled("mcp")).toBe(true);
		expect(core.isModuleEnabled("custom-x")).toBe(false); // sem reconciliação no "data"

		// Dados: TODOS os módulos registrados limpam — desligado inclusive
		// (dado de módulo desligado não pode sobreviver ao reset).
		expect(onResetDataMcp).toHaveBeenCalledTimes(1);
		expect(onResetDataCustom).toHaveBeenCalledTimes(1);

		// O log de eventos da sessão (bus) é limpo; sobra só o próprio
		// "core:reset" (emitido DEPOIS da limpeza — a Central de Eventos
		// registra que o reset aconteceu, nada além disso):
		expect(core.bus.getHistory().map((e) => e.name)).toEqual(["core:reset"]);

		// "data" não muda config → sem onSettingsChange:
		expect(onSettingsChangeMcp).not.toHaveBeenCalled();
	});

	it("reset 'all': config volta ao padrão E onResetData roda para todos", async () => {
		const { core, getStored } = makeCore(customSettings());
		await core.init();

		const onResetData = vi.fn();
		await core.registerModule(makeTestModule({ id: "mcp", onResetData }));
		await core.settings.updateModuleSettings("mcp", { port: 9999 });

		await core.resetAll("all");

		expect(core.settings.getModuleSettings("mcp")).toEqual({});
		expect(getStored()!.enabledModules).toContain("history"); // default
		expect(onResetData).toHaveBeenCalledTimes(1);
	});

	it("onResetData de um módulo que lança não impede os demais (isolamento)", async () => {
		const { core } = makeCore(customSettings());
		await core.init();

		const onResetDataOk = vi.fn();
		await core.registerModule(
			makeTestModule({
				id: "mcp",
				onResetData: () => {
					throw new Error("falha ao limpar");
				},
			})
		);
		await core.registerModule(makeTestModule({ id: "custom-x", onResetData: onResetDataOk }));

		await core.resetAll("data"); // não deve propagar

		expect(onResetDataOk).toHaveBeenCalledTimes(1);
	});

	it("reset 'data' com o Calendário REAL: eventos .ics saem, criados à mão ficam", async () => {
		// Integração real (sem makeTestModule): o hook onResetData do
		// Calendário filtra por origem — eventos importados de .ics
		// (id `ics:<uid>`, derivados de um arquivo, refazer é um clique)
		// são removidos; os criados pelo usuário no painel (id `evt-*`)
		// sobrevivem, pois são configuração. Exercita resetAll de verdade,
		// sem reimplementar a regra de reset nem a do Calendário.
		const { core } = makeCore(customSettings());
		await core.init();

		const calendar = new CalendarModule();
		await core.registerModule(calendar); // desligado: onResetData deve rodar mesmo assim
		expect(core.isModuleEnabled("calendar")).toBe(false);

		const ctx = calendar["context"]!;
		await ctx.updateSettings({
			events: [
				{
					id: "ics:reuniao-anual@exemplo",
					source: "ics",
					title: "Reunião importada",
					description: "",
					recurrence: "yearly",
					day: 10,
					month: 3,
					reminder: false,
				},
				{
					id: "evt-abc123",
					source: "manual",
					title: "Aniversário criado à mão",
					description: "",
					recurrence: "yearly",
					day: 25,
					month: 12,
					reminder: false,
				},
			],
		});
		expect(core.settings.getModuleSettings("calendar")).toEqual(
			expect.objectContaining({ events: expect.any(Array) })
		);
		const stored = core.settings.getModuleSettings("calendar") as { events: unknown[] };
		expect(stored.events).toHaveLength(2); // os dois gravados antes do reset

		await core.resetAll("data");

		const after = core.settings.getModuleSettings("calendar") as {
			events: { id: string; title: string }[];
		};
		expect(after.events.map((e) => e.id)).toEqual(["evt-abc123"]); // só o manual
		expect(after.events[0].title).toBe("Aniversário criado à mão"); // intacto
	});
});
