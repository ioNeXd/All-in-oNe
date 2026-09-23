import { describe, it, expect } from "vitest";
import { cryptoRandomToken, randomId } from "../src/core/types";

/**
 * Token do MCP = segredo → CSPRNG (crypto.getRandomValues). O randomId de
 * log/inscrição segue Math.random de propósito: lá o requisito é unicidade,
 * não imprevisibilidade — os dois geradores coexistem com contratos claros.
 */
describe("cryptoRandomToken — segredo via CSPRNG", () => {
	it("formato base64url (sem +, / ou =)", () => {
		for (let i = 0; i < 20; i++) {
			expect(cryptoRandomToken()).toMatch(/^[A-Za-z0-9_-]+$/);
		}
	});

	it("comprimento consistente com 32 bytes de entropia (~43 chars base64url)", () => {
		const token = cryptoRandomToken();
		expect(token.length).toBe(43); // ceil(32 * 4/3) sem padding
	});

	it("não repete (unicidade estatística em amostra)", () => {
		const tokens = new Set(Array.from({ length: 500 }, () => cryptoRandomToken()));
		expect(tokens.size).toBe(500);
	});

	it("aceita tamanho customizado", () => {
		// 16 bytes → 22 chars base64url sem padding.
		expect(cryptoRandomToken(16).length).toBe(22);
	});

	it("diferente do randomId não-secreto (contratos separados)", () => {
		// randomId: 16 chars alfanuméricos de Math.random; o token nunca tem
		// esse formato/curto demais.
		expect(cryptoRandomToken().length).toBeGreaterThan(randomId().length);
	});
});
