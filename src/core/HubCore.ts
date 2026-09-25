import type { App } from "obsidian";
import { EventBus } from "./EventBus";
import { SettingsManager } from "./SettingsManager";
import { FileWriteQueue } from "./FileWriteQueue";
import type { HubModule, ModuleContext, ModuleId } from "./ModuleContract";
import type { HubSettings } from "./types";

const CONTRACT_VERSION = "2.0.0";
const CRASH_LIMIT_BEFORE_SAFE_MODE = 3;

function describeError(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}

/**
 * NÚCLEO (HubCore)
 * ----------------
 * Responsabilidades:
 *   - Registrar módulos e orquestrar onEnable/onDisable com isolamento de falha.
 *   - Expor o event bus e a fila de escrita de arquivos para os módulos.
 *   - Aplicar o "modo seguro" quando um módulo falha repetidamente.
 *   - Aplicar lazy loading: só habilitar módulos que estão ligados.
 */
export class HubCore {
	readonly bus = new EventBus();
	readonly fileWriteQueue = new FileWriteQueue();
	readonly settings: SettingsManager;

	private modules = new Map<ModuleId, HubModule>();
	private enabledModuleIds = new Set<ModuleId>();
	private runtimeEnabledIds = new Set<ModuleId>();
	private registeredModuleIds = new Set<ModuleId>();
	private crashCounts = new Map<ModuleId, number>();
	private lastEnableErrors = new Map<ModuleId, string>();
	private safeMode = false;
	private safeModeOffenderId: ModuleId | undefined;

	constructor(
		readonly app: App,
		load: () => Promise<HubSettings | null>,
		persist: (data: HubSettings) => Promise<void>
	) {
		this.settings = new SettingsManager(load, persist);
		this.bus.setThrottle("file:created", 500);
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
	 * Registra um módulo. onRegister roda sempre; onEnable só se habilitado.
	 * Se onRegister falha, o módulo fica registrado mas não habilitado.
	 */
	async registerModule(module: HubModule): Promise<void> {
		const id = module.manifest.id;
		if (this.modules.has(id)) {
			console.warn(`[All iₙ oNe] Módulo "${id}" já está registrado; registro duplicado ignorado.`);
			return;
		}

		this.modules.set(id, module);
		this.settings.registerModuleForValidation(module);

		const context = this.buildContext(id);
		this.moduleContexts.set(id, context);

		try {
			module.onRegister(context);
			this.registeredModuleIds.add(id);
		} catch (err) {
			console.error(`[All iₙ oNe] Módulo "${module.manifest.id}" falhou no onRegister:`, err);
			this.lastEnableErrors.set(module.manifest.id, describeError(err));
			void this.bus.emit(
				"core:module-error",
				{ moduleId: module.manifest.id, eventName: "onRegister", error: describeError(err) },
				"core"
			);
			return;
		}

		const shouldEnable = this.enabledModuleIds.has(id) && !this.safeMode;
		if (shouldEnable) {
			await this.enableModule(id);
		}
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

	/**
	 * Habilita um módulo. Se onEnable falha, chama onDisable para limpar
	 * recursos parcialmente registrados (listeners, comandos, timers) e
	 * preserva o erro original.
	 */
	async enableModule(id: ModuleId): Promise<void> {
		const module = this.modules.get(id);
		if (!module || !this.registeredModuleIds.has(id)) return;

		if (this.safeMode && id !== this.safeModeOffenderId) return;

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
			void this.bus.emit("core:module-enabled", { moduleId: id }, "core");
			if (this.safeMode && id === this.safeModeOffenderId) {
				this.safeMode = false;
				this.safeModeOffenderId = undefined;
				this.crashCounts.clear();
				void this.bus.emit("core:safe-mode-exited", { moduleId: id }, "core");
			}
		} catch (err) {
			console.error(`[All iₙ oNe] Falha ao habilitar o módulo "${id}":`, err);

			// Cleanup: se onEnable registrou recursos parciais (listeners,
			// comandos, timers), onDisable deve limpá-los. Módulo deve ser
			// seguro para chamar onDisable mesmo após enable parcial.
			try {
				await module.onDisable();
			} catch (disableErr) {
				console.error(
					`[All iₙ oNe] onDisable também falhou ao limpar enable parcial de "${id}":`,
					disableErr
				);
			}

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
			// Não relança: falha de um módulo nunca impede os demais.
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
			void this.bus.emit("core:module-disabled", { moduleId: id }, "core");
		}
	}

	async disableAll(): Promise<void> {
		for (const id of [...new Set([...this.enabledModuleIds, ...this.runtimeEnabledIds])]) {
			await this.disableModule(id);
		}
		this.bus.disposeAll();
	}

	private async enterSafeMode(offendingModuleId: ModuleId, error: unknown): Promise<void> {
		this.safeMode = true;
		this.safeModeOffenderId = offendingModuleId;
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

	onRegisterCommand?: (
		moduleId: ModuleId,
		cmdId: string,
		name: string,
		callback: () => void
	) => void;

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
