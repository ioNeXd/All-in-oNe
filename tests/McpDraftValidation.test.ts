import { describe, it, expect } from "vitest";
import { validateMcpDraft } from "../src/modules/mcp/McpModule";

/**
 * IMPORTA O CÓDIGO REAL (validateMcpDraft de McpModule.ts) — substitui o
 * antigo tests/McpValidation.test.ts, que reimplementava a regra à mão e
 * podia divergir do módulo sem ninguém perceber. Era possível desde que o
 * pacote "obsidian" (types-only) passou a ser substituído por stub via
 * alias no vitest.config.ts. A função é pura: só o import toca o módulo.
 */
describe("validateMcpDraft — validação do formulário do MCP (código real)", () => {
	it("rejeita porta abaixo de 1024", () => {
		const errors = validateMcpDraft({ port: 80, rateLimitPerMinute: 120 });
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("80");
	});

	it("rejeita porta acima de 65535", () => {
		expect(validateMcpDraft({ port: 70000, rateLimitPerMinute: 120 })).toHaveLength(1);
	});

	it("rejeita campo de porta vazio (Number('') === 0), em vez de virar 0 no servidor", () => {
		const errors = validateMcpDraft({ port: Number(""), rateLimitPerMinute: 120 });
		expect(errors.length).toBeGreaterThan(0); // o importante é NÃO passar
	});

	it("rejeita porta não inteira", () => {
		expect(validateMcpDraft({ port: 8080.5, rateLimitPerMinute: 10 })).toHaveLength(1);
	});

	it("aceita uma porta válida", () => {
		expect(validateMcpDraft({ port: 27931, rateLimitPerMinute: 120 })).toHaveLength(0);
	});

	it("rejeita limite de ações menor que 1", () => {
		expect(validateMcpDraft({ port: 27931, rateLimitPerMinute: 0 })).toHaveLength(1);
	});

	it("rejeita limite de ações não finito (NaN/Infinity)", () => {
		expect(validateMcpDraft({ port: 27931, rateLimitPerMinute: Number.NaN })).toHaveLength(1);
		expect(validateMcpDraft({ port: 27931, rateLimitPerMinute: Infinity })).toHaveLength(1);
	});

	it("acumula os dois erros quando ambos os campos são inválidos", () => {
		const errors = validateMcpDraft({ port: 80, rateLimitPerMinute: 0 });
		expect(errors).toHaveLength(2);
	});
});
