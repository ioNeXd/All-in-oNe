import { Notice, requestUrl, Setting } from "obsidian";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { HubModule, ModuleContext, ModuleManifest, ConfigValidationIssue } from "../../core/ModuleContract";
import type { HubSettings } from "../../core/types";
import { isNewerVersion, parseChecksums } from "./ReleaseUtils";
import {
	BACKUP_FILES,
	BACKUP_DIR,
	backupFilePath,
	pickExisting,
	migrateLegacyBackup,
	readBackFromDisk,
	type VersionBackupMeta,
} from "./UpdateBackup";
import {
	decideSignatureVerification,
	detectBratInstallation,
	findSignatureAsset,
	interpretGpgStatusOutput,
	runGpgCommand,
	shouldYieldToBrat,
	extractFingerprintFromArmoredKey,
} from "./SignatureUtils";

export interface AutoUpdateSettings {
	repo: string;
	channel: "stable" | "beta";
	lastCheckedAt: number;
	checkIntervalMs: number;
	lastKnownVersion?: string;
	previousVersionBackup?: VersionBackupMeta;
	verifySignature: boolean;
	signingPublicKey?: string;
}

export const AUTOUPDATE_DEFAULTS: AutoUpdateSettings = {
	repo: "ioNeXd/All-in-oNe",
	channel: "stable",
	lastCheckedAt: 0,
	checkIntervalMs: 1000 * 60 * 60 * 6,
	verifySignature: false,
};

interface GitHubRelease {
	tag_name: string;
	body: string;
	prerelease: boolean;
	assets: { name: string; browser_download_url: string }[];
}

/**
 * MÓDULO DE AUTO-UPDATE
 * ----------------------
 * Usa a API pública de Releases do GitHub (sem autenticação — 60 req/hora,
 * de sobra para uma checagem por sessão com o throttle abaixo). Baixa os
 * assets `main.js`, `manifest.json`, `styles.css` do release mais recente e
 * substitui os arquivos locais do plugin.
 *
 * O `repo` é fixo (hardcoded neste módulo / no manifest), nunca configurável
 * pelo usuário via UI — isso é uma medida de segurança deliberada: evita que
 * alguém consiga apontar o auto-update para um repositório malicioso.
 */
export class AutoUpdateModule implements HubModule {
	readonly manifest: ModuleManifest = {
		id: "autoupdate",
		displayName: "Auto-update",
		description: "Verifica e aplica atualizações do plugin a partir do GitHub Releases.",
		icon: "refresh-cw",
		version: "0.3.0",
		contractVersion: "2.0.0",
		desktopOnly: false,
		emits: ["autoupdate:available", "autoupdate:applied"],
		listensTo: [],
		settingsSchema: [
			{
				key: "channel",
				label: "Canal de atualização",
				type: "select",
				options: [
					{ value: "stable", label: "Estável" },
					{ value: "beta", label: "Beta (pré-lançamentos)" },
				],
				default: AUTOUPDATE_DEFAULTS.channel,
			},
		],
	};

	private context?: ModuleContext;
	private currentVersion = "";
	private managedByBrat = false;
	private bratYieldReason?: string;
	private lastSignatureStatus: { ok: boolean; detail: string } | undefined;

	onRegister(context: ModuleContext): void {
		this.context = context;
	}

	async onEnable(): Promise<void> {
		await this.migrateLegacyInlineBackup();
		await this.refreshBratStatus();

		if (this.managedByBrat) {
			this.context?.log("Auto-update cedido ao BRAT", { reason: this.bratYieldReason });
			return;
		}

		this.context!.registerCommand(
			"autoupdate-check-now",
			"Auto-update: Verificar atualizações agora",
			() => {
				void this.checkForUpdates({ manual: true });
			}
		);

		const settings = this.readSettings();
		if (Date.now() - settings.lastCheckedAt > settings.checkIntervalMs) {
			void this.checkForUpdates({ manual: false });
		}
	}

