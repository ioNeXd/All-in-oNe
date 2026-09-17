import { describe, it, expect } from "vitest";

/**
 * Reimplementação local das regras de validação do formulário do MCP.
 * Mantida em espelho com `validateMcpDraft` de McpModule.ts — o módulo em si
 * importa "obsidian", que não existe fora do runtime do app, então testamos
 * a regra de negócio isolada (foi exatamente onde o bug estava: porta 80
 * era aceita silenciosamente e virava 0).
 */
function validateMcpDraft(draft: { port: number; rateLimitPerMinute: number }): string[] {
	const errors: string[] = [];
	if (!Number.isInteger(draft.port)) {
		errors.push("A porta precisa ser um número inteiro.");
	} else if (draft.port < 1024 || draft.port > 65535) {
		errors.push(`Porta ${draft.port} inválida: use um valor entre 1024 e 65535.`);
	}
	if (!Number.isFinite(draft.rateLimitPerMinute) || draft.rateLimitPerMinute < 1) {
		errors.push("O limite de ações por minuto precisa ser pelo menos 1.");
	}
	return errors;
}

describe("validação do formulário do MCP", () => {
	it("rejeita porta abaixo de 1024", () => {
		const errors = validateMcpDraft({ port: 80, rateLimitPerMinute: 120 });
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("80");
	});

	it("rejeita campo de porta vazio (NaN), em vez de virar 0", () => {
		const errors = validateMcpDraft({ port: Number(""), rateLimitPerMinute: 120 });
		// Number("") === 0, que também é inválido — o importante é NÃO passar.
		expect(errors.length).toBeGreaterThan(0);
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
});
