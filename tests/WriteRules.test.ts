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
	});	});

describe("collectWriteTargets — alvos das ferramentas de anexo", () => {
	it("put_attachment: o destino é args.path (o gate cobre o anexo)", () => {
		expect(collectWriteTargets({ path: "Anexos/img.png", base64: "aGk=" })).toEqual(["Anexos/img.png"]);
	});

	it("delete_attachment: mesmo formato; chaves ausentes são filtradas", () => {
		expect(collectWriteTargets({ path: "Anexos/velho.png" })).toEqual(["Anexos/velho.png"]);
		expect(collectWriteTargets({ base64: "aGk=" })).toEqual([]);
	});

	it("combina com pathMatchesFolder: anexo em pasta bloqueada é negado", () => {
		const targets = collectWriteTargets({ path: "Secretas/anexo.png" });
		// O alvo BATE com a blocklist — é exatamente por isso que o gate nega.
		expect(targets.some((t) => pathMatchesFolder(t, "Secretas"))).toBe(true);
	});
});


describe("collectWriteTargets — arrays de caminhos (combine_notes.paths[])", () => {
	it("extrai cada elemento de args.paths como alvo", () => {
		const targets = collectWriteTargets({
			path: "origem.md",
			paths: ["Fontes/a.md", "Fontes/b.md", "Fontes/c.md"],
			targetPath: "Saida/merged.md",
		});
		expect(targets).toContain("Fontes/a.md");
		expect(targets).toContain("Fontes/b.md");
		expect(targets).toContain("Fontes/c.md");
		expect(targets).toContain("origem.md");
		expect(targets).toContain("Saida/merged.md");
	});

	it("filtra elementos vazios/null do array", () => {
		const targets = collectWriteTargets({
			paths: ["a.md", "", null, "b.md"],
		});
		expect(targets).toEqual(["a.md", "b.md"]);
	});

	it("arrays vazios não geram alvos extras", () => {
		const targets = collectWriteTargets({
			path: "nota.md",
			paths: [],
		});
		expect(targets).toEqual(["nota.md"]);
	});

	it("array com paths em pasta bloqueada é detectado", () => {
		const targets = collectWriteTargets({
			paths: ["Secretas/note.md", "OK/note.md"],
		});
		expect(targets.some((t) => pathMatchesFolder(t, "Secretas"))).toBe(true);
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
