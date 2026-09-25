/**
 * SUGESTÕES DE TEMPLATE PENDENTES — PURO, SEM DOM E SEM VAULT
 * -----------------------------------------------------------
 * Quando uma nota nasce numa pasta SEM regra, mas com nome de pasta
 * parecido com o de uma regra existente, o módulo de Templates guarda uma
 * sugestão para o painel oferecer ("aplicar esta regra?"). A lista vivia
 * direto no módulo e crescia sem teto: cada criação fora de regra empilhava
 * uma entrada, caminhos de notas apagadas/movidas ficavam stale e o
 * onDisable não limpatava nada — a memória só crescia enquanto o plugin
 * vivesse.
 *
 * As três regras de gestão vivem aqui, puras e testadas:
 *   - addSuggestion      → dedupe por path + teto (entra a mais recente).
 *   - removeSuggestion   → remove por path (aplicar/dispençar no painel).
 *   - validSuggestions   → filtra caminhos/regras que não existem mais.
 *
 * "Path existe?" e "regra existe?" chegam como predicados — este arquivo
 * não conhece vault nem settings (padrão NoteStatus.ts / lobbyOrder.ts:
 * regra de decisão sem I/O = testável sem mock).
 */

/** Teto da fila: sugestões antigas demais perdem a utilidade (a nota já foi organizada à mão). */
export const MAX_PENDING_SUGGESTIONS = 20;

export interface PendingSuggestion {
	path: string;
	suggestedRuleId: string;
}

/**
 * Adiciona uma sugestão devolvendo a lista NOVA (nunca muta a entrada):
 *   - mesma `path` já na fila → substitui (regra sugerida pode ter mudado);
 *   - passa do teto          → as mais ANTIGAS saem, a mais recente fica.
 * `added` diz se a fila mudou de fato — o chamador só emite o evento de
 * sugestão quando for novo/substituído, sem repetir para recriações.
 */
export function addSuggestion(
	list: readonly PendingSuggestion[],
	entry: PendingSuggestion,
	max = MAX_PENDING_SUGGESTIONS
): { list: PendingSuggestion[]; added: boolean } {
	if (!Number.isInteger(max) || max < 1) throw new RangeError("max deve ser um inteiro >= 1");
	const withoutSamePath = list.filter((x) => x.path !== entry.path);
	const wasThere = withoutSamePath.length !== list.length;
	const sameRuleThere = wasThere && list.find((x) => x.path === entry.path)?.suggestedRuleId === entry.suggestedRuleId;
	if (sameRuleThere) {
		// Idêntica à que já está: nada muda, nem ordem (evita evento repetido).
		return { list: [...list], added: false };
	}
	const next = [...withoutSamePath, entry];
	// Teto: descarta do INÍCIO (as mais antigas), preserva a mais recente.
	return { list: next.slice(Math.max(0, next.length - max)), added: true };
}

/** Remove a sugestão daquela path (o painel aplicou ou o usuário dispensou). */
export function removeSuggestion(
	list: readonly PendingSuggestion[],
	path: string
): PendingSuggestion[] {
	return list.filter((x) => x.path !== path);
}

/**
 * Filtra entradas cujo caminho ou regra sugerida deixaram de existir
 * (nota movida/apagada, regra removida). Chamado na hora de renderizar o
 * painel — a fila nunca oferece uma ação que vai falhar.
 */
export function validSuggestions(
	list: readonly PendingSuggestion[],
	predicates: {
		pathExists: (path: string) => boolean;
		ruleExists: (ruleId: string) => boolean;
	}
): PendingSuggestion[] {
	return list.filter(
		(x) => predicates.pathExists(x.path) && predicates.ruleExists(x.suggestedRuleId)
	);
}
