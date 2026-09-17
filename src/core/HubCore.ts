import type { App } from "obsidian";
import { EventBus } from "./EventBus";
import { SettingsManager } from "./SettingsManager";
import { FileWriteQueue } from "./FileWriteQueue";
import type { HubModule, ModuleContext, ModuleId } from "./ModuleContract";
import type { HistoryEntry, HistoryEventType, HubSettings } from "./types";
import { cryptoRandomId } from "./types";

const CONTRACT_VERSION = "2.0.0"; // v2: onRegister/onEnable separados (ver ModuleContract.ts)
const CRASH_LIMIT_BEFORE_SAFE_MODE = 3;

function describeError(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}

/**
 * NÚCLEO (HubCore)
 * ----------------
 * Ordem de construção que este núcleo assume (ver auditoria de arquitetura):
 * o contrato de módulo (ModuleContract.ts) já existe e é estável antes de
 * qualquer módulo ser escrito; o núcleo depende só do contrato, nunca de um
 * módulo específico; os módulos dependem do núcleo, nunca uns dos outros
 * diretamente.
 *
 * Responsabilidades do núcleo:
 *   - Registrar módulos e orquestrar onEnable/onDisable com isolamento de falha.
 *   - Expor o event bus e a fila de escrita de arquivos para os módulos.
 *   - Manter o histórico consolidado (alimentado pelo bus).
 *   - Aplicar o "modo seguro" quando um módulo falha repetidamente ao habilitar.
 *   - Aplicar lazy loading: só instanciar/habilitar módulos que estão ligados.
 */
export class HubCore {
	readonly bus = new EventBus();
	readonly fileWriteQueue = new FileWriteQueue();
	readonly settings: SettingsManager;

	private modules = new Map<ModuleId, HubModule>();
	private enabledModuleIds = new Set<ModuleId>();
	private crashCounts = new Map<ModuleId, number>();
	private lastEnableErrors = new Map<ModuleId, string>();
	private history: HistoryEntry[] = [];
	/** Buffer pequeno: o histórico de produto vive no módulo History, persistido. */
	private historyLimit = 200;
	private safeMode = false;

	constructor(
		readonly app: App,
		load: () => Promise<HubSettings | null>,
		persist: (data: HubSettings) => Promise<void>
	) {
		this.settings = new SettingsManager(load, persist);

		// Eventos de vault são de alta frequência em vaults grandes — throttle
		// evita sobrecarregar listeners caros (Histórico, Notificações).
		// ATENÇÃO: o throttle do bus descarta emissões inteiras, então NÃO
		// aplicar a "file:modified" enquanto o módulo de Templates precisar
		// reagir a ela (retornar nota de Pendente). "file:created" não tem
		// listener que precise de cadência exata e é o que pode explodir em
		// rajada (selecionar 200 notas → criar). Se um dia o Histórico/Notifi-
		// cações tratarem file:modified, o mute deles no HistoryModule resolve.
		this.bus.setThrottle("file:created", 500);

		// NOTA para quem for estender isto: o EventBus atual não tem wildcard
		// ("escutar tudo"). A aba de Histórico do Lobby usa `bus.getHistory()`
		// (buffer interno do próprio bus) em vez de se inscrever em cada
		// evento manualmente — é o jeito mais simples de ter um "escutador
		// universal" sem precisar listar todo evento existente aqui.
	}

	async init(): Promise<void> {
		const settings = await this.settings.init();
		this.enabledModuleIds = new Set(settings.enabledModules);

		if (await this.settings.detectExternalChange()) {
			this.logHistory({
				type: "generic",
				origin: "core",
				message:
					"Configuração foi alterada por outro dispositivo desde a última vez que este Obsidian salvou. Revise antes de editar configurações.",
			});
		}
	}

	private moduleContexts = new Map<ModuleId, ModuleContext>();

	/**
	 * Registra a CLASSE de um módulo (não a instância) — permite lazy loading
	 * real: a ATIVAÇÃO (onEnable) só roda se o módulo estiver na lista de
	 * módulos habilitados nas configurações. `onRegister`, porém, roda sempre,
	 * para que o módulo consiga expor configurações mesmo desligado.
	 */
	async registerModule(module: HubModule): Promise<void> {
		this.modules.set(module.manifest.id, module);
		this.settings.registerModuleForValidation(module);

		const context = this.buildContext(module.manifest.id);
		this.moduleContexts.set(module.manifest.id, context);
		module.onRegister(context);

		const shouldEnable = this.enabledModuleIds.has(module.manifest.id) && !this.safeMode;
		if (shouldEnable) {
			await this.enableModule(module.manifest.id);
		} else if (this.safeMode) {
			// O Set foi semeado pela config no init(); um módulo bloqueado pelo
			// modo seguro NÃO está habilitado de verdade — a memória não pode
			// dizer o contrário (Lobby/checkCallback leriam estado falso).
			this.enabledModuleIds.delete(module.manifest.id);
		}
	}

