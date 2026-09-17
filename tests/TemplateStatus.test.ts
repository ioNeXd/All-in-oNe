import { describe, it, expect } from "vitest";

/**
 * Regra de transição de status das notas, espelhando TemplatesModule.
 *
 * v0.6.0: `status` nasce com os DOIS valores (["Pendente", "Completo"]).
 * O usuário completa a nota clicando no X do chip "Pendente" no painel de
 * Propriedades do Obsidian — sobra só "Completo", que é o gatilho para
 * devolver a nota à origem. Isso evita depender de "lista vazia" (o
 * Obsidian às vezes remove a propriedade inteira quando o último item de
 * uma lista é apagado, o que quebraria a detecção).
 */
function isStillPending(status: unknown): boolean {
	const values = Array.isArray(status) ? status : [status];
	return values.some((v) => typeof v === "string" && v.trim().toLowerCase() === "pendente");
}

function isNormalizedComplete(status: unknown): boolean {
	return Array.isArray(status) && status.length === 1 && String(status[0]).toLowerCase() === "completo";
}

function decideAction(fm: Record<string, unknown>, currentPath: string) {
	const origem = typeof fm.origem === "string" ? fm.origem : undefined;
	if (!origem) return { rewriteStatus: false, move: false };
	if (isStillPending(fm.status)) return { rewriteStatus: false, move: false };

	const alreadyNormalized = isNormalizedComplete(fm.status);
	if (origem === currentPath && alreadyNormalized) return { rewriteStatus: false, move: false };

	return { rewriteStatus: !alreadyNormalized, move: origem !== currentPath };
}

describe("transição de status das notas de template (modelo com os 2 valores)", () => {
	const origem = "Estudos/Matematica/nota.md";
	const pendente = "Estudos/Pendente/nota.md";

	it("nasce com os dois valores e não faz nada enquanto 'Pendente' está presente", () => {
		expect(decideAction({ status: ["Pendente", "Completo"], origem }, pendente)).toEqual({
			rewriteStatus: false,
			move: false,
		});
	});

	it('clicar no X do chip "Pendente" deixa só ["Completo"] e devolve a nota', () => {
		expect(decideAction({ status: ["Completo"], origem }, pendente)).toEqual({
			rewriteStatus: false, // já está exatamente no formato esperado
			move: true,
		});
	});

	it("campo removido por completo também conta como concluído", () => {
		expect(decideAction({ origem }, pendente)).toEqual({ rewriteStatus: true, move: true });
	});

	it("lista vazia (variação do Obsidian ao remover o último item) também conta", () => {
		expect(decideAction({ status: [], origem }, pendente)).toEqual({ rewriteStatus: true, move: true });
	});

	it('escrever "completo" como texto solto também funciona (compatibilidade)', () => {
		expect(decideAction({ status: "completo", origem }, pendente)).toEqual({
			rewriteStatus: true, // normaliza para a lista ["Completo"]
			move: true,
		});
	});

	it("não faz nada (nem rewrite nem move) quando já está normalizado na própria origem", () => {
		expect(decideAction({ status: ["Completo"], origem }, origem)).toEqual({
			rewriteStatus: false,
			move: false,
		});
	});

	it("aceita variação de caixa em 'pendente'", () => {
		expect(decideAction({ status: ["PENDENTE", "Completo"], origem }, pendente).move).toBe(false);
	});
});
