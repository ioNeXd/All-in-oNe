/**
 * BACKUP DE VERSÃO EM ARQUIVOS — REGRAS PURAS
 * -----------------------------------------------------------
 * O backup do rollback vivia INTEIRO dentro do data.json
 * (previousVersionBackup.files = main.js + manifest.json + styles.css como
 * strings). main.js sozinho passa de 1MB — cada save de config regravava
 * esse JSON gigante (custo multiplicado pelo write-behind do item 16),
 * inchava o sync do vault e o arquivo de config virava lixo ilegível.
 *
 * Contrato novo: os CONTEÚDOS moram em arquivos na pasta do plugin
 * (`.backup/`), e no settings sobra só o METADADO:
 *   { version, files: string[], backedUpAt }
 * `files` é a lista de nomes realmente copiados (styles.css é opcional) —
 * o rollback restaura exatamente o que foi guardado.
 *
 * Regras puras (sem Obsidian): decide O QUE copiar, ONDE mora no disco e
 * COMO migrar o formato legado. O I/O de arquivo fica no módulo.
 */

/** Arquivos candidatas ao backup — a mesma lista de assets do update. */
export const BACKUP_FILES = ["main.js", "manifest.json", "styles.css"] as const;

/** Pasta do backup, dentro da pasta do plugin. */
export const BACKUP_DIR = ".backup";

/** Metadado que mora no settings (pequeno, sempre). */
export interface VersionBackupMeta {
	version: string;
	/** Nomes dos arquivos efetivamente copiados para o disco. */
	files: string[];
	/** Epoch ms da cópia — diagnóstico: quão velho é este rollback. */
	backedUpAt: number;
}

/** Tipo legado (conteúdos inline no settings) — só existe para migrar. */
export interface LegacyVersionBackup {
	version: string;
	files: Record<string, string>;
}

/** Caminho absoluto no vault de um arquivo do backup. */
export function backupFilePath(pluginDir: string, name: string): string {
	if (!isBackupFileName(name)) {
		throw new RangeError(`Arquivo de backup não permitido: ${name}`);
	}
	return `${pluginDir}/${BACKUP_DIR}/${name}`;
}

/** Seleciona quais arquivos existem e devem ser copiados (styles.css é opcional). */
export function pickExisting(
	existence: Record<string, boolean>
): string[] {
	return BACKUP_FILES.filter((name) => existence[name] === true);
}

/**
 * Migra um backup LEGADO (conteúdos inline no data.json) para o formato novo.
 * Devolve o metadado para o settings + os conteúdos para o módulo gravar no
 * disco. Backup sem NENHUM conteúdo (arquivos não existiam na cópia) vira
 * `null`: não há o que restaurar, um metadado mentiroso só criaria um botão
 * "Reverter" que falha. Nomes fora da allowlist BACKUP_FILES são descartados
 * — o legado morava no data.json, que pode ter sido editado à mão.
 */
export function migrateLegacyBackup(
	legacy: LegacyVersionBackup
): { meta: VersionBackupMeta; contents: Record<string, string> } | null {
	const contents: Record<string, string> = {};
	for (const [name, content] of Object.entries(legacy.files)) {
		if (typeof content === "string" && content.length > 0 && isBackupFileName(name)) {
			contents[name] = content;
		}
	}
	if (Object.keys(contents).length === 0) return null;
	return {
		meta: {
			version: legacy.version,
			files: Object.keys(contents),
			backedUpAt: Date.now(),
		},
		contents,
	};
}

/**
 * Lê de volta os conteúdos do backup em disco, NA ORDEM do metadado.
 * Nomes fora da allowlist BACKUP_FILES são descartados: o metadado mora no
 * settings (editável à mão) e o rollback grava via caminho derivado do nome —
 * sem allowlist, um "../../data.json" no metadado escreveria FORA da pasta
 * do plugin. Arquivos que sumiram do disco entram como undefined — o
 * chamador decide: abortar com erro claro é o caminho do módulo.
 */
export function readBackFromDisk(
	meta: VersionBackupMeta,
	contents: Record<string, string | undefined>
): Record<string, string> {
	const result: Record<string, string> = {};
	for (const name of meta.files) {
		if (!isBackupFileName(name)) continue;
		const content = contents[name];
		if (typeof content === "string") result[name] = content;
	}
	return result;
}

/** Allowlist: só os arquivos conhecidos do plugin podem entrar num backup. */
function isBackupFileName(name: string): boolean {
	return (BACKUP_FILES as readonly string[]).includes(name);
}
