import { describe, it, expect } from "vitest";
import { compareVersions, isNewerVersion, parseChecksums } from "../src/modules/autoupdate/ReleaseUtils";

/**
 * IMPORTA O CÓDIGO REAL de versionamento do AutoUpdateModule. O caso
 * clássico que justifica a comparação SemVer em vez de string:
 * lexicograficamente "0.10.0" < "0.9.0", o que faria o plugin IGNORE um
 * release mais novo.
 */

describe("compareVersions — comparação SemVer de segmentos numéricos", () => {
	it("major decide antes de tudo", () => {
		expect(compareVersions("2.0.0", "1.9.9")).toBeGreaterThan(0);
		expect(compareVersions("1.0.0", "2.0.0")).toBeLessThan(0);
	});

	it("minor e patch decidem na ordem certa", () => {
		expect(compareVersions("0.2.0", "0.1.9")).toBeGreaterThan(0);
		expect(compareVersions("0.1.2", "0.1.1")).toBeGreaterThan(0);
	});

	it("o caso que quebrava comparação de string: 0.10.0 > 0.9.0", () => {
		expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
		expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
	});

	it("versões iguais dão 0", () => {
		expect(compareVersions("0.1.0", "0.1.0")).toBe(0);
	});

	it("segmentos faltantes contam como 0 (0.2 == 0.2.0)", () => {
		expect(compareVersions("0.2", "0.2.0")).toBe(0);
		expect(compareVersions("1.0", "1.0.0")).toBe(0);
	});

	it("pré-lançamento é MAIS ANTIGO que o release do mesmo número base (regra do SemVer)", () => {
		// Se contasse como igual/maior, o plugin "atualizaria" de uma 0.3.0
		// estável para a beta 0.3.0-beta.1. No canal estável isso nunca deve
		// ser considerado uma atualização.
		expect(compareVersions("0.3.0-beta.1", "0.3.0")).toBeLessThan(0);
		expect(isNewerVersion("0.3.0", "0.3.0-beta.1")).toBe(true);
		expect(isNewerVersion("0.3.0-beta.1", "0.3.0")).toBe(false);
		expect(compareVersions("0.4.0-rc1", "0.3.9")).toBeGreaterThan(0);
	});

	it("segmento não numérico conta como 0, sem lançar exceção", () => {
		expect(() => compareVersions("abc", "0.1.0")).not.toThrow();
		expect(compareVersions("abc", "0.0.0")).toBe(0);
	});
});

describe("isNewerVersion — só considera ESTRITAMENTE mais nova", () => {
	it("release mais novo é detectado", () => {
		expect(isNewerVersion("0.2.0", "0.1.0")).toBe(true);
		expect(isNewerVersion("0.10.0", "0.9.0")).toBe(true);
	});

	it("mesma versão ou mais antiga NÃO é 'mais nova' (evita re-notificar o que já está instalado)", () => {
		expect(isNewerVersion("0.1.0", "0.1.0")).toBe(false);
		expect(isNewerVersion("0.9.0", "0.10.0")).toBe(false);
		expect(isNewerVersion("0.1", "0.1.0")).toBe(false);
	});
});

describe("parseChecksums — checksums declarados no corpo do release", () => {
	it("lê linhas no formato 'sha256 nome: hash'", () => {
		const body = "Outras notas do release...\nsha256 main.js: " + "a".repeat(64) + "\nfim";
		expect(parseChecksums(body)).toEqual({ "main.js": "a".repeat(64) });
	});

	it("aceita '=' como separador e nomes com pontos e hífens", () => {
		const body = `sha256 manifest.json = ${"b".repeat(64)}\nsha256 styles-tema.css: ${"c".repeat(64)}`;
		const parsed = parseChecksums(body);
		expect(parsed["manifest.json"]).toBe("b".repeat(64));
		expect(parsed["styles-tema.css"]).toBe("c".repeat(64));
	});

	it("ignora linhas malformadas ou com hash curto demais", () => {
		const body = [
			"sha256 main.js: abc123", // hash curto
			"md5 manifest.json: " + "d".repeat(64), // algoritmo errado
			"sha256 sem-hash",
			"",
		].join("\n");
		expect(parseChecksums(body)).toEqual({});
	});

	it("múltiplos checksums no mesmo body", () => {
		const body = [
			"sha256 main.js: " + "1".repeat(64),
			"sha256 manifest.json: " + "2".repeat(64),
			"sha256 styles.css: " + "3".repeat(64),
		].join("\n");
		const parsed = parseChecksums(body);
		expect(Object.keys(parsed)).toHaveLength(3);
		expect(parsed["styles.css"]).toBe("3".repeat(64));
	});

	it("body vazio ou undefined-like retorna objeto vazio", () => {
		expect(parseChecksums("")).toEqual({});
		expect(parseChecksums(undefined as unknown as string)).toEqual({});
	});
});
