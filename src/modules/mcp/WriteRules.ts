/**
 * REGRAS DE PERMISSÃO DE ESCRITA DO MCP — PURO, SEM DEPENDÊNCIA DO OBSIDIAN
 * --------------------------------------------------------------------------
 * A lógica de fronteira de pasta é exatamente o tipo de regra que um furo de
 * segurança mora: valer a pena testá-la contra o código REAL, não contra uma
 * cópia espelhada. A normalização dos caminhos continua sendo feita pelo
 * `normalizePath` do Obsidian (case-insensitive por sistema de arquivos) —
 * este módulo recebe os caminhos JÁ normalizados e decide a fronteira.
 */

/**
 * Compatibilidade de pasta com fronteira de segmento:
 *   - pathMatchesFolder("Pai/Filho/nota.md", "Pai")  → true  (está dentro)
 *   - pathMatchesFolder("Pai", "Pai")                → true  (é a própria pasta)
 *   - pathMatchesFolder("Pai2/nota.md", "Pai")       → FALSE (o startsWith
 *     cru aceitava — furo: escrever em "Secretas2" burlaria a blocklist de
 *     "Secretas")
 */
export function pathMatchesFolder(normalizedPath: string, normalizedBase: string): boolean {
	const base = normalizedBase.replace(/\/+$/, "");
	if (!base) return false;
	return normalizedPath === base || normalizedPath.startsWith(base + "/");
}

/**
 * Todos os caminhos que uma chamada MCP pode TOCAR ao executar uma
 * ferramenta de escrita. rename_note escreve em args.newPath e combine_notes
 * em args.targetPath — checar só args.path permitia mover notas para dentro
 * de pasta bloqueada. A ordem define a mensagem de erro (primeiro negado).
 */
export function collectWriteTargets(args: Record<string, unknown>): string[] {
	return ["path", "newPath", "targetPath"]
		.map((k) => (args[k] === undefined || args[k] === null ? "" : String(args[k])))
		.filter(Boolean);
}
