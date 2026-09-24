import type { App } from "obsidian";
import { createDefaultSettings, type HubSettings } from "./types";

/**
 * PERSISTÊNCIA SPLIT — data.json PRINCIPAL + UM ARQUIVO POR MÓDULO
 * ------------------------------------------------------------------
 * Todo updateSettings regravava o data.json INTEIRO. Com o write-behind do
 * Histórico e das Notificações (flush a cada ~2s com arrays grandes dentro
 * de modules.*), um vault ativo reescrevia o JSON completo — config de todos
 * os outros módulos, paths, sync — várias vezes por minuto: I/O desnecessário
 * e data.json inchado para o sync do vault.
 *
 * Layout:
 *   data.json                    → tudo, MENOS as fatias dos módulos
 *                                  splitados (chaves com `{}` de stub —
 *                                  compatibilidade de leitura e rollback)
 *   data.modules/<moduleId>.json → a fatia do módulo, gravada só quando
 *                                  aquela fatia muda
 *
 * VERSION STAMPING (_v):
 *   Cada arquivo (data.json + cada módulo) carrega um campo _v (number).
 *   persistVersioned grava todos com o MESMO _v. Se crash no meio, _v
 *   permite detectar qual arquivo ficou para trás. No loadMain, se um
 *   módulo tem _v > data.json, o dado do módulo é mais recente e aceito
 *   (merge overlays o stub). Se _v < data.json, o módulo é obsoleto e
 *   o stub do main prevalece.
 *
 * Os arquivos vivem na PASTA DO PLUGIN (`<vault>/.obsidian/plugins/<id>/`) —
 * fora do vault do usuário, não poluem o sync das notas e seguem no mesmo
 * lugar do data.json.
 */

export const MODULES_DIR = "data.modules";
/** Campo de versão em cada arquivo persistido — detecta snapshots inconsistentes. */
export const VERSION_KEY = "_v";

/** Módulos cuja fatia vai para arquivo próprio (os de write-behind pesado). */
export const SPLIT_MODULE_IDS = ["history", "notifications"] as const;

export interface SplitPersistenceHandle {
	/** data.json inteiro, SEM as fatias splitadas (stubs `{}` no lugar). */
	loadMain: () => Promise<HubSettings | null>;
	persistMain: (data: HubSettings) => Promise<void>;
	/** Fatia do módulo — null se o arquivo ainda não existe. */
	loadModule: (moduleId: string) => Promise<Record<string, unknown> | null>;
	persistModule: (moduleId: string, slice: Record<string, unknown>) => Promise<void>;
	/**
	 * Grava main + todas as fatias com o MESMO _v. Se crash no meio,
	 * _v permite detectar inconsistência no próximo boot.
	 */
	persistVersioned: (main: HubSettings, slices: Map<string, Record<string, unknown>>, version: number) => Promise<void>;
	/** Versão detectada no último loadMain (null = sem versão no disco). */
	lastVersion: number | null;
	/** Se true, algum arquivo de dados existe mas não pôde ser lido. */
	readCorrupted: boolean;
	/** Caminhos dos arquivos que falharam ao ler (para diagnóstico/backup). */
	corruptedPaths: string[];
}

/** Caminho do arquivo de um módulo, relativo à pasta do plugin. */
export function moduleFilePath(moduleId: string): string {
	return `${MODULES_DIR}/${moduleId}.json`;
}

/**
 * Substitui as fatias splitadas por stubs `{}` no objeto a gravar no
 * data.json — versões antigas (ou um rollback) continuam lendo o arquivo
 * sem quebrar, só sem os dados grandes (que estão nos arquivos por módulo).
 */
export function stubSlices(settings: HubSettings, ids: readonly string[]): HubSettings {
	const modules = { ...settings.modules };
	for (const id of ids) modules[id] = {};
	return { ...settings, modules };
}

/**
 * Cria o handle de persistência split sobre o DataAdapter do Obsidian.
 * A pasta do plugin (`this.plugin.manifest.dir`) é o mesmo lugar do
 * data.json — o adapter do app resolve caminhos relativos a ele a partir
 * da raiz do vault, então o caminho completo é montado aqui.
 */
export function createSplitPersistence(app: App, pluginDir: string): SplitPersistenceHandle {
	const adapter = app.vault.adapter;

	let readCorrupted = false;
	const corruptedPaths: string[] = [];
	let detectedVersion: number | null = null;

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
	const writeFile = async (path: string, data: unknown): Promise<void> => {
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

			detectedVersion = (main[VERSION_KEY] as number | undefined) ?? null;

			// Reconstitui as fatias a partir dos arquivos por módulo.
			// Version check: se um módulo tem _v > main, o crash ocorreu
			// entre a gravação do módulo e do principal — o dado do módulo
			// é mais recente e aceito (merge overlays o stub).
			// Se _v do módulo < _v do main, módulo obsoleto — usa stub.
			const modules: Record<string, Record<string, unknown>> = { ...(main.modules as Record<string, Record<string, unknown>> ?? {}) };
			for (const id of SPLIT_MODULE_IDS) {
				const slice = (await readFile<Record<string, unknown>>(absolute(moduleFilePath(id)))) ?? {};
				const sliceVersion = (slice[VERSION_KEY] as number | undefined) ?? null;

				if (sliceVersion != null && detectedVersion != null && sliceVersion > detectedVersion) {
					console.warn(
						`[SplitPersistence] Inconsistência detectada: ${id}.json _v=${sliceVersion} > data.json _v=${detectedVersion}. ` +
						"Dado do módulo aceito (mais recente)."
					);
					detectedVersion = sliceVersion;
				} else if (sliceVersion != null && detectedVersion != null && sliceVersion < detectedVersion) {
					console.warn(
						`[SplitPersistence] Módulo ${id}.json obsoleto: _v=${sliceVersion} < data.json _v=${detectedVersion}. ` +
						"Usando stub do principal."
					);
					modules[id] = {};
					continue;
				}

				// Remove _v antes de merge — campo é meta, não dado do módulo.
				const { [VERSION_KEY]: _sv, ...cleanSlice } = slice;
				void _sv;
				modules[id] = cleanSlice;
			}

			return { ...createDefaultSettings(), ...(main as unknown as HubSettings), modules };
		},

		persistMain: async (data) => {
			await writeFile(absolute("data.json"), stubSlices(data, SPLIT_MODULE_IDS));
		},

		loadModule: (moduleId) => readFile(absolute(moduleFilePath(moduleId))),

		persistModule: (moduleId, slice) => writeFile(absolute(moduleFilePath(moduleId)), slice),

		persistVersioned: async (main, slices, version) => {
			// Grava todos os arquivos com o MESMO _v. Se crash no meio,
			// _v permite detectar qual arquivo ficou para trás no boot seguinte.
			// Atualiza _v em TODOS os arquivos de módulo (mesmo os que não mudaram)
			// para manter consistência de versão entre todos os arquivos.
			for (const id of SPLIT_MODULE_IDS) {
				const slice = slices.get(id) ?? (await readFile<Record<string, unknown>>(absolute(moduleFilePath(id)))) ?? {};
				await writeFile(absolute(moduleFilePath(id)), { ...slice, [VERSION_KEY]: version });
			}
			const versionedMain = { ...stubSlices(main, SPLIT_MODULE_IDS), [VERSION_KEY]: version } as Record<string, unknown>;
			await writeFile(absolute("data.json"), versionedMain);
		},

		get readCorrupted() { return readCorrupted; },
		get corruptedPaths() { return corruptedPaths; },
		get lastVersion() { return detectedVersion; },
	};
}
