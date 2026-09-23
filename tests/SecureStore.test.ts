import { describe, it, expect } from "vitest";
import { obfuscate, deobfuscate } from "../src/core/secureStore";

/**
 * Ofuscação do token MCP — NÃO é criptografia (ver o cabeçalho de
 * secureStore.ts e a seção "O que fica de fora, deliberadamente" da
 * docs/ARCHITECTURE.md). O que esta suíte trava é o CONTRATO REAL da
 * ofuscação: reversível, não-decodificável a olho nu, e determinística
 * (o token regenerado pelo painel sobrescreve a entrada anterior).
 */
describe("secureStore — ofuscação (não-criptográfica, por design)", () => {
	it("round-trip: deobfuscate(obfuscate(v)) === v", () => {
		for (const value of ["tok-123", "chave com espaços e acentuação çã", "x"]) {
			expect(deobfuscate(obfuscate(value))).toBe(value);
		}
	});

	it("o valor ofuscado não contém o segredo em claro (nem em base64 cru)", () => {
		const token = "super-token-mcp-42";
		const stored = obfuscate(token);
		expect(stored).not.toContain(token);
		// base64 do token puro também não (o XOR tem que ter mexido nos bytes):
		expect(stored).not.toBe(Buffer.from(token).toString("base64"));
	});

	it("é determinística (mesma entrada → mesma saída)", () => {
		expect(obfuscate("abc")).toBe(obfuscate("abc"));
	});

	it("saída sempre em base64 válido", () => {
		const stored = obfuscate("qualquer coisa");
		expect(() => Buffer.from(stored, "base64")).not.toThrow();
		expect(/^[A-Za-z0-9+/]+={0,2}$/.test(stored)).toBe(true);
	});

	it("deobfuscate de lixo/entrada inválida não lança (degrada para vazio)", () => {
		// O chamador (McpModule) usa o retorno para o gate Bearer: vazio =
		// nenhum token configurado = tudo recusado — caminho seguro.
		expect(deobfuscate("%%%%não-base64%%%%")).toBe("");
	});

	it("string vazia: round-trip coerente", () => {
		expect(deobfuscate(obfuscate(""))).toBe("");
	});
});
