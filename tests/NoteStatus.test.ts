import { describe, it, expect } from "vitest";
import {
	isPendingStatus,
	isNormalizedComplete,
	decidePendingAction,
} from "../src/modules/templates/NoteStatus";

/**
 * IMPORTA O CÓDIGO REAL (NoteStatus.ts), não uma cópia espelhada — ao
 * contrário de tests/TemplateStatus.test.ts, que reimplementa as regras à
 * mão e pode divergir do módulo sem ninguém perceber.
 */

describe("isPendingStatus (formato v0.6.0: lista com os 2 valores)", () => {
	it("reconhece a lista ['Pendente', 'Completo'] como pendente", () => {
		expect(isPendingStatus(["Pendente", "Completo"])).toBe(true);
	});

	it("reconhece a lista normalizada ['Completo'] como NÃO pendente", () => {
		expect(isPendingStatus(["Completo"])).toBe(false);
	});

	it("aceita a forma antiga em texto simples", () => {
		expect(isPendingStatus("Pendente")).toBe(true);
		expect(isPendingStatus("pendente")).toBe(true);
		expect(isPendingStatus(" PENDENTE ")).toBe(true);
	});

	it("aceita texto/lista com capitalização qualquer", () => {
		expect(isPendingStatus(["PENDENTE", "Completo"])).toBe(true);
		expect(isPendingStatus(["Completo", "pendente"])).toBe(true);
	});

	it("retorna false para status ausente ou de outro valor", () => {
		expect(isPendingStatus(undefined)).toBe(false);
		expect(isPendingStatus(null)).toBe(false);
		expect(isPendingStatus("")).toBe(false);
		expect(isPendingStatus(["Em progresso"])).toBe(false);
		expect(isPendingStatus(42)).toBe(false);
	});
});

describe("isNormalizedComplete", () => {
	it("só aceita exatamente ['Completo'] (lista de 1)", () => {
		expect(isNormalizedComplete(["Completo"])).toBe(true);
		expect(isNormalizedComplete(["completo"])).toBe(true);
		expect(isNormalizedComplete("Completo")).toBe(false); // string solta não é o formato normalizado
		expect(isNormalizedComplete(["Pendente", "Completo"])).toBe(false);
		expect(isNormalizedComplete(undefined)).toBe(false);
		expect(isNormalizedComplete(["Completo", "Completo"])).toBe(false);
	});
});

describe("decidePendingAction — o que fazer quando 'Pendente' saiu do status", () => {
	const origem = "Estudos/Matematica/nota.md";
	const pendente = "Estudos/Pendente/nota.md";

	it("sem 'origem' no frontmatter: não é nota de template — não faz nada", () => {
		expect(decidePendingAction(["Completo"], undefined, pendente)).toEqual({
			rewriteStatus: false,
			move: false,
		});
	});

	it("ainda pendente: não faz nada", () => {
		expect(decidePendingAction(["Pendente", "Completo"], origem, pendente)).toEqual({
			rewriteStatus: false,
			move: false,
		});
	});

	it("completada e fora da origem: normaliza o status E move", () => {
		expect(decidePendingAction(["Pendente", "Completo"], origem, pendente)).toEqual({
			rewriteStatus: false,
			move: false,
		});
		// ...com o status JÁ sem "Pendente":
		expect(decidePendingAction(["Completo"], origem, pendente)).toEqual({
			rewriteStatus: false,
			move: true,
		});
	});

	it("completada com texto escrito à mão: normaliza E move", () => {
		expect(decidePendingAction("completo", origem, pendente)).toEqual({
			rewriteStatus: true,
			move: true,
		});
	});

	it("status removido por inteiro (usuário apagou a propriedade): normaliza E move", () => {
		expect(decidePendingAction(undefined, origem, pendente)).toEqual({
			rewriteStatus: true,
			move: true,
		});
	});

	it("já normalizada e NA origem: nada a fazer (evita loop regravando o mesmo valor)", () => {
		expect(decidePendingAction(["Completo"], origem, origem)).toEqual({
			rewriteStatus: false,
			move: false,
		});
	});

	it("normalizada mas ainda na pasta Pendente: só move, sem regravar", () => {
		expect(decidePendingAction(["Completo"], origem, pendente)).toEqual({
			rewriteStatus: false,
			move: true,
		});
	});

	it("não normalizada e já na origem: só regravar, sem mover", () => {
		expect(decidePendingAction("completo", origem, origem)).toEqual({
			rewriteStatus: true,
			move: false,
		});
	});
});
