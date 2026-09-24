import type { HubModule, ModuleId } from "../src/core/ModuleContract";

/**
 * Módulo falso mínimo para os testes do HubCore — implementa o contrato
 * sem carregar nenhum módulo real do plugin (que traria HTTP, timers e UI).
 * Os handlers opcionais são os espiões dos testes.
 */
export interface TestModuleOptions {
	id: ModuleId;
	contractVersion?: string;
	onRegister?: (ctx: unknown) => void;
	onEnable?: () => Promise<void> | void;
	onDisable?: () => Promise<void> | void;
	onSettingsChange?: (settings: unknown) => void;
	onResetData?: () => Promise<void> | void;
	getHealthStatus?: () => { ok: boolean; summary: string };
}

export function makeTestModule(options: TestModuleOptions): HubModule {
	return {
		manifest: {
			id: options.id,
			displayName: options.id,
			description: "módulo de teste",
			icon: "box",
			version: "0.0.1",
			contractVersion: options.contractVersion ?? "2.0.0",
			desktopOnly: false,
			emits: [],
			listensTo: [],
		},
		onRegister: options.onRegister ?? (() => {}),
		onEnable: options.onEnable ?? (() => {}),
		onDisable: options.onDisable ?? (() => {}),
		onSettingsChange: options.onSettingsChange,
		onResetData: options.onResetData,
		getHealthStatus: options.getHealthStatus,
	};
}
