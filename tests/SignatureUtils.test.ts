import { describe, it, expect } from "vitest";
import { interpretGpgStatusOutput } from "../src/modules/autoupdate/SignatureUtils";

/**
 * IMPORTA O CÓDIGO REAL do interpretador de saída do gpg. Só linhas de
 * STATUS `[GNUPG:]` decidem — a saída humana é traduzida por locale e não
 * serve para decidir nada. Os exemplos abaixo são linhas reais do gpg 2.x.
 */

const GOOD =
	[
		"[GNUPG:] NEWSIG",
		"[GNUPG:] KEY_CONSIDERED 9C1B0A1B4B2B0B7C2A3D4E5F60718293A4B5C6D7 0",
		"[GNUPG:] SIG_ID SomeBase64 1234567890 0987654321",
		"[GNUPG:] GOODSIG 9C1B0A1B4B2B0B7C2A3D4E5F60718293A4B5C6D7 Nome do Assinante",
		"[GNUPG:] VALIDSIG 9C1B0A1B4B2B0B7C2A3D4E5F60718293A4B5C6D7 2026-09-01 1756700000 0 4 0 1 2 00 01AB02CD03EF04AB05CD06EF07AB08CD09EF12AB",
		"[GNUPG:] TRUST_ULTIMATE",
	].join("\n");

const BAD = ["[GNUPG:] NEWSIG", "[GNUPG:] BADSIG 9C1B0A1B4B2B0B7C2A3D4E5F60718293A4B5C6D7 Outro Nome"].join("\n");

const NO_PUBKEY = ["[GNUPG:] NEWSIG", "[GNUPG:] NO_PUBKEY 9C1B0A1B4B2B0B7C2A3D4E5F60718293A4B5C6D7"].join("\n");

const ERRSIG = [
	"[GNUPG:] ERRSIG 9C1B0A1B4B2B0B7C2A3D4E5F60718293A4B5C6D7 1 10 00 1756700000 9 -",
	"[GNUPG:] NO_PUBKEY 9C1B0A1B4B2B0B7C2A3D4E5F60718293A4B5C6D7",
].join("\n");

describe("interpretGpgStatusOutput — veredicto", () => {
	it("GOODSIG/VALIDSIG → válida, com fingerprint do VALIDSIG", () => {
		const r = interpretGpgStatusOutput(GOOD);
		expect(r.valid).toBe(true);
		expect(r.keyFingerprint).toBe(
			"01AB02CD03EF04AB05CD06EF07AB08CD09EF12AB"
		);
		expect(r.reason).toBeUndefined();
	});

	it("BADSIG → inválida com motivo", () => {
		const r = interpretGpgStatusOutput(BAD);
		expect(r.valid).toBe(false);
		expect(r.reason).toContain("BADSIG");
	});

	it("VALIDSIG usa o fingerprint da chave primária quando a assinatura veio de subchave", () => {
		const r = interpretGpgStatusOutput(
			"[GNUPG:] GOODSIG SUBKEYFP Nome\n" +
			"[GNUPG:] VALIDSIG SUBKEYFP 2026-09-01 1756700000 0 4 0 1 2 00 PRIMARYFP"
		);
		expect(r.valid).toBe(true);
		expect(r.keyFingerprint).toBe("PRIMARYFP");
	});

	it("EXPSIG é falha terminal, não sucesso", () => {
		expect(interpretGpgStatusOutput("[GNUPG:] EXPSIG ABCD Nome").valid).toBe(false);
	});

	it("EXPKEYSIG e REVKEYSIG são falha terminal, não sucesso", () => {
		const expired = "[GNUPG:] EXPKEYSIG 9C1B Nome";
		const revoked = "[GNUPG:] REVKEYSIG 9C1B Nome";
		expect(interpretGpgStatusOutput(expired).valid).toBe(false);
		expect(interpretGpgStatusOutput(revoked).valid).toBe(false);
	});

	it("NO_PUBKEY é FALHA — 'não consegui verificar' não é 'verificado'", () => {
		const r = interpretGpgStatusOutput(NO_PUBKEY);
		expect(r.valid).toBe(false);
		expect(r.reason).toContain("NO_PUBKEY");
	});

	it("ERRSIG com reason code 4 → algoritmo não suportado", () => {
		const r = interpretGpgStatusOutput(
			"[GNUPG:] ERRSIG 9C1B 1 10 00 1756700000 4 -"
		);
		expect(r.valid).toBe(false);
		expect(r.reason).toContain("algoritmo não suportado");
	});

	it("ERRSIG com reason code 5 → dados criptográficos inválidos", () => {
		const r = interpretGpgStatusOutput(
			"[GNUPG:] ERRSIG 9C1B 1 10 00 1756700000 5 -"
		);
		expect(r.valid).toBe(false);
		expect(r.reason).toContain("inválidos");
	});

	it("saída sem veredicto nenhum → inválida por indeterminação", () => {
		const r = interpretGpgStatusOutput("[GNUPG:] NEWSIG\nalguma coisa sem sentido");
		expect(r.valid).toBe(false);
		expect(r.reason).toContain("reconhecível");
	});

	it("saída VAZIA → inválida (nunca válida por omissão)", () => {
		expect(interpretGpgStatusOutput("").valid).toBe(false);
	});

	it("linhas humanas traduzidas (locale) são ignoradas — só [GNUPG:] decide", () => {
		const localized = `gpg: Assinatura correta de "Assinante" ${GOOD}`;
		expect(interpretGpgStatusOutput(localized).valid).toBe(true);
		const badLocalized = 'gpg: Assinatura INCORRETA de "Fulano"'; // só saída humana
		expect(interpretGpgStatusOutput(badLocalized).valid).toBe(false); // sem veredicto de status → indeterminado → falha
	});

	it("GOODSIG + BADSIG no mesmo arquivo → inválida (o mal manda)", () => {
		const r = interpretGpgStatusOutput(`${GOOD}\n${BAD}`);
		expect(r.valid).toBe(false);
	});
});
