import type { App } from "obsidian";
import { EventBus } from "./EventBus";
import { SettingsManager } from "./SettingsManager";
import { FileWriteQueue } from "./FileWriteQueue";
import type { HubModule, ModuleContext, ModuleId } from "./ModuleContract";
import type { HubSettings } from "./types";

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
 *   - Aplicar o "modo seguro" quando um módulo falha repetidamente ao habilitar.
 *   - Aplicar lazy loading: só instanciar/habilitar módulos que estão ligados.
 */
export class HubCore {
	readonly bus = new EventBus();
	readonly fileWriteQueue = new FileWriteQueue();
	readonly settings: SettingsManager;

	private modules = new Map<ModuleId, HubModule>();
	/**
	 * DOIS SETS, DOIS PAPÉIS (não fundir):
	 * - enabledModuleIds: o DESEJO da config (semeado em init(), atualizado
	 *   por enable/disable bem-sucedidos). É o que o Lobby persiste e o que
	 *   sobrevive a falhas — um módulo cujo onEnable explodiu continua
	 *   "desejado" para que a próxima tentativa (ou o reset) o religue.
	 * - runtimeEnabledIds: o que está REALMENTE vivo (onEnable rodou). É o
	 *   único papel do isModuleEnabled — Paleta de comandos, toggles, health
	 *   e dependências entre módulos consultam a realidade, não o desejo.
	 */
	private enabledModuleIds = new Set<ModuleId>();
	private runtimeEnabledIds = new Set<ModuleId>();
	private crashCounts = new Map<ModuleId, number>();
	private lastEnableErrors = new Map<ModuleId, string>();
	private safeMode = false;

	constructor(
		readonly app: App,
		load: () => Promise<HubSettings | null>,
		persist: (data: HubSettings) => Promise<void>
	) {
		this.settings = new SettingsManager(load, persist);

		// Eventos de vault são de alta frequência em vaults grandes — throttle
		// evita sobrecarregar listeners caros (Histórico, Notificações).
		// ATENÇÃO: o throttle do bus AGRUPA as emissões dentro da janela e as
		// entrega no fim dela como { coalesced: [...] } — nada é perdido, mas a
		// entrega é ATRASADA até o fim da janela. NÃO aplicar a "file:modified"
		// enquanto o módulo de Templates precisar reagir a ela na hora (retornar
		// nota de Pendente): a entrega atrasada quebraria o fluxo. "file:created"
		// não tem listener que precise de cadência exata e é o que pode explodir
		// em rajada (selecionar 200 notas → criar); Histórico e Notificações
		// expandem o coalesced (um registro por ocorrência — Notificações toca
		// popup/som só no 1º item, para não virar rajada de sons).
		this.bus.setThrottle("file:created", 500);

		// NOTA para quem for estender isto: o EventBus atual não tem wildcard
		// ("escutar tudo"). A Central de Eventos do Lobby usa `bus.getHistory()`
		// (log da SESSÃO, debug) em vez de se inscrever em cada evento manualmente
		// — é o jeito mais simples de ter um "escutador universal" sem precisar
		// listar todo evento existente aqui. Registro PERSISTENTE de produto é
		// papel do módulo de Histórico, que escuta os eventos relevantes.
	}

	async init(): Promise<void> {
		const settings = await this.settings.init();
		this.enabledModuleIds = new Set(settings.enabledModules);

		if (await this.settings.detectExternalChange()) {
			void this.bus.emit(
				"core:sync-conflict",
				{
					message:
						"Configuração foi alterada por outro dispositivo desde a última vez que este Obsidian salvou. Revise antes de editar configurações.",
				},
				"core"
			);
		}
	}

	private moduleContexts = new Map<ModuleId, ModuleContext>();

