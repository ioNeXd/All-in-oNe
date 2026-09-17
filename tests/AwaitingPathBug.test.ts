import { describe, it, expect } from "vitest";

/**
 * Regressão do bug crítico da v0.4.0: um `Set` de "caminhos aguardando nome"
 * usava `file.path` LIDO DE NOVO depois de renomear. Como o Obsidian muda o
 * `.path` no próprio objeto do arquivo (mutação in-place), o valor original
 * nunca era removido do Set — travando permanentemente qualquer arquivo
 * futuro que reaproveitasse aquele nome (ex.: "Untitled.md" toda vez que o
 * Obsidian cria uma nota nova sem título).
 *
 * Este teste isola o padrão certo (capturar o caminho ANTES de mutar) contra
 * o padrão errado, usando um objeto mutável simples no lugar de um TFile.
 */
interface MutableFile {
	path: string;
}

function simulateRename(file: MutableFile, newPath: string): void {
	file.path = newPath; // é exatamente assim que o Obsidian muda o TFile
}

describe("padrão de rastreamento de caminho durante rename (bug crítico corrigido)", () => {
	it("padrão ERRADO: usar file.path depois do rename nunca limpa o Set", () => {
		const awaiting = new Set<string>();
		const file: MutableFile = { path: "Untitled.md" };

		awaiting.add(file.path); // "Untitled.md"
		simulateRename(file, "Minha Nota.md");
		awaiting.delete(file.path); // tenta apagar "Minha Nota.md" — nunca esteve lá

		expect(awaiting.has("Untitled.md")).toBe(true); // BUG: fica preso pra sempre
	});

	it("padrão CORRETO: capturar o caminho original antes do rename", () => {
		const awaiting = new Set<string>();
		const file: MutableFile = { path: "Untitled.md" };

		const originalPath = file.path; // capturado ANTES de qualquer mutação
		awaiting.add(originalPath);
		simulateRename(file, "Minha Nota.md");
		awaiting.delete(originalPath); // usa a constante, não o objeto mutado

		expect(awaiting.has("Untitled.md")).toBe(false);
		expect(awaiting.size).toBe(0);
	});

	it("com o padrão correto, o nome reaproveitado funciona na próxima criação", () => {
		const awaiting = new Set<string>();

		// Primeira nota: "Untitled.md" criado, renomeado, e liberado do Set.
		const first: MutableFile = { path: "Untitled.md" };
		const firstOriginal = first.path;
		awaiting.add(firstOriginal);
		simulateRename(first, "Primeira Nota.md");
		awaiting.delete(firstOriginal);

		// Segunda nota reaproveita o nome "Untitled.md" (comportamento real do Obsidian).
		const second: MutableFile = { path: "Untitled.md" };
		expect(awaiting.has(second.path)).toBe(false); // não deve estar bloqueada
	});
});
