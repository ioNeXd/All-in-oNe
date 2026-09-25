import { describe, it, expect } from "vitest";
import { isPathWithinBase, uniqueNameWith, validateVaultPath } from "../src/core/PathUtils";

/**
 * IMPORTA O CÓDIGO REAL (PathUtils.ts) — a regra de colisão de nomes era
 * duplicada à mão em 3 módulos (Templates, Calendário, Ciclo de Vida) e já
 * gerou o bug "Nota 2t" (slice comendo o último caractere em nome sem
 * extensão). Centralizada, agora testada contra a implementação de verdade.
 */
describe("uniqueNameWith — primeiro nome livre", () => {
	it("retorna o caminho como está quando não existe", () => {
		expect(uniqueNameWith("Notas/Nota.md", () => false)).toBe("Notas/Nota.md");
	});

	it("sufixa ' 2' antes da extensão quando existe", () => {
		const usados = new Set(["Nota.md"]);
		const r = uniqueNameWith("Nota.md", (p) => usados.has(p));
		expect(r).toBe("Nota 2.md");
	});

	it("continua contando até achar livre (Nota 2 e Nota 3 ocupados → Nota 4)", () => {
		const usados = new Set(["Nota.md", "Nota 2.md", "Nota 3.md"]);
		const r = uniqueNameWith("Nota.md", (p) => usados.has(p));
		expect(r).toBe("Nota 4.md");
	});

	it("preserva extensões compostas (.tar.gz)", () => {
		const usados = new Set(["backup.tar.gz"]);
		const r = uniqueNameWith("backup.tar.gz", (p) => usados.has(p));
		expect(r).toBe("backup.tar 2.gz");
	});

	it("nome sem extensão: NÃO come o último caractere (bug 'Nota 2t')", () => {
		const usados = new Set(["Relatório"]);
		const r = uniqueNameWith("Relatório", (p) => usados.has(p));
		expect(r).toBe("Relatório 2");
	});

	it("caminho sem pasta com nome sem extensão também é protegido", () => {
		const usados = new Set(["Leia-me"]);
		const r = uniqueNameWith("Leia-me", (p) => usados.has(p));
		expect(r).toBe("Leia-me 2");
	});

	it("ponto em pasta não é confundido com extensão do arquivo", () => {
		// "2024.05/Nota.md": o dot da pasta é irrelevante — a extensão é a do arquivo.
		const usados = new Set(["2024.05/Nota.md"]);
		const r = uniqueNameWith("2024.05/Nota.md", (p) => usados.has(p));
		expect(r).toBe("2024.05/Nota 2.md");
	});

	it("só pergunta a exists pelo desired e pelos candidatos numerados", () => {
		const perguntas: string[] = [];
		uniqueNameWith("X.md", (p) => {
			perguntas.push(p);
			return p === "X.md"; // só X.md existe; X 2.md livre
		});
		expect(perguntas).toEqual(["X.md", "X 2.md"]);
	});
});


describe("isPathWithinBase — contenção", () => {
	it("aceita o próprio diretório base e descendentes", () => {
		expect(isPathWithinBase("Notas", "Notas")).toBe(true);
		expect(isPathWithinBase("Notas/2026/Relatorio.md", "Notas")).toBe(true);
	});

	it("não confunde prefixo de nome com descendência", () => {
		expect(isPathWithinBase("NotasExtras/Relatorio.md", "Notas")).toBe(false);
	});

	it("normaliza separadores e comparação de caixa", () => {
		expect(isPathWithinBase("Notas\\2026\\Relatorio.md", "notas")).toBe(true);
	});

	it("rejeita qualquer path contendo .. antes de considerar a base", () => {
		expect(isPathWithinBase("Notas/../segredo.md", "Notas")).toBe(false);
		expect(isPathWithinBase("Notas/relatorio..final.md", "Notas")).toBe(false);
	});
});


describe("validateVaultPath — traversal", () => {
	it("aceita nomes com dois pontos que não são segmentos de traversal", () => {
		expect(validateVaultPath("Notas/relatorio..final.md")).toBe("Notas/relatorio..final.md");
	});

	it("rejeita segmento de diretório ..", () => {
		expect(() => validateVaultPath("Notas/../segredo.md")).toThrow();
	});
});