	private buildContext(id: ModuleId): ModuleContext {
		return {
			app: this.app,
			bus: this.bus,
			getSettings: () => this.settings.getModuleSettings(id),
			updateSettings: async (patch) => {
				const issues = await this.settings.updateModuleSettings(id, patch);
				// Se a validação bloqueou, nada foi persistido — notificar seria
				// mentir para o módulo (o hook veria a config ANTIGA como se nova).
				if (issues.length > 0) return issues;
				// Contrato v2: onSettingsChange dispara quando a config DO MÓDULO
				// muda, não só no reset. Síncrono e isolado — erro de um módulo
				// reagindo não quebra a gravação nem os demais.
				try {
					this.modules.get(id)?.onSettingsChange?.(this.settings.get());
				} catch (err) {
					console.error(`[All iₙ oNe] Módulo "${id}" falhou ao reagir à mudança de config:`, err);
				}
				return issues;
			},
			getFullSettings: () => this.settings.get(),
			log: (message, data) =>
				this.logHistory({ type: "generic", origin: id, message, path: data?.path as string }),
			registerCommand: (cmdId, name, callback) => {
				this.onRegisterCommand?.(id, cmdId, name, callback);
			},
			fileWriteQueueRun: (path, operation) => this.fileWriteQueue.run(path, operation),
			updatePaths: async (patch) => {
				const current = this.settings.get();
				return this.settings.save({ ...current, paths: { ...current.paths, ...patch } });
			},
		};
	}

	async enableModule(id: ModuleId): Promise<void> {
		const module = this.modules.get(id);
		if (!module) return;

		if (module.manifest.contractVersion.split(".")[0] !== CONTRACT_VERSION.split(".")[0]) {
			console.warn(
				`[All iₙ oNe] Módulo "${id}" foi escrito contra a major version ${module.manifest.contractVersion} do contrato, mas o núcleo está na ${CONTRACT_VERSION}. Pode haver incompatibilidade.`
			);
		}

		try {
			await module.onEnable();
			this.enabledModuleIds.add(id);
			this.crashCounts.set(id, 0);
			this.lastEnableErrors.delete(id);
		} catch (err) {
			console.error(`[All iₙ oNe] Falha ao habilitar o módulo "${id}":`, err);
			// O Set foi semeado por init() a partir da config — se o onEnable
			// falhou, a memória precisa voltar a refletir a realidade: módulo
			// NÃO habilitado. Sem isto, o Lobby mostraria "ligado" num módulo
			// que falhou e o checkCallback deixaria seus comandos executáveis
			// fora do ciclo de vida.
			this.enabledModuleIds.delete(id);
			this.lastEnableErrors.set(id, describeError(err));
			this.logHistory({
				type: "module-error",
				origin: id,
				message: `Falha ao habilitar: ${describeError(err)}`,
			});
			const crashes = (this.crashCounts.get(id) ?? 0) + 1;
			this.crashCounts.set(id, crashes);
			if (crashes >= CRASH_LIMIT_BEFORE_SAFE_MODE) {
				await this.enterSafeMode(id, err);
			}
			// Não relança: um módulo falhando ao habilitar nunca deve impedir o
			// registro/ativação dos demais módulos durante o startup do plugin.
			// Quem chamou (ex.: o Lobby) confere o resultado via isModuleEnabled().
		}
	}

	async disableModule(id: ModuleId): Promise<void> {
		const module = this.modules.get(id);
		if (!module) return;
		try {
			await module.onDisable();
		} catch (err) {
			console.error(`[All iₙ oNe] Falha ao desabilitar o módulo "${id}":`, err);
		} finally {
			this.bus.offAll(id);
			this.enabledModuleIds.delete(id);
		}
	}

	async disableAll(): Promise<void> {
		for (const id of [...this.enabledModuleIds]) {
			await this.disableModule(id);
		}
	}

	/**
	 * MODO SEGURO: se um módulo falha repetidamente ao habilitar, ele é
	 * desligado automaticamente e o restante do plugin continua funcionando
	 * — em vez de travar o Obsidian inteiro na inicialização por causa de um
	 * módulo problemático.
	 */
	private async enterSafeMode(offendingModuleId: ModuleId, error: unknown): Promise<void> {
		this.safeMode = true;
		this.enabledModuleIds.delete(offendingModuleId);
		this.logHistory({
			type: "module-error",
			origin: "core",
			message: `Módulo "${offendingModuleId}" falhou ${CRASH_LIMIT_BEFORE_SAFE_MODE}x ao habilitar e foi desligado automaticamente. Detalhe: ${String(
				error
			)}`,
		});
		await this.bus.emit(
			"core:safe-mode-entered",
			{ moduleId: offendingModuleId, error: String(error) },
			"core"
		);
	}

