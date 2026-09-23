import { describe, it, expect } from "vitest";
import {
	BACKUP_FILES,
	BACKUP_DIR,
	backupFilePath,
	pickExisting,
	migrateLegacyBackup,
	readBackFromDisk,
	type VersionBackupMeta,
} from "../src/modules/autoupdate/UpdateBackup";

/**
 * Regras puras do backup de versão em ARQUIVOS (não no data.json): o que
 * copiar, onde mora no disco, migração do formato legado inline e leitura
 * de volta. Sem Obsidian — o I/O fica no módulo.
 */

describe("BACKUP_FILES / caminhos", () => {
	it("lista os mesmos assets do update", () => {
		expect(BACKUP_FILES).toEqual(["main.js", "manifest.json", "styles.css"]);
	});

	it("backupFilePath mora na pasta do plugin, sob .backup", () => {
		expect(backupFilePath("plugins/All-in-oNe", "main.js")).toBe(
			`plugins/All-in-oNe/${BACKUP_DIR}/main.js`
		);
	});
});

describe("pickExisting — o que copiar", () => {
	it("copia só o que existe; styles.css é opcional", () => {
		expect(
			pickExisting({ "main.js": true, "manifest.json": true, "styles.css": false })
		).toEqual(["main.js", "manifest.json"]);
	});

	it("sem styles.css, a lista não o menciona (rollback restaura só o que foi guardado)", () => {
		expect(
			pickExisting({ "main.js": true, "manifest.json": true })
		).toEqual(["main.js", "manifest.json"]);
	});
});

describe("migrateLegacyBackup — formato antigo inline → arquivos", () => {
	it("separa metadado (settings) de conteúdos (disco)", () => {
		const result = migrateLegacyBackup({
			version: "0.2.0",
			files: { "main.js": "// bundle antigo", "manifest.json": "{}" },
		});
		expect(result).not.toBeNull();
		expect(result!.meta).toMatchObject({
			version: "0.2.0",
			files: ["main.js", "manifest.json"],
			backedUpAt: expect.any(Number),
		});
		expect(result!.contents["main.js"]).toBe("// bundle antigo");
		// conteúdos NÃO vazam para o metadado:
		expect(JSON.stringify(result!.meta)).not.toContain("// bundle antigo");
	});

	it("descarta conteúdos vazios do legado", () => {
		const result = migrateLegacyBackup({
			version: "0.2.0",
			files: { "main.js": "", "styles.css": ".x{}", "manifest.json": "{}" },
		});
		expect(result!.meta.files).toEqual(["styles.css", "manifest.json"]);
		expect(result!.contents).toEqual({ "styles.css": ".x{}", "manifest.json": "{}" });
	});

	it("legado sem nenhum conteúdo vira null — sem metadado mentiroso", () => {
		expect(migrateLegacyBackup({ version: "0.1.0", files: {} })).toBeNull();
		expect(migrateLegacyBackup({ version: "0.1.0", files: { "main.js": "" } })).toBeNull();
	});
});

describe("readBackFromDisk — leitura de volta para o rollback", () => {
	const meta: VersionBackupMeta = {
		version: "0.2.0",
		files: ["main.js", "manifest.json"],
		backedUpAt: 1_700_000_000_000,
	};

	it("devolve só os nomes do metadado, na ordem", () => {
		const contents = readBackFromDisk(meta, {
			"main.js": "// bundle",
			"manifest.json": "{}",
			"styles.css": "/* lixo fora do backup */",
		});
		expect(Object.keys(contents)).toEqual(["main.js", "manifest.json"]);
	});

	it("arquivo que sumiu do disco simplesmente não vem — o módulo decide o erro", () => {
		const contents = readBackFromDisk(meta, { "main.js": "// bundle" });
		expect(contents).toEqual({ "main.js": "// bundle" });
	});

	it("nome estranho no metadado (settings editado à mão) é ignorado", () => {
		const tampered: VersionBackupMeta = { ...meta, files: ["main.js", "../../data.json"] };
		expect(readBackFromDisk(tampered, { "../../data.json": "segredo" })).toEqual({});
	});
});
