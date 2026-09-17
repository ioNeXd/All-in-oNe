import { describe, it, expect } from "vitest";
import { pathMatchesFolder, collectWriteTargets } from "../src/modules/mcp/WriteRules";

/**
 * IMPORTA O CÓDIGO REAL das regras de permissão de escrita do MCP — a
 * fronteira de pasta é exatamente onde um furo de segurança mora, então o
 * teste roda contra a implementação de verdade (o teste antigo
 * McpValidation espelhava a validação de formulário à mão).
 */

describe("pathMatchesFolder — fronteira de pasta por segmento", () => {
	it("casa a própria pasta", () => {
		expect(pathMatchesFolder("Estudos", "Estudos")).toBe(true);
	});

	it("casa qualquer subcaminho", () => {
		expect(pathMatchesFolder("Estudos/Matematica/nota.md", "Estudos")).toBe(true);
		expect(pathMatchesFolder("Estudos/nota.md", "Estudos")).toBe(true);
	});

	it("NÃO casa pasta com prefixo igual mas nome diferente (o furo do startsWith cru)", () => {
		// Antes: normalizedPath.startsWith("Secretas") aceitava tudo abaixo,
		// burlando a blocklist com uma pasta irmã "Secretas2".
		expect(pathMatchesFolder("Secretas2/nota.md", "Secretas")).toBe(false);
		expect(pathMatchesFolder("Estudos2", "Estudos")).toBe(false);
	});

	it("normaliza barras finais da pasta configurada", () => {
		expect(pathMatchesFolder("Estudos/nota.md", "Estudos/")).toBe(true);
		expect(pathMatchesFolder("Estudos/nota.md", "Estudos///")).toBe(true);
	});

	it("base vazia nunca casa (bloqueio/permissão vazios não liberam por engano)", () => {
		expect(pathMatchesFolder("qualquer/nota.md", "")).toBe(false);
		expect(pathMatchesFolder("qualquer/nota.md", "/")).toBe(false);
	});
});

describe("collectWriteTargets — todos os caminhos que uma chamada pode tocar", () => {
	it("coleta path, newPath e targetPath presentes", () => {
		expect(
			collectWriteTargets({ path: "a.md", newPath: "b.md", targetPath: "c.md" })
		).toEqual(["a.md", "b.md", "c.md"]);
	});

	it("considera apenas os definidos, na ordem fixa de prioridade", () => {
		expect(collectWriteTargets({ newPath: "b.md" })).toEqual(["b.md"]);
		expect(collectWriteTargets({ targetPath: "c.md", path: "a.md" })).toEqual(["a.md", "c.md"]);
	});

	it("trata null e string vazia como ausentes", () => {
		expect(collectWriteTargets({ path: null, newPath: "" })).toEqual([]);
		expect(collectWriteTargets({})).toEqual([]);
	});
});
