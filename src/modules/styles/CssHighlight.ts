/**
 * TOKENIZADOR DE CSS — PURO, SEM DOM
 * -----------------------------------
 * Realce de sintaxe leve para o editor livre do módulo de Estilos. A UI usa
 * a técnica clássica de overlay (textarea transparente sobre um <pre>
 * colorido), e esta regra pura alimenta o <pre> — separada do DOM para ser
 * testada contra o código real (padrão do projeto).
 *
 * INVARIANTE CRÍTICO: a concatenação dos tokens de cada linha, junta por
 * "\n", reproduz o TEXTO EXATO de entrada. Se um caractere sumir ou mudar
 * de lugar, o overlay desalinha do caret — é a propriedade mais importante
 * daqui, e é testada com entradas traiçoeiras (tabs, unicode, strings com
 * chaves e dois-pontos, comentários não fechados).
 *
 * HEURÍSTICA DE CONTEXTO: dentro de chaves (depth > 0), `palavra:` é
 * propriedade e identificadores soltos são valores; fora, tudo é seletor
 * (é o que distingue `a:hover` de `color: red`). Não é um parser de CSS —
 * é um realce: errar a COR em sintaxe exótica é aceitável; mover TEXTO,
 * não.
 */

export type CssTokenType =
	| "comment"
	| "selector"
	| "property"
	| "value"
	| "variable"
	| "string"
	| "atrule"
	| "punct"
	| "plain";

export interface CssToken {
	text: string;
	kind: CssTokenType;
}

/** Classe CSS do token na UI (`.tok-<classe>`), mapeada no styles.css. */
export function cssTokenTypeClass(kind: CssTokenType): string {
	return `tok-${kind}`;
}

interface TokenizerState {
	/** Profundidade de chaves — o que separa "propriedade/valor" de "seletor". */
	depth: number;
	/** Profundidade de parênteses — o prelúdio de @media()/@supports() também é contexto de valor. */
	parenDepth: number;
	inComment: boolean;
}

/**
 * Tokeniza o CSS inteiro e devolve UM ARRAY POR LINHA (a UI desenha linha a
 * linha). Uma linha vazia vira `[{ text: "", kind: "plain" }]` — o array
 * tem sempre exatamente `split("\n").length` entradas.
 */
export function tokenizeCss(text: string): CssToken[][] {
	const lines = text.split("\n");
	const state: TokenizerState = { depth: 0, parenDepth: 0, inComment: false };
	const result: CssToken[][] = [];

	for (const line of lines) {
		result.push(tokenizeLine(line, state));
	}
	return result;
}

function tokenizeLine(line: string, state: TokenizerState): CssToken[] {
	const tokens: CssToken[] = [];
	let rest = line;

	while (rest.length > 0) {
		if (state.inComment) {
			const end = rest.indexOf("*/");
			if (end === -1) {
				tokens.push({ text: rest, kind: "comment" });
				rest = "";
			} else {
				tokens.push({ text: rest.slice(0, end + 2), kind: "comment" });
				rest = rest.slice(end + 2);
				state.inComment = false;
			}
			continue;
		}

		// Consome código até o início de um comentário (ciente de strings:
		// "http://x/*" NÃO abre comentário).
		const commentIndex = scanCodeSegment(rest, state, tokens);
		if (commentIndex === -1) {
			rest = "";
		} else {
			const commentStart = rest.slice(commentIndex);
			const end = commentStart.indexOf("*/");
			if (end === -1) {
				// Comentário aberto que continua nas próximas linhas.
				tokens.push({ text: commentStart, kind: "comment" });
				rest = "";
				state.inComment = true;
			} else {
				tokens.push({ text: commentStart.slice(0, end + 2), kind: "comment" });
				rest = commentStart.slice(end + 2);
			}
		}
	}

	// Linha vazia (ou 100% consumida como quebra): token vazio para manter
	// o invariante "um array por linha do split".
	if (tokens.length === 0) tokens.push({ text: "", kind: "plain" });
	return tokens;
}

/**
 * Tokeniza o trecho de código (fora de comentário) até o fim da linha ou o
 * início de um `/*`. Devolve o índice do `/*` ou -1. Strings são
 * consumidas como um token só — `{`, `:` e `;` dentro de string não contam.
 * A profundidade de chaves é atualizada AQUI, na ordem em que os tokens
 * aparecem (o `color` de `body { color: red }` já vê depth > 0).
 */
