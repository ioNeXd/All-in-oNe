/**
 * ORDEM DOS MÓDULOS NO LOBBY — PURO, SEM DOM
 * -------------------------------------------
 * O Lobby listava os módulos sempre na ordem de registro (`main.ts`) — o
 * usuário não podia pôr o que mais usa no topo. Este arquivo concentra as
 * duas regras da reordenação (drag-and-drop na barra lateral e Alt+↑/↓ com
 * o item focado) como funções puras, testadas contra o código real.
 *
 * A ordem vive em `settings.lobby.moduleOrder` (lista de ids). A lista PODE
 * ficar parcial/defasada: módulos novos (não citados) entram no fim, na
 * ordem natural; ids que não existem mais são ignorados — nunca viram
 * linhas fantasmas.
 */

/** O mínimo que a regra precisa saber de um módulo. */
export interface OrderableModule {
	manifest: { id: string };
}

/**
 * Módulos na ordem salva. Sem ordem (campo novo em settings antigos),
 * devolve a ordem natural — o default é hoje, não uma mudança silenciosa.
 */
export function orderedModules<T extends OrderableModule>(
	modules: readonly T[],
	order: readonly string[] | undefined
): T[] {
	if (!order || order.length === 0) return [...modules];
	const byId = new Map(modules.map((m) => [m.manifest.id, m]));
	const result: T[] = [];
	for (const id of order) {
		const mod = byId.get(id);
		if (mod) {
			result.push(mod);
			byId.delete(id);
		}
		// id sem módulo correspondente: ignorado (nunca vira linha fantasma)
	}
	// Módulos novos (não citados na ordem salva) entram no fim, na ordem natural.
	result.push(...byId.values());
	return result;
}

/**
 * Move `source` para imediatamente ANTES de `target` (drag-and-drop: soltar
 * em cima da linha de destino). Ambos os sentidos funcionam ajustando o índice
 * do destino quando o source está antes dele.
 */
export function moveBefore(order: readonly string[], source: string, target: string): string[] {
	const next = [...order];
	const from = next.indexOf(source);
	const to = next.indexOf(target);
	if (from === -1 || to === -1 || from === to) return next;
	const targetIndex = from < to ? to - 1 : to;
	const [moved] = next.splice(from, 1);
	next.splice(targetIndex, 0, moved);
	return next;
}

/**
 * Move `id` por `delta` posições na ordem (normalizada) e devolve a lista
 * NOVA — nunca muta a entrada (a gravação em settings é async e pode falhar;
 * a UI não pode ter mutado estado como se tivesse gravado).
 */
export function moveModuleId(
	order: readonly string[] | undefined,
	id: string,
	delta: -1 | 1,
	allIds: readonly string[]
): string[] {
	// allIds JÁ são os módulos que existem — a normalização é: os citados na
	// ordem salva (na ordem dela) primeiro, os ausentes no fim.
	const known = [...allIds];
	const normalized = [
		...(order ?? []).filter((o) => known.includes(o)),
		...known.filter((k) => !(order ?? []).includes(k)),
	];
	if (!normalized.includes(id)) {
		// Id fora da lista (item nunca ordenado antes): entra no fim antes de mover.
		normalized.push(id);
	}
	const from = normalized.indexOf(id);
	const to = from + delta;
	if (to < 0 || to >= normalized.length) return normalized; // borda: não move
	const next = [...normalized];
	next.splice(to, 0, ...next.splice(from, 1));
	return next;
}
