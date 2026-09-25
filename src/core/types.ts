import type { ModuleId } from "./ModuleContract";
import { DEFAULT_PATHS } from "./PathResolver";

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

export interface HubSettings {
	/** Versão do schema de configuração — usada para migração automática. */
	schemaVersion: number;

	/** true até o assistente de primeira execução ser concluído. */
	onboardingCompleted: boolean;

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

export const SETTINGS_SCHEMA_VERSION = 2;

export function createDefaultSettings(): HubSettings {
	return {
		schemaVersion: SETTINGS_SCHEMA_VERSION,
		onboardingCompleted: false,
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
			calendarFolder: DEFAULT_PATHS.calendarFolder,
			calendarTemplatesFolder: DEFAULT_PATHS.calendarTemplatesFolder,
			inboxFolder: DEFAULT_PATHS.inboxFolder,
			systemFolder: DEFAULT_PATHS.systemFolder,
			filesFolder: DEFAULT_PATHS.filesFolder,
		},
		sync: {
			lastWrittenBy: randomId(),
			lastWrittenAt: Date.now(),
		},
		telemetry: {
			enabled: false,
		},
	};
}

/**
 * Id aleatório NÃO-secreto (inscrições no bus, ids de entrada de log) —
 * Math.random é suficiente para UNICIDADE, que é o requisito aqui.
 * O nome antigo ("randomId") enganava: nada de criptográfico.
 * Segredos usam `cryptoRandomToken` (abaixo) — CSPRNG de verdade.
 */
export function randomId(): string {
	return Array.from({ length: 16 }, () => Math.floor(Math.random() * 36).toString(36)).join("");
}

/**
 * Token SECRETO via CSPRNG — `crypto.getRandomValues` (Web Crypto, presente
 * no renderer do Obsidian e no runtime de teste via Node ≥ 19). 32 bytes de
 * entropia codificados em base64url (~256 bits): não previsível nem para
 * quem analisa o processo local — o requisito mínimo para um segredo de
 * autenticação, ainda que o servidor só escute em 127.0.0.1.
 */
export function cryptoRandomToken(bytes = 32): string {
	const buffer = new Uint8Array(bytes);
	globalThis.crypto.getRandomValues(buffer);
	let binary = "";
	for (const byte of buffer) binary += String.fromCharCode(byte);
	// base64url: seguro em headers/tokens sem escaping (sem +, / ou =).
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