	private async migrateLegacyInlineBackup(): Promise<void> {
		const settings = this.readSettings();
		const backup = settings.previousVersionBackup as
			| { version: string; files: unknown }
			| undefined;
		if (!backup || Array.isArray(backup.files)) return;

		const migrated = migrateLegacyBackup(backup as never);
		if (!migrated) {
			await this.context?.updateSettings({ previousVersionBackup: undefined });
			return;
		}
		try {
			const adapter = this.context!.app.vault.adapter;
			const pluginDir = this.getPluginDir();
			await adapter.mkdir(`${pluginDir}/${BACKUP_DIR}`).catch(() => undefined);
			for (const [name, content] of Object.entries(migrated.contents)) {
				await adapter.write(backupFilePath(pluginDir, name), content);
			}
			await this.context?.updateSettings({ previousVersionBackup: migrated.meta });
			this.context?.log(
				`Backup do rollback migrado para .backup/ (versão ${migrated.meta.version})`
			);
		} catch (err) {
			console.error("[All iₙ oNe] Falha ao migrar backup legado do auto-update:", err);
		}
	}

	private async refreshBratStatus(): Promise<void> {
		const bratJson = await this.readBratDataJson();
		const detection = detectBratInstallation(bratJson, this.readSettings().repo);
		this.managedByBrat = shouldYieldToBrat(bratJson !== undefined, detection);
		this.bratYieldReason = detection.reason;
	}

	private async readBratDataJson(): Promise<string | undefined> {
		try {
			const adapter = this.context!.app.vault.adapter;
			const path = `${this.context!.app.vault.configDir}/plugins/obsidian42-brat/data.json`;
			if (!(await adapter.exists(path))) return undefined;
			return await adapter.read(path);
		} catch {
			return undefined;
		}
	}

	onDisable(): void {
		/* nada para limpar — sem timers persistentes além do check no onEnable */
	}

	setCurrentVersion(version: string): void {
		this.currentVersion = version;
	}

	getHealthStatus() {
		const settings = this.readSettings();
		if (this.managedByBrat) {
			return { ok: true, summary: "Atualização controlada pelo BRAT (módulo em espera)" };
		}
		const lastCheck = settings.lastCheckedAt
			? new Date(settings.lastCheckedAt).toLocaleString("pt-BR")
			: "nunca";
		const signature = settings.verifySignature ? " · verificação de assinatura ligada" : "";
		const sigStatus = this.lastSignatureStatus
			? ` · assinatura: ${this.lastSignatureStatus.detail}`
			: "";
		return {
			ok: this.lastSignatureStatus ? this.lastSignatureStatus.ok : true,
			summary: `Última verificação: ${lastCheck}${signature}${sigStatus}`,
		};
	}

	validateSettings(settings: HubSettings): ConfigValidationIssue[] {
		const mod = settings.modules.autoupdate as { signingPublicKey?: string } | undefined;
		const key = mod?.signingPublicKey;
		if (key && !key.includes("-----BEGIN PGP PUBLIC KEY BLOCK-----")) {
			return [
				{
					field: "signingPublicKey",
					level: "error",
					message:
						"A chave pública deve começar com '-----BEGIN PGP PUBLIC KEY BLOCK-----' (armadura ASCII exportada pelo gpg).",
				},
			];
		}
		return [];
	}

