/**
 * UTILIDADES DE RELEASE — PURO, SEM DEPENDÊNCIA DO OBSIDIAN
 * ----------------------------------------------------------
 * Comparação SemVer e parsing de checksums do corpo do release. Extraído do
 * AutoUpdateModule para ser testável fora do runtime do app.
 */

/**
 * Compara duas versões "major.minor.patch[-pré]".
 *   - Segmentos numéricos faltantes contam como 0 ("0.2" == "0.2.0").
 *   - Pré-lançamento é MAIS ANTIGO que o release do mesmo número base
 *     (regra do SemVer: 0.3.0-beta.1 < 0.3.0) — evita "atualizar" de uma
 *     estável 0.3.0 para uma beta 0.3.0-beta.1.
 * Retorna negativo se a < b, 0 se iguais, positivo se a > b.
 */
export function compareVersions(a: string, b: string): number {
	const splitPrerelease = (v: string): { base: string; pre?: string } => {
		const dash = v.indexOf("-");
		return dash === -1 ? { base: v } : { base: v.slice(0, dash), pre: v.slice(dash + 1) };
	};
	const parseNums = (base: string): number[] =>
		base.split(".").map((seg) => {
			const n = parseInt(seg, 10);
			return Number.isFinite(n) ? n : 0;
		});

	const A = splitPrerelease(a);
	const B = splitPrerelease(b);
	const na = parseNums(A.base);
	const nb = parseNums(B.base);

	for (let i = 0; i < Math.max(na.length, nb.length); i++) {
		const diff = (na[i] ?? 0) - (nb[i] ?? 0);
		if (diff !== 0) return diff;
	}

	// Bases iguais: quem TEM sufixo de pré-lançamento é mais antigo.
	if (A.pre && !B.pre) return -1;
	if (!A.pre && B.pre) return 1;
	if (A.pre && B.pre) {
		if (A.pre === B.pre) return 0;
		return A.pre < B.pre ? -1 : 1; // comparação lexicográfica simples do sufixo
	}
	return 0;
}

/** true SOMENTE se `remote` é estritamente mais nova que `current`. */
export function isNewerVersion(remote: string, current: string): boolean {
	return compareVersions(remote, current) > 0;
}

/**
 * Lê checksums declarados no corpo do release, em linhas no formato:
 *   `sha256 main.js: <hash>`  (ou `=`)
 * Se o release não declarar nenhum, a verificação é simplesmente pulada
 * (não é obrigatório — mas quando existe, precisa bater).
 */
export function parseChecksums(body: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const line of (body ?? "").split("\n")) {
		const match = line.match(/sha256\s+([\w.\-]+)\s*[:=]\s*([a-fA-F0-9]{64})/);
		if (match) result[match[1]] = match[2];
	}
	return result;
}