function scanCodeSegment(segment: string, state: TokenizerState, out: CssToken[]): number {
	let plainStart = 0;
	let i = 0;

	const flushPlain = (upTo: number) => {
		if (upTo > plainStart) tokenizeCssRun(segment.slice(plainStart, upTo), state, out);
	};

	while (i < segment.length) {
		const ch = segment[i];
		if (ch === '"' || ch === "'") {
			const close = findStringClose(segment, i);
			flushPlain(i);
			out.push({ text: segment.slice(i, close + 1), kind: "string" });
			i = close + 1;
			plainStart = i;
			continue;
		}
		if (ch === "/" && segment[i + 1] === "*") {
			flushPlain(i);
			return i;
		}
		i++;
	}
	flushPlain(segment.length);
	return -1;
}

/** Índice da aspa que fecha a string aberta em `open` (consome escapes `\x`). */
function findStringClose(segment: string, open: number): number {
	const quote = segment[open];
	for (let i = open + 1; i < segment.length; i++) {
		if (segment[i] === "\\") {
			i++; // escapa o próximo caractere
			continue;
		}
		if (segment[i] === quote) return i;
	}
	return segment.length - 1; // string não fechada: vai até o fim da linha
}

/**
 * Ordem do regex define a precedência: at-rule > variável > hex > número >
 * propriedade (lookahead de `:`) > função (lookahead de `(`) > pontuação.
 * O que não casa vira "plain" (espaços, `.`, `>`, `*`, `!important` etc.).
 */
const CSS_TOKEN_RE =
	/(@[\w-]+)|(--[\w-]+)|(#[0-9a-fA-F]{3,8})|(\b\d+(?:\.\d+)?(?:px|em|rem|%|s|ms|vh|vw|fr|pt|ch|ex|deg)?)|([\w-]+(?=\s*:))|([\w-]+(?=\())|([{}:;,()])/g;

function tokenizeCssRun(run: string, state: TokenizerState, out: CssToken[]): void {
	CSS_TOKEN_RE.lastIndex = 0;
	let last = 0;
	for (const match of run.matchAll(CSS_TOKEN_RE)) {
		if (match.index > last) splitPlainRun(run.slice(last, match.index), state, out);
		const [text, atRule, variable, hex, number, propCandidate, funcCandidate, punct] = match;
		const inValueContext = state.depth > 0 || state.parenDepth > 0;
		if (atRule) out.push({ text, kind: "atrule" });
		else if (variable) out.push({ text, kind: "variable" });
		else if (hex) out.push({ text, kind: inValueContext ? "value" : "selector" });
		else if (number) out.push({ text, kind: inValueContext ? "value" : "selector" });
		else if (propCandidate) out.push({ text, kind: inValueContext ? "property" : "selector" });
		else if (funcCandidate) out.push({ text, kind: inValueContext ? "value" : "selector" });
		else if (punct) {
			out.push({ text, kind: "punct" });
			if (text === "{") state.depth++;
			else if (text === "}") state.depth = Math.max(0, state.depth - 1);
			else if (text === "(") state.parenDepth++;
			else if (text === ")") state.parenDepth = Math.max(0, state.parenDepth - 1);
		}
		last = match.index + text.length;
	}
	if (last < run.length) splitPlainRun(run.slice(last), state, out);
}

/** Palavra CSS: letras, dígitos, hífen e underscore (cobre --custom e classes BEM). */
const CSS_WORD_RE = /[\w-]+/g;

/**
 * Divide o que o regex principal não casou: palavras isoladas ganham a cor
 * do contexto (dentro de bloco/parêntese = valor — `red`, `bold`, o `hover`
 * nada a ver... de `a:hover`; fora = seletor — `.ione-hub-calendar__day`).
 * Espaços, pontos e demais pontuações ficam "plain". A divisão é pura
 * concatenação — o round-trip exato se mantém.
 */
function splitPlainRun(run: string, state: TokenizerState, out: CssToken[]): void {
	const inValueContext = state.depth > 0 || state.parenDepth > 0;
	CSS_WORD_RE.lastIndex = 0;
	let last = 0;
	for (const match of run.matchAll(CSS_WORD_RE)) {
		if (match.index > last) out.push({ text: run.slice(last, match.index), kind: "plain" });
		out.push({ text: match[0], kind: inValueContext ? "value" : "selector" });
		last = match.index + match[0].length;
	}
	if (last < run.length) out.push({ text: run.slice(last), kind: "plain" });
}
