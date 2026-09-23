import { describe, it, expect, vi } from "vitest";
import {
	normalizeQuery,
	countOccurrences,
	buildSnippet,
	scoreCandidate,
	searchVault,
	DEFAULT_MAX_RESULTS,
	SNIPPET_MAX_CHARS,
} from "../src/modules/mcp/SearchVault";

/**
 * Regras puras da busca search_vault (filtro via cache, leitura sob teto,
 * snippets). O vault chega como callbacks — nenhuma dependência do Obsidian.
 */

describe("normalizeQuery", () => {
	it("trim + lowercase; não-string vira vazio", () => {
		expect(normalizeQuery("  Foo BAR ")).toBe("foo bar");
		expect(normalizeQuery(undefined)).toBe("");
		expect(normalizeQuery(42)).toBe("");
	});

	it("query vazio/whitespace: busca nada (não 'matcha tudo')", () => {
		expect(normalizeQuery("   ")).toBe("");
	});
});

describe("countOccurrences", () => {
	it("conta sobreposições não-overlapping", () => {
		expect(countOccurrences("ababab", "abab")).toBe(1);
		expect(countOccurrences("a a a", "a")).toBe(3);
	});

	it("needle vazio = 0 (nunca infinito)", () => {
		expect(countOccurrences("qualquer", "")).toBe(0);
	});
});

describe("buildSnippet", () => {
	it("contexto ao redor da primeira ocorrência", () => {
		const snippet = buildSnippet("introdução longa aqui. PALAVRA alvo no meio. fim", "palavra");
		expect(snippet).toContain("PALAVRA");
		expect(snippet.length).toBeLessThanOrEqual(SNIPPET_MAX_CHARS);
	});

	it("sem ocorrência: snippet vazio", () => {
		expect(buildSnippet("nada aqui", "zzz")).toBe("");
	});

	it("snippet longo é truncado com reticências", () => {
		const long = `x${"y".repeat(500)}`;
		const snippet = buildSnippet(long, "yyy");
		expect(snippet.length).toBeLessThanOrEqual(SNIPPET_MAX_CHARS);
		expect(snippet.endsWith("…")).toBe(true);
	});
});

describe("scoreCandidate", () => {
	it("path vale mais que tag, que vale mais que frontmatter", () => {
		const base = { path: "x.md", pathMatch: false, tagMatch: false, frontmatterMatch: false };
		expect(scoreCandidate(base, "q")).toBe(0);
		expect(scoreCandidate({ ...base, frontmatterMatch: true }, "q")).toBeGreaterThan(0);
		expect(scoreCandidate({ ...base, tagMatch: true }, "q")).toBeGreaterThan(
			scoreCandidate({ ...base, frontmatterMatch: true }, "q")
		);
		expect(scoreCandidate({ ...base, pathMatch: true }, "q")).toBeGreaterThan(
			scoreCandidate({ ...base, tagMatch: true }, "q")
		);
	});
});

