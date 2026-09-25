import { describe, it, expect } from "vitest";
import {
	addSuggestion,
	removeSuggestion,
	validSuggestions,
	MAX_PENDING_SUGGESTIONS,
	type PendingSuggestion,
} from "../src/modules/templates/PendingSuggestions";

/**
 * Regras da fila de sugestões do módulo de Templates (dedupe por path,
 * teto, filtro de entradas stale). Puro — importam o código real, sem
 * vault nem DOM (padrão NoteStatus.ts / lobbyOrder.ts).
 */

const s = (path: string, suggestedRuleId = "r1"): PendingSuggestion => ({ path, suggestedRuleId });

describe("addSuggestion — dedupe por path", () => {
	it("adiciona numa lista vazia", () => {
		const { list, added } = addSuggestion([], s("a.md"));
		expect(list).toEqual([s("a.md")]);
		expect(added).toBe(true);
	});

	it("path repetida com a MESMA regra: não duplica nem marca como nova", () => {
		const list = [s("a.md"), s("b.md", "r2")];
		const { list: next, added } = addSuggestion(list, s("a.md"));
		expect(next).toEqual(list);
		expect(added).toBe(false);
	});

	it("path repetida com regra DIFERENTE: substitui (e vai para o fim)", () => {
		const list = [s("a.md", "r1"), s("b.md", "r2")];
		const { list: next, added } = addSuggestion(list, s("a.md", "r9"));
		expect(next).toEqual([s("b.md", "r2"), s("a.md", "r9")]);
		expect(added).toBe(true);
	});

	it("não muta a lista de entrada", () => {
		const list = [s("a.md")];
		addSuggestion(list, s("b.md"));
		expect(list).toEqual([s("a.md")]);
	});
});

describe("addSuggestion — teto", () => {
	it("passa do teto: as mais ANTIGAS saem, a mais recente fica", () => {
		let list: PendingSuggestion[] = [];
		for (let i = 0; i < MAX_PENDING_SUGGESTIONS + 5; i++) {
			list = addSuggestion(list, s(`n${i}.md`, `r${i}`)).list;
		}
		// 25 entradas (MAX+5) no teto 20: as 5 mais antigas (n0..n4) saem;
		// a primeira mantida é n5 e a última é n24.
		expect(list).toHaveLength(MAX_PENDING_SUGGESTIONS);
		expect(list[0].path).toBe("n5.md");
		expect(list[list.length - 1].path).toBe(`n${MAX_PENDING_SUGGESTIONS + 4}.md`);
	});

	it("rejeita teto zero, negativo e fracionário", () => {
		expect(() => addSuggestion([], s("a.md"), 0)).toThrow(RangeError);
		expect(() => addSuggestion([], s("a.md"), -1)).toThrow(RangeError);
		expect(() => addSuggestion([], s("a.md"), 1.5)).toThrow(RangeError);
	});

	it("respeita um teto menor passado por parâmetro", () => {
		let list: PendingSuggestion[] = [];
		for (let i = 0; i < 5; i++) list = addSuggestion(list, s(`n${i}.md`), 3).list;
		expect(list).toHaveLength(3);
		expect(list.map((x) => x.path)).toEqual(["n2.md", "n3.md", "n4.md"]);
	});
});

describe("removeSuggestion", () => {
	it("remove só a path pedida", () => {
		const list = [s("a.md"), s("b.md", "r2"), s("c.md", "r3")];
		expect(removeSuggestion(list, "b.md")).toEqual([s("a.md"), s("c.md", "r3")]);
	});

	it("path inexistente: lista intacta (e nova instância)", () => {
		const list = [s("a.md")];
		expect(removeSuggestion(list, "x.md")).toEqual(list);
		expect(removeSuggestion(list, "x.md")).not.toBe(list);
	});
});

describe("validSuggestions — filtra paths/regras que não existem mais", () => {
	const list = [s("vivo.md", "r1"), s("movido.md", "r2"), s("apagado.md", "r1"), s("vivo2.md", "r-morta")];

	it("mantém só entradas com path E regra existentes", () => {
		const result = validSuggestions(list, {
			pathExists: (p) => p === "vivo.md" || p === "vivo2.md",
			ruleExists: (id) => id === "r1" || id === "r2",
		});
		expect(result).toEqual([s("vivo.md", "r1")]);
	});

	it("lista toda válida: sai igual (sem mutar a entrada)", () => {
		const all = [s("a.md"), s("b.md")];
		const result = validSuggestions(all, { pathExists: () => true, ruleExists: () => true });
		expect(result).toEqual(all);
		expect(result).not.toBe(all);
	});

	it("nada válido: lista vazia", () => {
		expect(
			validSuggestions(list, { pathExists: () => false, ruleExists: () => true })
		).toEqual([]);
	});
});
