/**
 * FILTRO COMBINADO DO HISTÓRICO — PURO, SEM DOM
 * ----------------------------------------------
 * O painel do Histórico filtrava só pelo tipo de evento (o <select> de
 * TRACKED_EVENTS, com a filtragem inline no renderSettingsPanel). Este
 * arquivo concentra a regra nova — busca por texto livre em message/path,
 * COMBINÁVEL com o filtro de tipo — como função pura ao lado do módulo
 * (padrão do projeto: NotificationList, CssHighlight), testada contra o
 * código real.
 *
 * A busca é case-insensitive E sem acento: o usuário digita "reuniao" e
 * encontra "Reunião". Tudo é comparado sobre uma forma normalizada
 * (minúsculas, decomposta, sem diacríticos) — mesma normalização dos dois
 * lados, nunca comparação bruta.
 */

/** Campos usados pela busca — todo HistoryEntryRecord satisfaz. */
export interface HistorySearchableEntry {
	event: string;
	message: string;
	path?: string;
}

/**
 * Forma normalizada de comparação: minúsculas + sem diacríticos.
 * NFD decompõe "ã" em "a" + combining tilde; \p{Diacritic} remove o acento.
 */
export function normalizeSearchText(value: string): string {
	return value
		.toLowerCase()
		.normalize("NFD")
		.replace(/\p{Diacritic}/gu, "");
}

/**
 * A query digitada vira a agulha da busca: espaços das bordas descartados
 * (digitos acidentais no fim do campo não podem zerar a lista) e
 * normalizada igual ao palheiro. String vazia = não filtra por texto.
 */
export function parseSearchQuery(query: string): string {
	return normalizeSearchText(query.trim());
}

function entryMatchesSearch(entry: HistorySearchableEntry, needle: string): boolean {
	// path é opcional no registro — ausente, só o message decide.
	return [entry.message, entry.path ?? ""].some((haystack) =>
		normalizeSearchText(haystack).includes(needle)
	);
}

/**
 * Filtro combinado: tipo de evento ("" = todos) + busca por texto em
 * message/path ("" = tudo). Ambos os critérios se somam (E lógico).
 * Preserva a ordem de entrada (mais recente primeiro, como o módulo
 * guarda) — filtrar nunca reordena.
 */
export function filterHistoryEntries<T extends HistorySearchableEntry>(
	entries: T[],
	eventFilter: string,
	searchQuery: string
): T[] {
	const byEvent = eventFilter ? entries.filter((e) => e.event === eventFilter) : entries;
	const needle = parseSearchQuery(searchQuery);
	if (needle === "") return byEvent;
	return byEvent.filter((entry) => entryMatchesSearch(entry, needle));
}
