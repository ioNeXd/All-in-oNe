import type { App } from "obsidian";
import { createDefaultSettings, type HubSettings } from "./types";

/**
 * PERSISTÊNCIA SPLIT — data.json PRINCIPAL + UM ARQUIVO POR MÓDULO
 * ------------------------------------------------------------------
 * Layout:
 *   data.json                    → tudo, MENOS as fatias dos módulos splitados
 *   data.modules/<moduleId>.json → a fatia do módulo, gravada só quando muda
 *
 * VERSION STAMPING (_v):
 *   Cada arquivo carrega um campo _v (number). persistVersioned grava todos
 *   com o MESMO _v. Se crash no meio, _v permite detectar inconsistência.
 *
 *   Na leitura:
 *     - Calcula o _v MÁXIMO entre data.json e todos os arquivos splitados.
 *     - Qualquer arquivo com _v < máximo é descartado (stale after crash).
 *     - Se algum arquivo tem _v significativamente diferente, sinaliza
 *       corrupção potencial mas aceita o snapshot mais recente.
 *     - Arquivos sem _v são aceitos (backward compat).
 *
 *   NUNCA monta silenciosamente uma config híbrida de versões incompatíveis.
 */

export const MODULES_DIR = "data.modules";
export const VERSION_KEY = "_v";

export const SPLIT_MODULE_IDS = ["history", "notifications"] as const;

export interface SplitPersistenceHandle {
	loadMain: () => Promise<HubSettings | null>;
	persistMain: (data: HubSettings) => Promise<void>;
	loadModule: (moduleId: string) => Promise<Record<string, unknown> | null>;
	persistModule: (moduleId: string, slice: Record<string, unknown>) => Promise<void>;
	persistVersioned: (main: HubSettings, slices: Map<string, Record<string, unknown>>, version: number) => Promise<void>;
	lastVersion: number | null;
	readCorrupted: boolean;
	corruptedPaths: string[];
	/**
	 * true quando a última leitura detectou arquivos com versões incompatíveis.
	 * A config carregada usa o snapshot mais recente, mas o flag sinaliza
	 * que algum arquivo ficou para trás (crash entre gravações).
	 */
	versionInconsistencyDetected: boolean;
}

export function moduleFilePath(moduleId: string): string {
	return `${MODULES_DIR}/${moduleId}.json`;
}

export function stubSlices(settings: HubSettings, ids: readonly string[]): HubSettings {
	const modules = { ...settings.modules };
	for (const id of ids) modules[id] = {};
	return { ...settings, modules };
}

