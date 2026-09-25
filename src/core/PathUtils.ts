/**
 * Utilitários puros de caminho — sem dependência do Obsidian.
 *
 * Extraído das cópias idênticas de `uniquePath` em TemplatesModule,
 * CalendarModule e FileLifecycleModule (fatoração, sem mudança de
 * comportamento). A função de existência é injetada, o que permite
 * testar sem vault.
 *
 * CORREÇÃO R2: centraliza normalização e validação defensiva de paths.
 * Rejeita paths vazios, com `..`, absolutos ou que escapem do vault.
 */

/**
 * Deriva o primeiro nome livre a partir de `desired`, acrescentando
 * " 2", " 3", ... antes da extensão.
 */
export function uniqueNameWith(
	desired: string,
	exists: (path: string) => boolean
): string {
	if (!exists(desired)) return desired;
	const dot = desired.lastIndexOf(".");
	const base = dot === -1 ? desired : desired.slice(0, dot);
	const ext = dot === -1 ? "" : desired.slice(dot);
	let counter = 2;
	while (exists(`${base} ${counter}${ext}`)) counter++;
	return `${base} ${counter}${ext}`;
}

/**
 * Normaliza um path externo para uso seguro dentro do vault.
 * Aplica as mesmas regras em todas as operações MCP que recebem paths.
 *
 * Regras:
 *   1. Remove espaços no início/fim.
 *   2. Normaliza separadores para `/` (Windows `\` → `/`).
 *   3. Colapsa `//` múltiplos em `/`.
 *   4. Rejeita paths vazios ou somente whitespace.
 *   5. Rejeita paths absolutos (`/...` ou `C:\...`).
 *   6. Rejeita segmentos `..` (tentativa de escape do vault).
 *   7. Rejeita paths com caracteres de controle.
 *   8. Remove `.` (diretório atual) no início.
 *
 * @param raw Path bruto recebido de fonte externa.
 * @returns Path normalizado e validado.
 * @throws Error com mensagem clara se o path for inválido.
 */
export function validateVaultPath(raw: string): string {
	if (typeof raw !== "string") {
		throw new Error("Path deve ser uma string.");
	}

	const trimmed = raw.trim();
	if (trimmed.length === 0) {
		throw new Error("Path não pode ser vazio.");
	}

	// Normaliza separadores.
	let normalized = trimmed.replace(/\\/g, "/");

	// Colapsa slashes múltiplos (preserva o slash inicial se houver).
	normalized = normalized.replace(/\/{2,}/g, "/");

	// Remove ./ no início (diretório atual implícito), inclusive repetições.
	while (normalized.startsWith("./")) normalized = normalized.slice(2);
	if (normalized === "." || normalized.length === 0) {
		throw new Error("Path não pode apontar apenas para o diretório atual.");
	}

	// Rejeita paths absolutos ( Unix: /...  Windows: C:\... ).
	if (/^[a-zA-Z]:/.test(normalized) || normalized.startsWith("/")) {
		throw new Error(
			`Path inválido: "${raw}" — paths absolutos não são permitidos. Use um caminho relativo ao vault.`
		);
	}

	// Rejeita somente segmentos de diretório ".."; nomes legítimos como
	// "relatorio..final.md" não representam traversal e devem ser aceitos.
	if (normalized.split("/").some((segment) => segment === "..")) {
		throw new Error(
			`Path inválido: "${raw}" — referências a diretório pai (..) não são permitidas.`
		);
	}

	// Rejeita caracteres de controle ASCII (0x00-0x1F e DEL 0x7F).
	if (/[\x00-\x1f\x7f]/.test(normalized)) {
		throw new Error(
			`Path inválido: "${raw}" — contém caracteres de controle.`
		);
	}

	// Remove trailing slash (pastas não precisam de / final em paths de arquivo).
	if (normalized.endsWith("/") && normalized.length > 1) {
		normalized = normalized.slice(0, -1);
	}

	return normalized;
}

/**
 * Valida que um path não escapa de um diretório base (vault root).
 * Útil para operações que operam sobre paths derivados de inputs do usuário
 * onde o path pode ser construído programaticamente.
 */
export function isPathWithinBase(path: string, base: string): boolean {
	const normalizedPath = path.replace(/\\/g, "/").toLowerCase();
	const normalizedBase = base.replace(/\\/g, "/").toLowerCase();
	// Rejeita paths com .. — não é seguro inferir se "escapam" sem resolver
	// os .. primeiro. Se o caller quer validação, use validateVaultPath antes.
	if (normalizedPath.includes("..")) return false;
	const baseWithSlash = normalizedBase.endsWith("/") ? normalizedBase : normalizedBase + "/";
	return normalizedPath === normalizedBase || normalizedPath.startsWith(baseWithSlash);
}
