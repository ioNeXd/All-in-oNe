import { App, TFolder } from "obsidian";
import { uniqueNameWith } from "./PathUtils";

/**
 * Helpers de vault compartilhados pelo núcleo e pelos módulos.
 *
 * Extraído das 4 cópias de `ensureFolder` e das 3 cópias de `uniquePath`
 * espalhadas pelos módulos (Templates, Calendário, Ciclo de Vida e
 * Onboarding). As cópias tinham **drift**: a versão do FileLifecycle
 * filtrava segmentos vazios (`filter(Boolean)`) e as outras não — aqui
 * vale o comportamento mais defensivo.
 */

/**
 * Cria `path` segmento a segmento — `vault.createFolder` NÃO cria
 * pastas-pai, então um caminho aninhado passado direto falhava em
 * silêncio (bug do onboarding). O `.catch` cobre só a corrida benigna
 * "pasta criada entre o check e o create"; o TFolder antes de criar
 * evita erro de "já existe".
 */
export async function ensureVaultFolder(app: App, path: string): Promise<void> {
	if (!path || path === "/") return;
	let current = "";
	for (const segment of path.split("/").filter(Boolean)) {
		current = current ? `${current}/${segment}` : segment;
		const node = app.vault.getAbstractFileByPath(current);
		if (!(node instanceof TFolder)) {
			try {
				await app.vault.createFolder(current);
			} catch (error) {
				// Only swallow the benign TOCTOU case where another writer created
				// this exact folder between the existence check and createFolder.
				const after = app.vault.getAbstractFileByPath(current);
				if (!(after instanceof TFolder)) throw error;
			}
		}
	}
}

/**
 * Primeiro caminho livre derivado de `desired` — "Nota.md" existente
 * vira "Nota 2.md". A regra de colisão mora em `uniqueNameWith`
 * (PathUtils), testada sem vault.
 */
export function uniqueVaultPath(app: App, desired: string): string {
	return uniqueNameWith(desired, (p) => !!app.vault.getAbstractFileByPath(p));
}
