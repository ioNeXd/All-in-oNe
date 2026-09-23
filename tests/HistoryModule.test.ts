import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
	HistoryModule,
	HISTORY_DEFAULTS,
	type HistoryEntryRecord,
} from "../src/modules/history/HistoryModule";
import {
	filterHistoryEntries,
	normalizeSearchText,
	parseSearchQuery,
} from "../src/modules/history/HistoryFilter";
import type { ModuleContext } from "../src/core/ModuleContract";
import type { EventBus } from "../src/core/EventBus";
import type { HubSettings } from "../src/core/types";

/**
 * Testes do módulo de Histórico contra o CÓDIGO REAL — foco no write-behind
 * (itens 3 e 19 da revisão): acumular em memória, drenar num único save e a
 * garantia de LEITURA FRESCA — a leitura lógica (contagem do diagnóstico,
 * painel) inclui as pendentes na hora, sem esperar a janela de flush de 2s
 * (mesmo contrato do NotificationsModule.readSettings, com dedupe por id).
 */

const FLUSH_INTERVAL_MS = 2000;

interface SetupOptions {
	entries?: HistoryEntryRecord[];
	maxEntries?: number;
	/** updateSettings só resolve quando a gate correspondente for liberada. */
	gatedSave?: boolean;
}

function makeEntry(over: Partial<HistoryEntryRecord> = {}): HistoryEntryRecord {
	return {
		id: over.id ?? `old-${Math.random().toString(36).slice(2, 9)}`,
		event: over.event ?? "file:created",
		origin: over.origin ?? "filelifecycle",
		path: over.path,
		message: over.message ?? "entrada persistida",
		timestamp: over.timestamp ?? Date.now(),
	};
}

function setup(opts: SetupOptions = {}) {
	const module = new HistoryModule();
	const slice = {
		entries: opts.entries ?? [],
		maxEntries: opts.maxEntries ?? HISTORY_DEFAULTS.maxEntries,
		mutedEvents: [...HISTORY_DEFAULTS.mutedEvents],
	};

	// Stub do bus: captura os handlers inscritos (para "emitir" eventos
	// chamando o handler direto, como o bus real faria) e devolve um
	// unsubscribe espião para cada inscrição.
	const unsubscribers: Array<ReturnType<typeof vi.fn>> = [];
	const handlers = new Map<string, (e: { payload: unknown; source: string }) => void>();
	const bus = {
		on: vi.fn(
			(eventName: string, _moduleId: string, handler: (e: { payload: unknown; source: string }) => void) => {
				handlers.set(eventName, handler);
				const unsub = vi.fn();
				unsubscribers.push(unsub);
				return unsub;
			}
		),
	} as unknown as EventBus;

	const gates: Array<() => void> = [];
	const updateSettings = vi.fn(async (patch: Record<string, unknown>) => {
		if (Array.isArray(patch.entries)) slice.entries = structuredClone(patch.entries);
		// Gate prende só o save do BATCH (não-vazio) — o { entries: [] } do
		// reset/revert resolve na hora, senão o próprio teste colaria nele:
		if (opts.gatedSave && Array.isArray(patch.entries) && patch.entries.length > 0) {
			return new Promise<never[]>((resolve) => gates.push(() => resolve([])));
		}
		return [];
	});

	const context: ModuleContext = {
		app: {} as never,
		bus,
		getSettings: <T>() => JSON.parse(JSON.stringify(slice)) as T,
		updateSettings,
		getFullSettings: () => ({ modules: { history: slice } }) as unknown as HubSettings,
		isModuleEnabled: () => true,
		log: () => {},
		registerCommand: () => {},
		fileWriteQueueRun: async (_path: string, op: () => Promise<unknown>) => op(),
		updatePaths: async () => [],
	};

	module.onRegister(context);

	const emit = (eventName: string, payload: unknown, source = "filelifecycle") =>
		handlers.get(eventName)?.({ payload, source });

	return { module, slice, unsubscribers, updateSettings, gates, emit };
}

