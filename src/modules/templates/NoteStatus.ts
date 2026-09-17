/**
 * REGRAS DE STATUS DAS NOTAS — PURO, SEM DEPENDÊNCIA DO OBSIDIAN
 * ---------------------------------------------------------------
 * Extraído de TemplatesModule para poder ser testado fora do runtime do app.
 * Antes essas regras eram espelhadas À MÃO nos testes (ver o comentário de
 * tests/TemplateStatus.test.ts) — qualquer divergência entre cópia e real
 * passava despercebida. Agora os testes importam o código real daqui.
 *
 * Formato do frontmatter (decisão v0.6.0):
 *   - Nota pendente:   status: ["Pendente", "Completo"]
 *   - Nota completada: status: ["Completo"]
 * A razão de nascer com os DOIS valores está documentada em applyRuleToNote.
 */

/** Ainda tem o chip "Pendente"? Aceita lista ou string solta, qualquer capitalização. */
export function isPendingStatus(status: unknown): boolean {
	const values = Array.isArray(status) ? status : [status];
	return values.some((v) => typeof v === "string" && v.trim().toLowerCase() === "pendente");
}

/** Já está exatamente no formato normalizado de completada (["Completo"]). */
export function isNormalizedComplete(status: unknown): boolean {
	return (
		Array.isArray(status) &&
		status.length === 1 &&
		String(status[0]).trim().toLowerCase() === "completo"
	);
}

export interface PendingDecision {
	/** Regravar `status: ["Completo"]` no frontmatter. */
	rewriteStatus: boolean;
	/** Mover a nota de volta para a pasta de `origem`. */
	move: boolean;
}

/**
 * Decide o que fazer com uma nota que TEM `origem` e cujo status deixou de
 * conter "Pendente" (usuário removeu o chip, apagou o campo ou escreveu
 * "Completo" à mão). É a tradução direta das regras definidas no design:
 *   - sem `origem`            → nada (não é nota de template)
 *   - ainda pendente          → nada
 *   - já normalizada e na origem → nada (evita loop reescrevendo o mesmo valor)
 *   - caso contrário          → normaliza o status e/ou devolve à origem
 */
export function decidePendingAction(
	status: unknown,
	origem: string | undefined,
	currentPath: string
): PendingDecision {
	if (!origem) return { rewriteStatus: false, move: false };
	if (isPendingStatus(status)) return { rewriteStatus: false, move: false };

	const alreadyNormalized = isNormalizedComplete(status);
	if (origem === currentPath && alreadyNormalized) return { rewriteStatus: false, move: false };

	return { rewriteStatus: !alreadyNormalized, move: origem !== currentPath };
}
