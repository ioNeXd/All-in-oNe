/**
 * BUSCA NO VAULT (search_vault) — PURO, SEM VAULT E SEM HTTP
 * -----------------------------------------------------------
 * A busca original varria TODAS as notas com `vault.cachedRead` por chamada:
 * em vault grande, I/O massivo por tool call (mesmo com cache — a primeira
 * leitura de cada arquivo custa disco), travando a chamada inteira e
 * consumindo o rate limit com uma busca só. A mudança de estratégia:
 *
 *   1. metadataCache primeiro — path, tags e frontmatter já estão EM MEMÓRIA.
 *   2. Conteúdo só quando precisa — notas em que o query já casa no
 *      caminho/tag nem são lidas; as demais são lidas UMA por vez, e a
 *      varredura PARA no teto de resultados (não lê o resto do vault).
 *   3. Resposta enxuta — cada match vem com snippet, contagem e score;
 *      snippets longos são truncados (resposta pequena via HTTP).
 *
 * As regras de decisão vivem aqui, puras e testadas; o McpModule só fornece
 * os primitivos (lista de notas, cache, leitor) via callbacks — o mesmo
 * padrão de inversão de PendingSuggestions/NoteStatus.
 */

/** Teto de resultados por busca: busca útil não precisa de 10 mil matches. */
export const DEFAULT_MAX_RESULTS = 50;

/** Tamanho máximo do snippet devolvido por match (caracteres). */
export const SNIPPET_MAX_CHARS = 160;

export interface ScoredCandidate {
	path: string;
	/** Match direto no caminho do arquivo (case-insensitive). */
	pathMatch: boolean;
	/** Match em alguma tag do frontmatter/corpo (sem "#"). */
	tagMatch: boolean;
	/** Match em algum valor textual do frontmatter. */
	frontmatterMatch: boolean;
}

export interface SearchInput {
	query: string;
	maxResults?: number;
}

export interface SearchMatch {
	path: string;
	/** Contagem de ocorrências no conteúdo (0 quando casou só no path/tag/frontmatter). */
	hits: number;
	/** Trecho do conteúdo ao redor da primeira ocorrência ("" quando não houver no corpo). */
	snippet: string;
	/** Onde o query casou, em ordem de relevância. */
	matchedIn: ("path" | "tag" | "frontmatter" | "content")[];
}

export interface SearchOutcome {
	matches: SearchMatch[];
	/**
	 * true quando o teto interrompeu a varredura — havia mais candidatos
	 * por avaliar (o cliente pode repetir com maxResults maior ou refinar).
	 */
	truncated: boolean;
	/** Quantas notas foram avaliadas (lidas ou resolvidas sem leitura). */
	scanned: number;
}

/** Query vazio/whitespace não busca nada — evitar "matcha tudo". */
export function normalizeQuery(raw: unknown): string {
	return typeof raw === "string" ? raw.trim().toLowerCase() : "";
}

/** Stats de ocorrência de um termo num texto (ambos já em lowercase). */
export function countOccurrences(content: string, needle: string): number {
	if (!needle) return 0;
	let count = 0;
	let index = content.indexOf(needle);
	while (index !== -1) {
		count++;
		index = content.indexOf(needle, index + needle.length);
	}
	return count;
}

/** Trecho ao redor da primeira ocorrência, com contexto, truncado a SNIPPET_MAX_CHARS. */
export function buildSnippet(content: string, needle: string): string {
	if (!needle) return "";
	const index = content.toLowerCase().indexOf(needle);
	if (index === -1) return "";
	const start = Math.max(0, index - 40);
	const end = Math.min(content.length, index + needle.length + 40);
	const prefix = start > 0 ? "…" : "";
	const suffix = end < content.length ? "…" : "";
	let snippet = `${prefix}${content.slice(start, end).trim()}${suffix}`;
	if (snippet.length > SNIPPET_MAX_CHARS) snippet = `${snippet.slice(0, SNIPPET_MAX_CHARS - 1)}…`;
	return snippet;
}

/**
 * Score de um candidato SEM ler o conteúdo: o que já é decidível pelo
 * metadataCache. Quanto mais alto, mais cedo na fila de leitura.
 */
export function scoreCandidate(candidate: ScoredCandidate, query: string): number {
	if (!query) return -1;
	let score = 0;
	if (candidate.pathMatch) score += 4;
	if (candidate.tagMatch) score += 3;
	if (candidate.frontmatterMatch) score += 1;
	return score;
}

/**
 * Busca completa. Primitivos chegam por callbacks — este arquivo nunca
 * toca no vault:
 *   - listNotes(): todas as notas candidatas.
 *   - fileMeta(file): dados do metadataCache (tags/frontmatter como strings).
 *   - readContent(file): conteúdo do arquivo (só é chamado quando necessário).
 *
 * Ordem: candidatos com match fora do conteúdo primeiro (path/tag/frontmatter,
 * mais bem pontuados, SEM leitura), depois os demais por leitura — e a leitura
 * para no teto. `truncated` avisa que a varredura foi interrompida.
 */
export async function searchVault<F>(
	input: SearchInput,
	primitives: {
		listNotes: () => F[];
		fileMeta: (file: F) => { path: string; tags: string[]; frontmatterValues: string[] };
		readContent: (file: F) => Promise<string>;
	}
): Promise<SearchOutcome> {
	const query = normalizeQuery(input.query);
	if (!query) return { matches: [], truncated: false, scanned: 0 };

	const maxResults = input.maxResults ?? DEFAULT_MAX_RESULTS;
	const notes = primitives.listNotes();
	const deferred: { file: F; path: string; baseScore: number }[] = [];
	const matches: SearchMatch[] = [];
	let truncated = false;
	let scanned = 0;

	const accept = (match: SearchMatch): boolean => {
		if (matches.length >= maxResults) {
			truncated = true;
			return false;
		}
		matches.push(match);
		return true;
	};

	for (const file of notes) {
		const meta = primitives.fileMeta(file);
		scanned++;
		const pathMatch = meta.path.toLowerCase().includes(query);
		const tagMatch = meta.tags.some((t) => t.toLowerCase().includes(query));
		const frontmatterMatch = meta.frontmatterValues.some((v) => v.toLowerCase().includes(query));

		if (pathMatch || tagMatch || frontmatterMatch) {
			// Não precisa ler conteúdo: aceita agora, ordenado pela pontuação.
			const baseScore = scoreCandidate({ path: meta.path, pathMatch, tagMatch, frontmatterMatch }, query);
			const ok = accept({
				path: meta.path,
				hits: 0,
				snippet: "",
				matchedIn: [
					...(pathMatch ? (["path"] as const) : []),
					...(tagMatch ? (["tag"] as const) : []),
					...(frontmatterMatch ? (["frontmatter"] as const) : []),
				],
			});
			void baseScore;
			if (!ok) break;
		} else {
			// Sem match no cache: só a leitura decide — deixa para depois.
			deferred.push({ file, path: meta.path, baseScore: 0 });
		}
	}

	// Fase 2: leitura dos que o cache não resolveu — PARA no teto.
	for (const item of deferred) {
		if (matches.length >= maxResults) {
			truncated = true;
			break;
		}
		const content = (await primitives.readContent(item.file)).toLowerCase();
		const hits = countOccurrences(content, query);
		if (hits > 0) {
			const ok = accept({
				path: item.path,
				hits,
				snippet: buildSnippet(content, query),
				matchedIn: ["content"],
			});
			if (!ok) break;
		}
	}

	return { matches, truncated, scanned };
}
