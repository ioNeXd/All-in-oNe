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
 *     - data.json é o commit point da geração: seu _v define o snapshot
 *       aceito quando ele existe.
 *     - Fatias com _v diferente do _v do data.json são ignoradas, evitando
 *       montar silenciosamente uma configuração híbrida após crash.
 *     - Se o data.json não tem _v, fatias também podem ser lidas sem versão
 *       para manter backward compatibility.
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
	 * A config carregada usa o último data.json como snapshot com commit;
	 * o flag sinaliza que alguma fatia ficou para trás ou à frente dele.
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

			const mainVersion = typeof main[VERSION_KEY] === "number" ? main[VERSION_KEY] : null;
			const sliceData = new Map<string, { raw: Record<string, unknown> | null; version: number | null }>();
			for (const id of SPLIT_MODULE_IDS) {
				const sliceRaw = await readFile<Record<string, unknown>>(absolute(moduleFilePath(id)));
				const sliceVersion = typeof sliceRaw?.[VERSION_KEY] === "number" ? sliceRaw[VERSION_KEY] : null;
				sliceData.set(id, { raw: sliceRaw, version: sliceVersion });
			}

			const modules: Record<string, Record<string, unknown>> = {
				...(main.modules as Record<string, Record<string, unknown>> ?? {}),
			};

			// data.json is the commit point: persistVersioned writes every split slice
			// first and data.json last. Therefore a crash before the final write leaves
			// the previous main snapshot as the only committed snapshot; newer slices
			// are deliberately ignored. This prevents a hybrid of generations.
			let inconsistent = false;
			for (const id of SPLIT_MODULE_IDS) {
				const info = sliceData.get(id)!;
				if (info.raw === null) {
					inconsistent = mainVersion !== null;
					continue;
				}
				const { [VERSION_KEY]: _sliceVersion, ...cleanSlice } = info.raw;
				void _sliceVersion;

				if (mainVersion === null || info.version === null) {
					// Backward compatibility for unversioned data: use the slice as before.
					modules[id] = cleanSlice;
					continue;
				}
				if (info.version !== mainVersion) {
					inconsistent = true;
					continue;
				}
				modules[id] = cleanSlice;
			}

			if (inconsistent) {
				versionInconsistency = true;
				console.warn(
					`[SplitPersistence] Snapshot inconsistente: data.json _v=${mainVersion ?? "ausente"}; ` +
						"fatias incompatíveis foram ignoradas para evitar misturar gerações."
				);
			}
			detectedVersion = mainVersion;

			const { [VERSION_KEY]: _mainV, ...mainWithoutVersion } = main;
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
