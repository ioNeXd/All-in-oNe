import type { ModuleId } from "./ModuleContract";

/** Nível de log de uma entrada de Histórico. */
export type HistoryEventType =
	| "file-created"
	| "file-modified"
	| "file-deleted"
	| "folder-created"
	| "folder-deleted"
	| "mcp-action"
	| "note-pending"
	| "note-restored"
	| "update-applied"
	| "calendar-event-fired"
	| "module-error"
	| "generic";

export interface HistoryEntry {
	id: string;
	type: HistoryEventType;
	path?: string;
	origin: ModuleId | "core";
	message: string;
	timestamp: number;
}

/** Um perfil de configuração inteiro, salvo/alternável pelo usuário. */
export interface SettingsProfile {
	id: string;
	name: string;
	modules: Record<string, Record<string, unknown>>;
}

export interface HubSettings {
	/** Versão do schema de configuração — usada para migração automática. */
	schemaVersion: number;

	/** true até o assistente de primeira execução ser concluído. */
	onboardingCompleted: boolean;

	/** Perfil ativo no momento. */
	activeProfileId: string;
	profiles: SettingsProfile[];

	/** Configuração por módulo, chaveada pelo ModuleId. Formato interno é do próprio módulo. */
	modules: Record<string, Record<string, unknown>>;

	/** Módulos habilitados no momento. */
	enabledModules: ModuleId[];

	lobby: {
		openMode: "tab" | "modal" | "ask-each-time";
		theme: "match-obsidian" | "custom";
		/**
		 * Ordem dos módulos na barra lateral do Lobby (ids). Opcional e
		 * tolerante: módulos não citados entram no fim; ids que não existem
		 * mais são ignorados (regras em src/ui/lobbyOrder.ts). Reordenar NÃO
		 * muda enabledModules — ordem é apresentação, ligado/desligado é estado.
		 */
		moduleOrder?: string[];
	};

	/** Caminhos globais que módulos podem referenciar — todos reconfiguráveis. */
	paths: {
		calendarFolder: string;
		calendarTemplatesFolder: string;
		[key: string]: string;
	};

	/** Marca de sincronização — usada para detectar conflito entre dispositivos. */
	sync: {
		lastWrittenBy: string; // um id aleatório gerado por instalação
		lastWrittenAt: number;
	};

	telemetry: {
		enabled: false; // fixo em false por padrão — sem telemetria, por design
	};
}

export const SETTINGS_SCHEMA_VERSION = 1;

export function createDefaultSettings(): HubSettings {
	return {
		schemaVersion: SETTINGS_SCHEMA_VERSION,
		onboardingCompleted: false,
		activeProfileId: "default",
		profiles: [{ id: "default", name: "Padrão", modules: {} }],
		modules: {},
		enabledModules: [
			"filelifecycle",
			"mcp",
			"styles",
			"autoupdate",
			"templates",
			"calendar",
			"notifications",
			"history",
		],
		lobby: {
			openMode: "ask-each-time",
			theme: "match-obsidian",
		},
		paths: {
			calendarFolder: "Calendario",
			calendarTemplatesFolder: "Calendario/templates",
		},
		sync: {
			lastWrittenBy: cryptoRandomId(),
			lastWrittenAt: Date.now(),
		},
		telemetry: {
			enabled: false,
		},
	};
}

export function cryptoRandomId(): string {
	return Array.from({ length: 16 }, () => Math.floor(Math.random() * 36).toString(36)).join("");
}