	renderSettingsPanel(container: HTMLElement): void {
		const settings = this.readSettings();

		if (this.managedByBrat) {
			container.createEl("p", {
				cls: "ione-hub-lobby__warning",
				text:
					`⚠️ O plugin BRAT está gerenciando este plugin (${this.bratYieldReason ?? "repo na lista do BRAT"}). ` +
					"As atualizações são controladas por ele — este módulo fica em espera para não competir " +
					"com o BRAT (duas ferramentas escrevendo os mesmos arquivos causaria corrupção). " +
					"Remova o plugin da lista do BRAT se quiser usar o auto-update próprio.",
			});
		}

		new Setting(container).setName("Repositório (fixo)").setDesc(settings.repo);
		new Setting(container).setName("Versão atual").setDesc(this.currentVersion || "desconhecida");

		new Setting(container)
			.setName("Canal de atualização")
			.addDropdown((dd) =>
				dd
					.addOption("stable", "Estável")
					.addOption("beta", "Beta (pré-lançamentos)")
					.setValue(settings.channel)
					.onChange(async (value) => {
						await this.context?.updateSettings({ channel: value as "stable" | "beta" });
					})
			);

		new Setting(container)
			.setName("Verificar assinatura GPG dos assets (experimental)")
			.setDesc(
				"Opt-in. Exige o programa 'gpg' instalado no computador. Ligada, um release SEM assinatura " +
					"(ou com assinatura que não bate com a chave abaixo) ABORTA a instalação — igual ao checksum. " +
					"Desligada, a proteção é o checksum SHA-256 publicado no corpo do release."
			)
			.addToggle((toggle) =>
				toggle.setValue(settings.verifySignature).onChange(async (value) => {
					await this.context?.updateSettings({ verifySignature: value });
				})
			);

		if (settings.verifySignature) {
			new Setting(container)
				.setName("Chave pública confiada (armadura ASCII)")
				.setDesc(
					"Cole aqui a chave pública de quem assina os releases (-----BEGIN PGP PUBLIC KEY BLOCK----- ...). " +
					"Fica no data.json local do vault, nunca sai da máquina."
				)
				.addTextArea((area) =>
					area.setValue(settings.signingPublicKey ?? "").onChange((v) => {
						area.inputEl.onblur = async () => {
							await this.context?.updateSettings({ signingPublicKey: area.getValue().trim() || undefined });
							new Notice("Chave pública salva.");
						};
					})
				);
		}

		new Setting(container)
			.setName("Verificar atualizações agora")
			.addButton((btn) =>
				btn.setButtonText("Verificar agora").onClick(() => this.checkForUpdates({ manual: true }))
			);

		new Setting(container)
			.setName("Reverter para a versão anterior")
			.setDesc(
				settings.previousVersionBackup
					? `Backup disponível: ${settings.previousVersionBackup.version}`
					: "Nenhum backup disponível ainda."
			)
			.addButton((btn) =>
				btn
					.setButtonText("Reverter")
					.setDisabled(!settings.previousVersionBackup)
					.onClick(() => {
						this.rollback().catch((err) => {
							console.error("[All iₙ oNe] Falha no rollback:", err);
							new Notice("All iₙ oNe: falha ao reverter. Veja o console.", 8000);
						});
					})
			);
	}

	private readSettings(): AutoUpdateSettings {
		return { ...AUTOUPDATE_DEFAULTS, ...this.context?.getSettings<AutoUpdateSettings>() };
	}

	/**
	 * Verifica atualizações. CONTRATO DO RETORNO:
	 *   - GitHubRelease = a versão foi apresentada ao usuário NESTA chamada.
	 *   - null = nada foi apresentado.
	 */
	async checkForUpdates(opts: { manual: boolean }): Promise<GitHubRelease | null> {
		if (this.managedByBrat) {
			if (opts.manual) {
				new Notice(
					"All iₙ oNe: o BRAT está gerenciando este plugin — as atualizações são controladas por ele. "
						+ "Este módulo não compete com o BRAT.",
					8000
				);
			}
			return null;
		}
		const settings = this.readSettings();
		try {
			const response = await requestUrl({
				url: `https://api.github.com/repos/${settings.repo}/releases`,
				method: "GET",
			});
			const releases = response.json as GitHubRelease[];
			const candidate = releases.find((r) => settings.channel === "beta" || !r.prerelease);

			await this.context?.updateSettings({ lastCheckedAt: Date.now() });

			if (!candidate) return null;

			const remoteVersion = candidate.tag_name.replace(/^v/, "");
			if (!isNewerVersion(remoteVersion, this.currentVersion)) {
				if (opts.manual && remoteVersion === this.currentVersion) {
					new Notice("All iₙ oNe: você já está na versão mais recente.");
				}
				return null;
			}

			if (!opts.manual && settings.lastKnownVersion === remoteVersion) {
				return null;
			}

			this.notifyUpdateAvailable(remoteVersion, candidate);
			await this.context?.bus.emit(
				"autoupdate:available",
				{ version: remoteVersion },
				"autoupdate"
			);
			return candidate;
		} catch (err) {
			console.error("[All iₙ oNe] Falha ao checar atualizações:", err);
			if (opts.manual) new Notice("All iₙ oNe: não foi possível checar atualizações agora.");
			return null;
		}
	}

