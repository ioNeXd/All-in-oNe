import { describe, it, expect } from "vitest";
import { negotiateToolsApiVersion, TOOLS_API_VERSION } from "../src/modules/mcp/ToolsApiVersion";

/**
 * IMPORTA O CÓDIGO REAL da negociação da versão da API de ferramentas do
 * MCP — regra pura, sem I/O (padrão WriteRules.ts / NoteStatus.ts).
 */

describe("negotiateToolsApiVersion — cliente compatível", () => {
	it("aceita a mesma versão do servidor e ecoa a pedida", () => {
		const n = negotiateToolsApiVersion("1.0.0", "1.0.0");
		expect(n.compatible).toBe(true);
		expect(n.version).toBe("1.0.0");
		expect(n.reason).toBeUndefined();
	});

	it("aceita major menor (cliente mais antigo) e ecoa a pedida", () => {
		const n = negotiateToolsApiVersion("0.9.0", "1.0.0");
		expect(n.compatible).toBe(true);
		expect(n.version).toBe("0.9.0");
	});

	it("aceita minor/patch maiores dentro do mesmo major (cliente mais novo, mesma API)", () => {
		// Um cliente que fala 1.9.0 continua funcionando contra um servidor 1.0.0:
		// recursos que faltarem falham por ferramenta, com erro claro — nunca no handshake.
		const n = negotiateToolsApiVersion("1.9.0", "1.0.0");
		expect(n.compatible).toBe(true);
		expect(n.version).toBe("1.9.0");
	});

	it("sem pedido, o servidor dita a versão suportada", () => {
		const n = negotiateToolsApiVersion(undefined, "2.1.3");
		expect(n.compatible).toBe(true);
		expect(n.version).toBe("2.1.3");
	});

	it("string vazia é tratada como sem pedido", () => {
		const n = negotiateToolsApiVersion("", "1.0.0");
		expect(n.compatible).toBe(true);
		expect(n.version).toBe("1.0.0");
	});
});

describe("negotiateToolsApiVersion — major incompatível", () => {
	it("rejeita major maior que o suportado, com motivo claro", () => {
		const n = negotiateToolsApiVersion("2.0.0", "1.0.0");
		expect(n.compatible).toBe(false);
		expect(n.reason).toContain("2.0.0");
		expect(n.reason).toContain("1.0.0");
	});

	it("major 'grande demais' qualquer que seja (99.x) também é rejeitado", () => {
		expect(negotiateToolsApiVersion("99.0.0", "1.0.0").compatible).toBe(false);
	});

	it("formato inválido é rejeitado em vez de adivinhado", () => {
		for (const bad of ["banana", "v1.0.0", ".5", "1.x.0"]) {
			const n = negotiateToolsApiVersion(bad, "1.0.0");
			expect(n.compatible).toBe(false, `deveria rejeitar "${bad}"`);
			expect(n.reason).toContain(bad);
		}
	});
});

describe("TOOLS_API_VERSION", () => {
	it("bate com o default da fatia de settings do módulo MCP", async () => {
		const { MCP_DEFAULTS } = await import("../src/modules/mcp/McpModule");
		expect(MCP_DEFAULTS.toolsApiVersion).toBe(TOOLS_API_VERSION);
	});
});
