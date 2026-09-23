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
 * O merge é transparente para módulos e para o resto do núcleo: quem chama
 * updateModuleSettings continua falando com o SettingsManager; o manager
 * delega ao handle O ARQUIVO DA FATIA tocada. Perfis, migração de schema e
 * reset continuam no principal — o reset de config zera também os arquivos
 * por módulo (via save() com stubs, persistModule cobre as fatias).
 *
 * Os arquivos vivem na PASTA DO PLUGIN (`<vault>/.obsidian/plugins/<id>/`) —
 * fora do vault do usuário, não poluem o sync das notas e seguem no mesmo
 * lugar do data.json.
 */

export const MODULES_DIR = "data.modules";

/** Módulos cuja fatia vai para arquivo próprio (os de write-behind pesado). */
export const SPLIT_MODULE_IDS = ["history", "notifications"] as const;

export interface SplitPersistenceHandle {
	/** data.json inteiro, SEM as fatias splitadas (stubs `{}` no lugar). */
	loadMain: () => Promise<HubSettings | null>;
	persistMain: (data: HubSettings) => Promise<void>;
	/** Fatia do módulo — null se o arquivo ainda não existe. */
	loadModule: (moduleId: string) => Promise<Record<string, unknown> | null>;
	persistModule: (moduleId: string, slice: Record<string, unknown>) => Promise<void>;
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

	const readFile = async <T>(path: string): Promise<T | null> => {
		try {
			if (!(await adapter.exists(path))) return null;
			return JSON.parse(await adapter.read(path)) as T;
		} catch {
			return null; // ausente/ilegível/corrompido: tratado como "não salvo"
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
			const main = await readFile<HubSettings>(absolute("data.json"));
			if (!main) return null;
			// Reconstitui as fatias a partir dos arquivos por módulo:
			const modules: Record<string, Record<string, unknown>> = { ...main.modules };
			for (const id of SPLIT_MODULE_IDS) {
				modules[id] = (await readFile<Record<string, unknown>>(absolute(moduleFilePath(id)))) ?? {};
			}
			return { ...createDefaultSettings(), ...main, modules };
		},
		persistMain: async (data) => {
			await writeFile(absolute("data.json"), stubSlices(data, SPLIT_MODULE_IDS));
		},
		loadModule: (moduleId) => readFile(absolute(moduleFilePath(moduleId))),
		persistModule: (moduleId, slice) => writeFile(absolute(moduleFilePath(moduleId)), slice),
	};
}