	getModules(): HubModule[] {
		return [...this.modules.values()];
	}

	getLastEnableError(id: ModuleId): string | undefined {
		return this.lastEnableErrors.get(id);
	}

	isModuleEnabled(id: ModuleId): boolean {
		return this.enabledModuleIds.has(id);
	}

	// Ponte para o main.ts registrar comandos nativos do Obsidian.
	onRegisterCommand?: (
		moduleId: ModuleId,
		cmdId: string,
		name: string,
		callback: () => void
	) => void;

	logHistory(entry: Omit<HistoryEntry, "id" | "timestamp">): void {
		const full: HistoryEntry = {
			...entry,
			id: cryptoRandomId(),
			timestamp: Date.now(),
		};
		this.history.push(full);
		if (this.history.length > this.historyLimit) this.history.shift();
	}

	getHistory(filter?: { type?: HistoryEventType; origin?: string }): HistoryEntry[] {
		if (!filter) return [...this.history];
		return this.history.filter(
			(h) =>
				(!filter.type || h.type === filter.type) && (!filter.origin || h.origin === filter.origin)
		);
	}

	/**
	 * Restaurar tudo — escadinha real de 3 níveis, como promete o modal:
	 * - "config": só a configuração volta ao padrão; dados gerados intactos.
	 * - "data": configuração intacta; módulos limpam seus dados via onResetData;
	 *   histórico do núcleo/bus também é limpo.
	 * - "all": config padrão + onResetData (config E dados zerados).
	 */
	async resetAll(level: "config" | "data" | "all"): Promise<void> {
		if (level === "all") await this.settings.reset("all");
		else if (level === "config") await this.settings.reset("config");
		if (level !== "data") {
			// O reset substituiu `enabledModules` no disco (default = todos
			// ligados), mas o Set em memória — que o Lobby usa para toggles e
			// diagnóstico — só é sincronizado no init(). Sem reconciliar, o
			// Lobby mostraria "Desligado" num módulo que a config diz estar
			// ligado (e o estado só bateria após reiniciar o Obsidian).
			// enableModule/disableModule mantêm o Set e isolam falhas.
			const desired = new Set(this.settings.get().enabledModules);
			for (const module of this.getModules()) {
				const id = module.manifest.id;
				if (desired.has(id) && !this.isModuleEnabled(id)) await this.enableModule(id);
				else if (!desired.has(id) && this.isModuleEnabled(id)) await this.disableModule(id);
			}
		}
		if (level !== "config") {
			// Dados gerados: hook do contrato + histórico do núcleo/bus. Roda para
			// TODOS os módulos registrados, não só os ligados — dado gerado é dado
			// gerado; se sobrevivesse ao reset, voltaria ao religar o módulo.
			for (const module of this.getModules()) {
				try {
					await module.onResetData?.();
				} catch (err) {
					console.error(`[All iₙ oNe] Módulo "${module.manifest.id}" falhou ao limpar dados no reset:`, err);
				}
			}
			this.history = [];
			this.bus.clearHistory();
		}
		if (level !== "data") {
			// A fatia de cada módulo pode ter mudado no disco; sem avisar, cada
			// módulo seguiria com a config ANTIGA em memória (ex.: Histórico com
			// 500 entradas de volta na próxima gravação). No "data" nada mudou
			// na config — os módulos acabaram de escrever o próprio dado.
			for (const module of this.getModules()) {
				if (this.isModuleEnabled(module.manifest.id)) {
					try {
						module.onSettingsChange?.(this.settings.get());
					} catch (err) {
						console.error(`[All iₙ oNe] Módulo "${module.manifest.id}" falhou ao reagir ao reset:`, err);
					}
				}
			}
		}
		await this.bus.emit("core:reset", { level }, "core");
	}

	getHealthSnapshot(): { moduleId: ModuleId; ok: boolean; summary: string }[] {
		return this.getModules().map((m) => {
			if (!this.isModuleEnabled(m.manifest.id)) {
				return { moduleId: m.manifest.id, ok: true, summary: "Desligado" };
			}
			const status = m.getHealthStatus?.() ?? { ok: true, summary: "OK" };
			return { moduleId: m.manifest.id, ...status };
		});
	}
}