export function createSplitPersistence(app: App, pluginDir: string): SplitPersistenceHandle {
	const adapter = app.vault.adapter;

	let readCorrupted = false;
	const corruptedPaths: string[] = [];
	let detectedVersion: number | null = null;
	let versionInconsistency = false;

	const readFile = async <T>(path: string): Promise<T | null> => {
		if (!(await adapter.exists(path))) return null;

		let raw: string;
		try {
			raw = await adapter.read(path);
		} catch (error) {
			readCorrupted = true;
			corruptedPaths.push(path);
			console.error("[SplitPersistence] Erro de I/O ao ler arquivo:", path, error);
			throw error;
		}

		try {
			return JSON.parse(raw) as T;
		} catch (error) {
			readCorrupted = true;
			corruptedPaths.push(path);
			console.error("[SplitPersistence] Arquivo corrompido:", path, error);
			try {
				await adapter.write(`${path}.corrupt`, raw);
			} catch { /* backup é melhor-esforço */ }
			return null;
		}
	};

	const writeFileSafe = async (path: string, data: unknown): Promise<void> => {
		const folder = path.substring(0, path.lastIndexOf("/"));
		if (folder && !(await adapter.exists(folder))) {
			await adapter.mkdir(folder);
		}
		await adapter.write(path, JSON.stringify(data, null, 2));
	};

	const absolute = (relative: string) => `${pluginDir}/${relative}`;

	return {
		loadMain: async () => {
			const main = await readFile<Record<string, unknown>>(absolute("data.json"));
			if (!main) return null;

			const mainVersion = (main[VERSION_KEY] as number | undefined) ?? null;

			// FASE 1: Coleta versões de TODOS os arquivos.
			const sliceData = new Map<string, { raw: Record<string, unknown> | null; version: number | null }>();
			for (const id of SPLIT_MODULE_IDS) {
				const sliceRaw = await readFile<Record<string, unknown>>(absolute(moduleFilePath(id)));
				const sliceVersion = (sliceRaw?.[VERSION_KEY] as number | undefined) ?? null;
				sliceData.set(id, { raw: sliceRaw, version: sliceVersion });
			}

			// FASE 2: Calcula o _v MÁXIMO entre todos os arquivos.
			const allVersions: number[] = [];
			if (mainVersion != null) allVersions.push(mainVersion);
			for (const entry of sliceData.values()) {
				if (entry.version != null) allVersions.push(entry.version);
			}
			const maxVersion = allVersions.length > 0 ? Math.max(...allVersions) : null;
			const minVersion = allVersions.length > 0 ? Math.min(...allVersions) : null;

			// FASE 3: Detecta inconsistência — algum arquivo ficou para trás.
			if (maxVersion != null && minVersion != null && maxVersion !== minVersion) {
				versionInconsistency = true;
				console.warn(
					`[SplitPersistence] Inconsistência de versão detectada: ` +
					`máximo=${maxVersion}, mínimo=${minVersion}. ` +
					`Usando snapshot mais recente (máximo=${maxVersion}).`
				);
			}

			detectedVersion = maxVersion;

						// FASE 4: Reconstitui fatias — aceita APENAS versão == máximo.
			const modules: Record<string, Record<string, unknown>> = {
				...(main.modules as Record<string, Record<string, unknown>> ?? {}),
			};

			for (const id of SPLIT_MODULE_IDS) {
				const info = sliceData.get(id);
				const sliceRaw = info?.raw;
				const sliceVersion = info?.version ?? null;

				// Fix 15: distinguish missing, corrupted, and empty
				if (sliceRaw === null) {
					// File doesn't exist or couldn't be parsed
					readCorrupted = true;
					corruptedPaths.push(absolute(moduleFilePath(id)));
					console.warn(`[SplitPersistence] Módulo ${id}.json corrompido — usando stub do principal.`);
					modules[id] = (main.modules as Record<string, Record<string, unknown>>)?.[id] ?? {};
					continue;
				}

				// Fix 14: don't silently combine mismatched versions
				if (maxVersion != null && sliceVersion != null && sliceVersion < maxVersion) {
					console.warn(
						`[SplitPersistence] Módulo ${id}.json obsoleto: _v=${sliceVersion} < máximo=${maxVersion}. ` +
						"Usando stub do principal."
					);
					modules[id] = {};
					continue;
				}

				if (sliceVersion != null && mainVersion != null && sliceVersion > mainVersion) {
					detectedVersion = sliceVersion;
				}

				// Remove _v antes de merge — campo é meta, não dado do módulo.
				const { [VERSION_KEY]: _sv, ...cleanSlice } = sliceRaw;
				void _sv;
				modules[id] = cleanSlice;
			}
const { [VERSION_KEY]: _mainV, ...mainWithoutVersion } = main as Record<string, unknown>;
			void _mainV;
			return { ...createDefaultSettings(), ...mainWithoutVersion, modules } as HubSettings;
		},

		persistMain: async (data) => {
			await writeFileSafe(absolute("data.json"), stubSlices(data, SPLIT_MODULE_IDS));
		},

		loadModule: (moduleId) => readFile(absolute(moduleFilePath(moduleId))),

		persistModule: (moduleId, slice) => writeFileSafe(absolute(moduleFilePath(moduleId)), slice),

		persistVersioned: async (main, slices, version) => {
			for (const id of SPLIT_MODULE_IDS) {
				const slice = slices.get(id) ?? (await readFile<Record<string, unknown>>(absolute(moduleFilePath(id)))) ?? {};
				await writeFileSafe(absolute(moduleFilePath(id)), { ...slice, [VERSION_KEY]: version });
			}
			const versionedMain = { ...stubSlices(main, SPLIT_MODULE_IDS), [VERSION_KEY]: version } as Record<string, unknown>;
			await writeFileSafe(absolute("data.json"), versionedMain);
		},

		get readCorrupted() { return readCorrupted; },
		get corruptedPaths() { return corruptedPaths; },
		get lastVersion() { return detectedVersion; },
		get versionInconsistencyDetected() { return versionInconsistency; },
	};
}
