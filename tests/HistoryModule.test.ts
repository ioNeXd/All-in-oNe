import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
	HistoryModule,
	HISTORY_DEFAULTS,
	type HistoryEntryRecord,
} from "../src/modules/history/HistoryModule";
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
		expect(unsubscribers.length).toBe(19); // TRACKED_EVENTS.length

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
