import { describe, it, expect } from "vitest";
import { tokenizeCss, cssTokenTypeClass, type CssToken } from "../src/modules/styles/CssHighlight";

/**
 * IMPORTA O CÓDIGO REAL do tokenizador de CSS do módulo de Estilos
 * (CssHighlight.ts). O invariante que sustenta a UI de overlay é:
 * concatenação dos tokens por linha === texto exato de entrada.
 */

function lineText(line: CssToken[]): string {
	return line.map((t) => t.text).join("");
}

function allText(result: CssToken[][]): string {
	return result.map(lineText).join("\n");
}

describe("tokenizeCss — invariante de round-trip (a UI de overlay depende disto)", () => {
	it("reproduz o texto exato num caso real de editor CSS", () => {
		const css = [
			"body.theme-dark,",
			"body.theme-light {",
			"  --text-normal: #ffffff;",
			"  --background-primary: #1e1e1e;",
			"  color: var(--text-accent);",
			"}",
		].join("\n");
		expect(allText(tokenizeCss(css))).toBe(css);
	});

	it("tabs, unicode e espaços sobrevivem byte a byte", () => {
		const css = "body\t{ color:\t#fff; }\n.ção { content: \"ação\\tcom escape\"; }";
		expect(allText(tokenizeCss(css))).toBe(css);
	});

	it("strings contendo { } : ; não enganam a contagem de chaves", () => {
		const css = '.x::after { content: "{ : ; }"; color: red; }';
		const lines = tokenizeCss(css);
		expect(allText(lines)).toBe(css);
		// `color` vem DEPOIS da string fechada e ainda assim é property (depth > 0):
		const kinds = lines[0].filter((t) => t.text === "color");
		expect(kinds.map((t) => t.kind)).toEqual(["property"]);
	});

	it("comentário multi-linha não perde nem move um caractere", () => {
		const css = "/* começa\n  continua\n  termina */ body { color: red; }";
		expect(allText(tokenizeCss(css))).toBe(css);
	});

	it("comentário nunca fechado até o fim do arquivo não quebra o round-trip", () => {
		const css = "body { color: red; }\n/* comentário sem fim...";
		expect(allText(tokenizeCss(css))).toBe(css);
	});

	it("url(http://x/*y) não abre comentário (está dentro de string)", () => {
		const css = '.a { background: url("http://x/*y"); }';
		const lines = tokenizeCss(css);
		expect(allText(lines)).toBe(css);
	});

	it("divisão de array bate com o número de linhas (uma por linha)", () => {
		const css = "a { b: c; }\n\n\nx { }";
		const lines = tokenizeCss(css);
		expect(lines).toHaveLength(4);
		expect(allText(lines)).toBe(css);
	});

	it("round-trip do esqueleto inicial do editor (comentado, com variáveis)", () => {
		const starter = [
			"/* Seu CSS personalizado — edite e clique em \"Aplicar CSS\".",
			"   Ctrl+Espaço abre a lista de variáveis disponíveis.",
			"   As variáveis abaixo são só exemplos comentados; descomente para usar. */",
			"",
			"body.theme-dark,",
			"body.theme-light {",
			"  /* --text-normal: #ffffff; */          /* cor do texto das notas */",
			"  /* --background-primary: #1e1e1e; */   /* fundo do editor */",
			"}",
			"",
			"/* .ione-hub-calendar__day { border-radius: 8px; } */",
		].join("\n");
		expect(allText(tokenizeCss(starter))).toBe(starter);
	});
});

describe("tokenizeCss — classificação (o que ganha qual cor)", () => {
	it("fora de chaves, `palavra:` é seletor — o `hover` de a:hover", () => {
		// a:hover e color: red têm a MESMA forma léxica `palavra:` — só o
		// contexto de chaves (depth) distingue os dois.
		const flat = tokenizeCss("a:hover { color: red; }").flat();
		expect(flat.find((t) => t.text === "hover")?.kind).toBe("selector");
	});

	it("dentro de chaves, `palavra:` é propriedade", () => {
		const flat = tokenizeCss("body { color: red; }").flat();
		expect(flat.find((t) => t.text === "color")?.kind).toBe("property");
	});

	it("variáveis (--*) ganham a classe própria dentro e fora de bloco", () => {
		const flat = tokenizeCss("body { --x: 1; }\n--fora: 2;").flat();
		const vars = flat.filter((t) => t.text === "--x" || t.text === "--fora");
		expect(vars.map((v) => v.kind)).toEqual(["variable", "variable"]);
	});

	it("@media é at-rule; números e hex dentro de bloco são valores", () => {
		const flat = tokenizeCss("@media (min-width: 600px) { .x { top: 10px; color: #fff; } }").flat();
		expect(flat.find((t) => t.text === "@media")?.kind).toBe("atrule");
		expect(flat.find((t) => t.text === "600px")?.kind).toBe("value");
		expect(flat.find((t) => t.text === "10px")?.kind).toBe("value");
		expect(flat.find((t) => t.text === "#fff")?.kind).toBe("value");
	});

	it("unidades de fonte e tempo são valores dentro de bloco", () => {
		const flat = tokenizeCss("h1 { font-size: 2em; transition: 300ms; }").flat();
		expect(flat.find((t) => t.text === "2em")?.kind).toBe("value");
		expect(flat.find((t) => t.text === "300ms")?.kind).toBe("value");
	});

	it("palavra seguida de `(` dentro de bloco é valor (var(), rgb(), calc())", () => {
		const flat = tokenizeCss("a { color: var(--x); width: calc(1px + 2px); }").flat();
		expect(flat.find((t) => t.text === "var")?.kind).toBe("value");
		expect(flat.find((t) => t.text === "calc")?.kind).toBe("value");
	});

	it("valor simples sem unidade (`red`, `bold`) ganha cor de valor", () => {
		const flat = tokenizeCss("body { color: red; font-weight: bold; } .ione-hub-x { }").flat();
		expect(flat.find((t) => t.text === "red")?.kind).toBe("value");
		expect(flat.find((t) => t.text === "bold")?.kind).toBe("value");
		// e a classe fora de bloco continua seletor, não valor:
		expect(flat.find((t) => t.text === "ione-hub-x")?.kind).toBe("selector");
	});

	it("comentário no meio de uma linha de código ganha a classe própria", () => {
		const flat = tokenizeCss("body { /* nota */ color: red; }").flat();
		expect(flat.find((t) => t.text === "/* nota */")?.kind).toBe("comment");
	});
});

describe("cssTokenTypeClass", () => {
	it("mapeia kind → classe .tok-*", () => {
		expect(cssTokenTypeClass("comment")).toBe("tok-comment");
		expect(cssTokenTypeClass("variable")).toBe("tok-variable");
		expect(cssTokenTypeClass("property")).toBe("tok-property");
	});
});