describe("searchVault — estratégia de leitura", () => {
	type Note = { path: string; tags: string[]; frontmatter: string[]; content: string };

	function makePrimitives(notes: Note[]) {
		const reads: string[] = [];
		return {
			reads,
			primitives: {
				listNotes: () => notes,
				fileMeta: (f: Note) => ({ path: f.path, tags: f.tags, frontmatterValues: f.frontmatter }),
				readContent: async (f: Note) => {
					reads.push(f.path);
					return f.content;
				},
			},
		};
	}

	it("match no path NÃO lê o conteúdo (zero I/O)", async () => {
		const { primitives, reads } = makePrimitives([
			{ path: "Projetos/alpha.md", tags: [], frontmatter: [], content: "sem o termo" },
		]);
		const result = await searchVault({ query: "alpha" }, primitives);
		expect(result.matches.map((m) => m.path)).toEqual(["Projetos/alpha.md"]);
		expect(result.matches[0].matchedIn).toEqual(["path"]);
		expect(reads).toEqual([]);
		expect(result.truncated).toBe(false);
	});

	it("match em tag/frontmatter também dispensa leitura", async () => {
		const { primitives, reads } = makePrimitives([
			{ path: "a.md", tags: ["projeto-x"], frontmatter: [], content: "" },
			{ path: "b.md", tags: [], frontmatter: ["status: feito"], content: "" },
		]);
		const byTag = await searchVault({ query: "projeto-x" }, primitives);
		expect(byTag.matches[0].matchedIn).toEqual(["tag"]);
		const byFm = await searchVault({ query: "feito" }, primitives);
		expect(byFm.matches[0].matchedIn).toEqual(["frontmatter"]);
		// Em cada busca, a nota "a" (match no cache da PRIMEIRA busca) nunca
		// é lida. Na busca por "projeto-x": a.md casa na tag, b.md é lida e
		// não contém o termo. Na busca por "feito": a.md não casa em lugar
		// nenhum do cache (a tag "projeto-x" não contém "feito") e é lida;
		// b.md casa no frontmatter sem leitura. Total: b.md e a.md, uma vez cada.
		expect(reads).toEqual(["b.md", "a.md"]);
	});

	it("sem match no cache: lê, conta hits e monta snippet", async () => {
		const { primitives, reads } = makePrimitives([
			{ path: "a.md", tags: [], frontmatter: [], content: "fala de orquídeas duas vezes: orquídeas." },
			{ path: "b.md", tags: [], frontmatter: [], content: "nada a ver" },
		]);
		const result = await searchVault({ query: "orquídeas" }, primitives);
		expect(reads).toEqual(["a.md", "b.md"]);
		expect(result.matches).toHaveLength(1);
		expect(result.matches[0].path).toBe("a.md");
		expect(result.matches[0].hits).toBe(2);
		expect(result.matches[0].snippet).toContain("orquídeas");
	});

	it("teto interrompe a leitura (não varre o vault inteiro)", async () => {
		const notes: Note[] = [];
		for (let i = 0; i < 200; i++) {
			notes.push({ path: `n${i}.md`, tags: [], frontmatter: [], content: `contém alvo aqui ${i}` });
		}
		const { primitives, reads } = makePrimitives(notes);
		const result = await searchVault({ query: "alvo", maxResults: 5 }, primitives);
		expect(result.matches).toHaveLength(5);
		expect(result.truncated).toBe(true);
		expect(reads.length).toBeLessThanOrEqual(6); // 5 aceitos + 1 que revelou o estouro
	});

	it("teto default é aplicado quando maxResults não vem", async () => {
		const notes: Note[] = [];
		for (let i = 0; i < DEFAULT_MAX_RESULTS + 10; i++) {
			notes.push({ path: `n${i}.md`, tags: [], frontmatter: [], content: "achou" });
		}
		const { primitives } = makePrimitives(notes);
		const result = await searchVault({ query: "achou" }, primitives);
		expect(result.matches).toHaveLength(DEFAULT_MAX_RESULTS);
		expect(result.truncated).toBe(true);
	});

	it("query vazio: nada é lido nem escaneado", async () => {
		const { primitives, reads } = makePrimitives([
			{ path: "a.md", tags: [], frontmatter: [], content: "texto" },
		]);
		const result = await searchVault({ query: "  " }, primitives);
		expect(result).toEqual({ matches: [], truncated: false, scanned: 0 });
		expect(reads).toEqual([]);
	});

	it("case-insensitive em todas as fontes (path, tag, conteúdo)", async () => {
		const { primitives } = makePrimitives([
			{ path: "Notas/ORQUIDEA.md", tags: [], frontmatter: [], content: "x" },
			{ path: "b.md", tags: ["Orquidea"], frontmatter: [], content: "x" },
			{ path: "c.md", tags: [], frontmatter: [], content: "fala de ORQUIDEA" },
		]);
		const result = await searchVault({ query: "orquidea" }, primitives);
		expect(result.matches.map((m) => m.path).sort()).toEqual(["Notas/ORQUIDEA.md", "b.md", "c.md"]);
	});
});