	private notifyUpdateAvailable(version: string, release: GitHubRelease): void {
		const notice = new Notice("", 0);
		const container = notice.noticeEl;
		container.createEl("div", { text: `Nova versão disponível: ${version}` });
		const changelog = container.createEl("div", { cls: "ione-hub-changelog" });
		changelog.setText(release.body.slice(0, 300));

		const actions = container.createEl("div", { cls: "ione-hub-notice-actions" });
		const updateBtn = actions.createEl("button", { text: "Atualizar" });
		const dismissBtn = actions.createEl("button", { text: "Ignorar" });

		updateBtn.onclick = () => {
			notice.hide();
			void this.applyUpdate(release);
		};
		dismissBtn.onclick = () => {
			notice.hide();
			void this.context?.updateSettings({ lastKnownVersion: version });
		};
	}

	/**
	 * Aplica uma atualização de forma SEGURA:
	 *   1. Valida assinatura (se habilitada) — antes de qualquer I/O.
	 *   2. Baixa + valida checksum de TODOS os assets antes de escrever.
	 *   3. Cria backup dos arquivos atuais.
	 *   4. Substitui os arquivos.
	 *   5. Se QUALQUER escrita falhar, restaura do backup e preserva o erro original.
	 */
	async applyUpdate(release: GitHubRelease): Promise<void> {
		const settings = this.readSettings();
		const assetNames = ["main.js", "manifest.json", "styles.css"];
		const downloaded: Record<string, string> = {};
		let backupCreated = false;

		// FASE 1: Validação de assinatura (opt-in) — antes de qualquer I/O de download.
		if (settings.verifySignature) {
			const hasAnySignature = assetNames.some((n) => !!findSignatureAsset(release.assets, n));
			if (!hasAnySignature) {
				const decision = decideSignatureVerification({
					enabled: true,
					signaturePresent: false,
					verificationAvailable: true,
					assetName: assetNames[0],
				});
				throw new Error(decision.reason ?? "Assinatura ausente.");
			}
		}

		const expected = parseChecksums(release.body);

		// FASE 2: Baixa TUDO e valida (checksum + assinatura) ANTES de escrever.
		for (const name of assetNames) {
			const asset = release.assets.find((a) => a.name === name);
			if (!asset) {
				if (name !== "styles.css") {
					throw new Error(
						`Asset obrigatório "${name}" ausente no release. ` +
						"Release malformado — instalação abortada."
					);
				}
				continue;
			}
			const content = await requestUrl({ url: asset.browser_download_url, method: "GET" });

			if (settings.verifySignature) {
				const sigAsset = findSignatureAsset(release.assets, name);
				const decision = decideSignatureVerification({
					enabled: true,
					signaturePresent: !!sigAsset,
					verificationAvailable: true,
					assetName: name,
				});
				if (decision.action === "abort") throw new Error(decision.reason);
				const check = await this.verifyAssetSignature(name, sigAsset!.url, content.text);
				this.lastSignatureStatus = check.valid
					? { ok: true, detail: `assinatura verificada (${name})` }
					: { ok: false, detail: `assinatura de "${name}" reprovada: ${check.reason ?? "inválida"}` };
				if (!check.valid) {
					throw new Error(`Assinatura do arquivo "${name}" ${check.reason ?? "inválida"} — instalação abortada por segurança.`);
				}
			}

			if (!expected[name]) {
				if (name !== "styles.css") {
					throw new Error(
						`Asset obrigatório "${name}" sem checksum declarado no release. ` +
						"Release malformado — instalação abortada por segurança."
					);
				}
			} else {
				const actual = await sha256Hex(content.text);
				if (actual !== expected[name].toLowerCase()) {
					throw new Error(
						`Checksum do arquivo "${name}" não confere. Download abortado por segurança.`
					);
				}
			}
			downloaded[name] = content.text;
		}

		// FASE 3: Backup antes da primeira escrita.
		try {
			await this.backupCurrentVersion();
			backupCreated = true;
		} catch (backupErr) {
			console.error("[All iₙ oNe] Falha ao criar backup para atualização:", backupErr);
		}

		// FASE 4: Escrita. Se QUALQUER escrita falhar, restaura do backup
		// e preserva o erro original (mesmo se rollback também falhar).
		const originalErr = new Error("");
		try {
			for (const [name, content] of Object.entries(downloaded)) {
				await this.writePluginFile(name, content);
			}
		} catch (writeErr) {
			originalErr.message = writeErr instanceof Error ? writeErr.message : String(writeErr);

			if (backupCreated) {
				try {
					await this.rollback();
				} catch (rollbackErr) {
					console.error(
						"[All iₙ oNe] Rollback também falhou após falha de atualização:",
						rollbackErr
					);
				}
			}

			throw originalErr;
		}

		new Notice("All iₙ oNe atualizado. Recarregue o Obsidian ou recarregue o plugin para aplicar.");
		await this.context?.bus.emit(
			"autoupdate:applied",
			{ version: release.tag_name },
			"autoupdate"
		);
		this.context?.log(`Plugin atualizado para ${release.tag_name}`);
	}