describe("HistoryModule — write-behind e leitura fresca", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("onEnable inscreve todos os eventos rastreados; onDisable chama cada unsubscribe", () => {
		const { module, unsubscribers } = setup();
		module.onEnable();
		expect(unsubscribers.length).toBe(19); // TRACKED_EVENTS.length (mcp:action saiu — duplicava cada ação do MCP)

		module.onDisable();
		expect(unsubscribers.every((u) => u.mock.calls.length === 1)).toBe(true);
	});

	it("record acumula em memória e o flush único leva tudo ao disco num só save", async () => {
		const { module, emit, updateSettings, slice } = setup();
		module.onEnable();

		for (let i = 0; i < 5; i++) emit("file:created", { path: `nota-${i}.md` });

		// Dentro da janela: NADA foi persistido (é o write-behind):
		expect(updateSettings).not.toHaveBeenCalled();
		expect(slice.entries).toEqual([]);

		await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);

		expect(updateSettings).toHaveBeenCalledTimes(1); // UM save, não 5
		expect(slice.entries).toHaveLength(5);
		expect(slice.entries[0].path).toBe("nota-4.md"); // mais recente primeiro
		// Flush moveu as pendentes para o disco: leitura lógica continua 5
		// (sem duplicar — pendentes esvaziadas):
		expect(module.getHealthStatus().summary).toContain("5 entrada");
	});

	it("LEITURA FRESCA: pendente aparece na contagem ANTES do flush (item 19)", async () => {
		const { module, emit } = setup();
		module.onEnable();

		emit("file:created", { path: "recente.md" });

		// Antes da correção do readSettings, a contagem dizia "0 entrada(s)"
		// até o flush de 2s rodar — o diagnóstico/painel ficavam defasados:
		expect(module.getHealthStatus().summary).toContain("1 entrada");
	});

	it("flush mescla pendentes + persistidas respeitando maxEntries (pendentes primeiro)", async () => {
		const persisted = Array.from({ length: 499 }, (_, i) => makeEntry({ id: `old-${i}` }));
		const { module, emit, updateSettings, slice } = setup({ entries: persisted });
		module.onEnable();

		emit("file:created", { path: "nova.md" });
		await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);

		expect(updateSettings).toHaveBeenCalledTimes(1);
		expect(slice.entries).toHaveLength(500); // teto de maxEntries
		expect(slice.entries[0].path).toBe("nova.md"); // pendente na frente
	});

	it("evento mudo não gera pendentes nem flush", async () => {
		const { module, emit, updateSettings } = setup();
		module.onEnable();

		emit("file:modified", { path: "x.md" }); // mudo por padrão (HISTORY_DEFAULTS)
		await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS + 500);

		expect(updateSettings).not.toHaveBeenCalled();
	});

	it("reset durante o save em voo não ressuscita entradas (guarda de geração)", async () => {
		const { module, emit, updateSettings, slice, gates } = setup({ gatedSave: true });
		module.onEnable();

		emit("file:created", { path: "a.md" });
		emit("file:created", { path: "b.md" });
		await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS); // flush dispara e fica preso no save
		expect(updateSettings).toHaveBeenCalledTimes(1);

		await module.onResetData(); // limpa a fatia e invalida a geração
		expect(slice.entries).toEqual([]);
		expect(updateSettings).toHaveBeenCalledTimes(2);

		gates[0](); // libera o save atrasado (as 2 entradas antigas)
		await vi.advanceTimersByTimeAsync(0); // microtasks: flush detecta a geração nova e desfaz

		expect(slice.entries).toEqual([]); // UNDONE — nada ressuscitado
		expect(updateSettings).toHaveBeenCalledTimes(3); // batch, reset e revert
	});
});