	/**
	 * Registra um módulo — permite lazy loading: a ATIVAÇÃO (onEnable) só roda
	 * se o módulo estiver na lista de habilitados nas configurações. `onRegister`,
	 * porém, roda sempre, para que o módulo consiga expor configurações mesmo desligado.
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
		}
		// No modo seguro, o registro de um módulo listado na config NÃO roda
		// onEnable — e NÃO toca nenhum dos dois sets: o desejo fica como está
		// (config semântica preservada) e o runtime não vê o módulo (comandos
		// da Paleta seguem indisponíveis). Um registerModule pós-SAÍDA do modo
		// seguro habilita de fato; enquanto o bloqueio durar, só uma chamada
		// EXPLÍCITA de enableModule (ação do usuário pelo Lobby) habilita.
	}

	private buildContext(id: ModuleId): ModuleContext {
		return {
			app: this.app,
			bus: this.bus,
			getSettings: () => this.settings.getModuleSettings(id),
			updateSettings: async (patch) => {
				const issues = await this.settings.updateModuleSettings(id, patch);
				if (issues.length > 0) return issues;
				try {
					this.modules.get(id)?.onSettingsChange?.(this.settings.get());
				} catch (err) {
					console.error(`[All iₙ oNe] Módulo "${id}" falhou ao reagir à mudança de config:`, err);
				}
				return issues;
			},
			getFullSettings: () => this.settings.get(),
			isModuleEnabled: (targetId) => this.runtimeEnabledIds.has(targetId),
			log: (message, data) => {
				void this.bus.emit("core:log", { message, path: data?.path as string | undefined }, id);
			},
			registerCommand: (cmdId, name, callback) => {
				this.onRegisterCommand?.(id, cmdId, name, callback);
			},
			fileWriteQueueRun: (path, operation) => this.fileWriteQueue.run(path, operation),
			fileWriteQueueRunMany: (paths, operation) => this.fileWriteQueue.runMany(paths, operation),
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
			this.runtimeEnabledIds.add(id);
			this.crashCounts.set(id, 0);
			this.lastEnableErrors.delete(id);
			if (this.safeMode) {
				this.safeMode = false;
				this.crashCounts.clear();
				void this.bus.emit("core:safe-mode-exited", { moduleId: id }, "core");
			}
		} catch (err) {
			console.error(`[All iₙ oNe] Falha ao habilitar o módulo "${id}":`, err);
			// enabledModuleIds (desejo) NÃO é tocado — módulo continua "desejado"
			// para próxima tentativa/reset. Só o runtime sai.
			this.runtimeEnabledIds.delete(id);
			this.lastEnableErrors.set(id, describeError(err));
			void this.bus.emit(
				"core:module-error",
				{ moduleId: id, eventName: "onEnable", error: describeError(err) },
				"core"
			);
			const crashes = (this.crashCounts.get(id) ?? 0) + 1;
			this.crashCounts.set(id, crashes);
			if (crashes >= CRASH_LIMIT_BEFORE_SAFE_MODE) {
				await this.enterSafeMode(id, err);
			}
			// Não relança: falha de um módulo nunca impede os demais no startup.
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
			this.runtimeEnabledIds.delete(id);
		}
	}

	async disableAll(): Promise<void> {
		for (const id of [...new Set([...this.enabledModuleIds, ...this.runtimeEnabledIds])]) {
			await this.disableModule(id);
		}
		this.bus.disposeAll();
	}

	/**
	 * MODO SEGURO: se um módulo falha repetidamente ao habilitar (3x), ele é
	 * desligado e o restante do plugin continua. ENTRADA: crashCount >= 3 →
	 * safeMode = true, bloqueio de novos enables. SAÍDA: ofensor religado
	 * com sucesso pelo Lobby → safeMode = false. Bloqueio é da sessão.
	 */
	private async enterSafeMode(offendingModuleId: ModuleId, error: unknown): Promise<void> {
		this.safeMode = true;
		this.enabledModuleIds.delete(offendingModuleId);
		this.runtimeEnabledIds.delete(offendingModuleId);
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
		return this.runtimeEnabledIds.has(id);
	}

	// Ponte para o main.ts registrar comandos nativos do Obsidian.
	onRegisterCommand?: (
		moduleId: ModuleId,
		cmdId: string,
		name: string,
		callback: () => void
	) => void;

	/**
	 * Restaurar tudo — escadinha real de 3 níveis, como promete o modal:
	 * - "config": só a configuração volta ao padrão; dados gerados intactos.
	 * - "data": configuração intacta; módulos limpam seus dados via onResetData.
	 * - "all": config padrão + onResetData (config E dados zerados).
	 */
	async resetAll(level: "config" | "data" | "all"): Promise<void> {
		if (level !== "data") await this.settings.reset();
		if (level !== "data") {
			const desired = new Set(this.settings.get().enabledModules);
			for (const module of this.getModules()) {
				const id = module.manifest.id;
				if (desired.has(id) && !this.enabledModuleIds.has(id)) await this.enableModule(id);
				else if (!desired.has(id) && (this.enabledModuleIds.has(id) || this.isModuleEnabled(id))) {
					await this.disableModule(id);
				}
			}
		}
		if (level !== "config") {
			for (const module of this.getModules()) {
				try {
					await module.onResetData?.();
				} catch (err) {
					console.error(`[All iₙ oNe] Módulo "${module.manifest.id}" falhou ao limpar dados no reset:`, err);
				}
			}
			this.bus.clearHistory();
		}
		if (level !== "data") {
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
		const modules = this.getModules().map((m) => {
			if (!this.isModuleEnabled(m.manifest.id)) {
				return { moduleId: m.manifest.id, ok: true, summary: "Desligado" };
			}
			const status = m.getHealthStatus?.() ?? { ok: true, summary: "OK" };
			return { moduleId: m.manifest.id, ...status };
		});

		// Estado de persistência: degradado quando uma gravação falhou
		// (disco potencialmente defasado). Mostrado no diagnóstico como
		// item separado — não é módulo, mas é saúde do sistema.
		if (this.settings.persistenceDegraded) {
			modules.push({
				moduleId: "persist" as ModuleId,
				ok: false,
				summary: this.settings.lastPersistenceError
					? `Persistência degradada: ${this.settings.lastPersistenceError}`
					: "Persistência degradada — última gravação pode ter falhado",
			});
		}

		return modules;
	}
}