	/**
	 * Verifica a assinatura de um asset num KEYRING TEMPORÁRIO isolado.
	 * Quando a chave pública é configurada, valida que o fingerprint da
	 * chave que assinou EXATAMENTE confere com o fingerprint derivado da
	 * chave pública configurada — rejeita qualquer assinatura válida de
	 * chave diferente no keyring.
	 */
	private async verifyAssetSignature(
		assetName: string,
		signatureUrl: string,
		assetContent: string
	): Promise<{ valid: boolean; reason?: string; keyFingerprint?: string }> {
		const settings = this.readSettings();
		if (!settings.signingPublicKey?.trim()) {
			this.lastSignatureStatus = {
				ok: false,
				detail: "chave pública não configurada — verificação ligada não pôde rodar",
			};
			return {
				valid: false,
				reason: "nenhuma chave pública foi configurada no painel do módulo (cole a chave pública de quem assina os releases)",
			};
		}

		// Extrai o fingerprint esperado da chave pública armazenada.
		const expectedFingerprint = extractFingerprintFromArmoredKey(settings.signingPublicKey);
		if (!expectedFingerprint) {
			this.lastSignatureStatus = {
				ok: false,
				detail: "não foi possível extrair fingerprint da chave pública configurada",
			};
			return {
				valid: false,
				reason: "não foi possível extrair o fingerprint da chave pública configurada. Verifique se a armadura está completa.",
			};
		}

		const tempDir = await mkdtemp(path.join(tmpdir(), "all-in-one-gpg-"));
		try {
			const keyPath = path.join(tempDir, "trusted-key.asc");
			const sigPath = path.join(tempDir, `${assetName}.sig`);
			const dataPath = path.join(tempDir, assetName);
			await writeFile(keyPath, settings.signingPublicKey);

			const sigResponse = await requestUrl({ url: signatureUrl, method: "GET" });
			await writeFile(sigPath, new Uint8Array(sigResponse.arrayBuffer));
			await writeFile(dataPath, assetContent);

			const gnupghome = path.join(tempDir, "gnupg");
			await mkdir(gnupghome, { recursive: true });
			const env = { ...process.env, GNUPGHOME: gnupghome };
			const importRun = await runGpgCommand(["--batch", "--import", keyPath], env);
			if (importRun.code !== 0) {
				return { valid: false, reason: `falha ao importar a chave pública no keyring temporário: ${importRun.stderr.slice(0, 200)}` };
			}
			const verifyRun = await runGpgCommand(["--batch", "--status-fd", "1", "--verify", sigPath, dataPath], env);
			const outcome = interpretGpgStatusOutput(verifyRun.stdout);

			// Validação de identidade: mesmo que o gpg diga GOODSIG, o
			// fingerprint da chave que assinou deve bater com o configurado.
			if (outcome.valid && outcome.keyFingerprint) {
				const normalizedSigning = normalizeFingerprint(outcome.keyFingerprint);
				const normalizedExpected = normalizeFingerprint(expectedFingerprint);
				if (normalizedSigning !== normalizedExpected) {
					return {
						valid: false,
						reason: `a assinatura foi feita pela chave ${outcome.keyFingerprint} mas a chave confiada é ${expectedFingerprint} — assinatura de chave não confiada rejeitada`,
						keyFingerprint: outcome.keyFingerprint,
					};
				}
			} else if (outcome.valid && !outcome.keyFingerprint) {
				return {
					valid: false,
					reason: "gpg reportou assinatura válida mas não forneceu fingerprint para validação de identidade",
				};
			}

			return outcome;
		} finally {
			await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
		}
	}