describe("HistoryFilter — busca por texto combinada com o filtro de tipo", () => {
	const entries: HistoryEntryRecord[] = [
		makeEntry({ id: "a", event: "file:created", path: "Projetos/Reunião.md", message: "Arquivo criado: Projetos/Reunião.md" }),
		makeEntry({ id: "b", event: "file:deleted", path: "Projetos/rascunho.md", message: "Arquivo excluído: Projetos/rascunho.md" }),
		makeEntry({ id: "c", event: "mcp:action", message: "MCP executou \"write_note\" em Projetos/Reunião.md" }),
		makeEntry({ id: "d", event: "file:created", path: "Diário/2026-09-22.md", message: "Arquivo criado: Diário/2026-09-22.md" }),
	];

	it("busca por substring do message, case-insensitive", () => {
		const result = filterHistoryEntries(entries, "", "EXECUTOU");
		expect(result.map((e) => e.id)).toEqual(["c"]);
	});

	it("busca por substring do path", () => {
		const result = filterHistoryEntries(entries, "", "rascunho");
		expect(result.map((e) => e.id)).toEqual(["b"]);
	});

	it("busca ignora acentos: 'reuniao' encontra 'Reunião'", () => {
		const result = filterHistoryEntries(entries, "", "reuniao");
		expect(result.map((e) => e.id)).toEqual(["a", "c"]); // ordem de entrada preservada
	});

	it("query normalizada: minúsculas, sem diacríticos, trim nas bordas", () => {
		expect(normalizeSearchText("ReuniÃO")).toBe("reuniao");
		expect(parseSearchQuery("  Reunião  ")).toBe("reuniao");
	});

	it("combina com o filtro de tipo (E lógico)", () => {
		// "Reunião" bate em a e c; o filtro mcp:action reduz a só c.
		const result = filterHistoryEntries(entries, "mcp:action", "reuniao");
		expect(result.map((e) => e.id)).toEqual(["c"]);
		// E o inverso: mesmo texto, outro tipo, outro resultado.
		const onlyFiles = filterHistoryEntries(entries, "file:created", "reuniao");
		expect(onlyFiles.map((e) => e.id)).toEqual(["a"]);
	});

	it("query vazia/branca não filtra por texto (mas o tipo continua filtrando)", () => {
		expect(filterHistoryEntries(entries, "file:created", "")).toHaveLength(2);
		expect(filterHistoryEntries(entries, "file:created", "   ")).toHaveLength(2);
	});

	it("nenhuma correspondência devolve lista vazia sem lançar", () => {
		expect(filterHistoryEntries(entries, "", "zzz-inexistente")).toEqual([]);
		expect(filterHistoryEntries(entries, "folder:created", "reuniao")).toEqual([]);
	});

	it("entrada sem path busca só no message e nunca quebra", () => {
		const semPath: HistoryEntryRecord[] = [makeEntry({ id: "x", message: "Servidor MCP iniciado na porta 8765" })];
		expect(filterHistoryEntries(semPath, "", "8765")).toHaveLength(1);
		expect(filterHistoryEntries(semPath, "", "porta")).toHaveLength(1);
	});
});

/**
 * O log dedicado do MCP só vale com consumidor real: o Histórico escuta
 * mcp:action-logged (TRACKED_EVENTS) e registra cada ação com o DESFECHO —
 * inclusive falhas (auditoria não é lista de acertos).
 */
describe("Histórico — consumidor do log dedicado do MCP", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("mcp:action-logged vira entrada com desfecho ok", async () => {
		const { module, emit, slice } = setup();
		module.onEnable();
		emit(
			"mcp:action-logged",
			{ tool: "put_attachment", path: "Anexos/img.png", dryRun: false, isWrite: true, result: { ok: true } },
			"mcp"
		);
		await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);
		expect(slice.entries).toHaveLength(1);
		expect(slice.entries[0].event).toBe("mcp:action-logged");
		expect(slice.entries[0].message).toContain("put_attachment");
		expect(slice.entries[0].message).toContain("— ok");
	});

	it("falha da ação entra como FALHOU (com o motivo)", async () => {
		const { module, emit, slice } = setup();
		module.onEnable();
		emit(
			"mcp:action-logged",
			{ tool: "put_attachment", path: "Anexos/x.png", dryRun: false, isWrite: true, error: "base64 inválido" },
			"mcp"
		);
		await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);
		expect(slice.entries[0].message).toContain("FALHOU");
		expect(slice.entries[0].message).toContain("base64 inválido");
	});

	it("dry-run aparece como simulado, não como escrito", async () => {
		const { module, emit, slice } = setup();
		module.onEnable();
		emit("mcp:action-logged", { tool: "edit_note", path: "a.md", dryRun: true, isWrite: true, result: { simulated: true } }, "mcp");
		await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);
		expect(slice.entries[0].message).toContain("simulado (dry-run)");
	});
});
