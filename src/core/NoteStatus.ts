/** Regras canônicas de conclusão de notas por template. */

/** Status usado enquanto a nota ainda não foi concluída. */
export const STATUS_PENDING_INITIAL = ["Incompleto"] as const;

/** Status normalizado de uma nota concluída. */
export const STATUS_COMPLETE_NORMALIZED = ["Completo"] as const;
export const STATUS_COMPLETE = "Completo";

export interface CompletionDecision {
	rewriteStatus: boolean;
	move: boolean;
}

/** Decide a transição quando concluido já é true. */
export function decideCompletionAction(origem: string | undefined, currentPath: string): CompletionDecision {
	if (!origem) return { rewriteStatus: false, move: false };
	return { rewriteStatus: true, move: origem !== currentPath };
}

export function isNormalizedComplete(status: unknown): boolean {
	return Array.isArray(status) && status.length === 1 && String(status[0]).trim().toLowerCase() === "completo";
}

/** Considera pendente uma nota ainda não concluída; aceita o formato legado para migração gradual. */
export function isPendingStatus(status: unknown): boolean {
	const values = Array.isArray(status) ? status : [status];
	return values.some((value) => {
		const normalized = String(value ?? "").trim().toLowerCase();
		return normalized === "incompleto" || normalized === "pendente";
	});
}

/** Compatibilidade temporária para consumidores antigos. */
export const decidePendingAction = (status: unknown, origem: string | undefined, currentPath: string): CompletionDecision => {
	void status;
	return decideCompletionAction(origem, currentPath);
}