	private async backupCurrentVersion(): Promise<void> {
		const adapter = this.context!.app.vault.adapter;
		const pluginDir = this.getPluginDir();
		const existence: Record<string, boolean> = {};
		for (const name of BACKUP_FILES) {
			existence[name] = await adapter.exists(`${pluginDir}/${name}`);
		}
		const toCopy = pickExisting(existence);
		if (toCopy.length === 0) return;

		await adapter.mkdir(`${pluginDir}/${BACKUP_DIR}`).catch(() => undefined);
		for (const name of toCopy) {
			const content = await adapter.read(`${pluginDir}/${name}`);
			await adapter.write(backupFilePath(pluginDir, name), content);
		}
		await this.context?.updateSettings({
			previousVersionBackup: {
				version: this.currentVersion,
				files: toCopy,
				backedUpAt: Date.now(),
			},
		});
	}

	async rollback(): Promise<void> {
		const settings = this.readSettings();
		const backup = settings.previousVersionBackup;
		if (!backup) {
			new Notice("All iₙ oNe: não há versão anterior salva para rollback.");
			return;
		}
		const adapter = this.context!.app.vault.adapter;
		const pluginDir = this.getPluginDir();
		const diskContents: Record<string, string | undefined> = {};
		for (const name of backup.files) {
			diskContents[name] = await adapter
				.read(backupFilePath(pluginDir, name))
				.catch(() => undefined);
		}
		const toRestore = readBackFromDisk(backup, diskContents);
		if (Object.keys(toRestore).length === 0) {
			await this.context?.updateSettings({ previousVersionBackup: undefined });
			new Notice(
				"All iₙ oNe: o backup da versão anterior não está mais legível (pasta .backup apagada?). Não há como reverter."
			);
			return;
		}
		for (const [name, content] of Object.entries(toRestore)) {
			await this.writePluginFile(name, content);
		}
		new Notice(`All iₙ oNe: revertido para ${backup.version}. Recarregue o plugin.`);
	}

	private getPluginDir(): string {
		return `${this.context!.app.vault.configDir}/plugins/All-in-oNe`;
	}

	private async writePluginFile(name: string, content: string): Promise<void> {
		const adapter = this.context!.app.vault.adapter;
		const path = `${this.getPluginDir()}/${name}`;
		await adapter.write(path, content);
	}
}

/**
 * Lê checksums declarados no corpo do release, em linhas no formato:
 *   `sha256 main.js: <hash>`
 */
async function sha256Hex(text: string): Promise<string> {
	const bytes = new TextEncoder().encode(text);
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/**
 * Normaliza fingerprint GPG: remove espaços, maiúsculas, prefixo 0x.
 * GPG pode reportar "0x ABCD 1234" ou "ABCD1234" — a comparação deve
 * ser insensível a essas variações.
 */
function normalizeFingerprint(fp: string): string {
	return fp.replace(/\s+/g, "").replace(/^0x/i, "").toLowerCase();
}
