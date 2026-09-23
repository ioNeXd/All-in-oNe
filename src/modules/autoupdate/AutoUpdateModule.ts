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
} from "./SignatureUtils";

export interface AutoUpdateSettings {
	repo: string; // formato "usuario/repositorio" — hardcoded no manifesto do plugin, não editável por terceiros
	channel: "stable" | "beta";
	lastCheckedAt: number;
	checkIntervalMs: number;
	lastKnownVersion?: string;
	/**
	 * Metadado do backup de rollback — SÓ o metadado (pequeno). Os CONTEÚDOS
	 * moram em arquivos sob `<pasta do plugin>/.backup/` (main.js passa de
	 * 1MB; inline no data.json inchava cada save de config e o sync). Sem
	 * backup: undefined.
	 */
	previousVersionBackup?: VersionBackupMeta;
	/**
	 * Opt-in: verificar a assinatura GPG dos assets antes de instalar.
	 * Ligada, a ausência de assinatura no release (ou do binário gpg) ABORTA
	 * a instalação — habilitar cria a obrigação de cumpri-la.
	 */
	verifySignature: boolean;
	/** Chave pública (armadura ASCII) confiada pelo usuário para a verificação. */
	signingPublicKey?: string;
}

export const AUTOUPDATE_DEFAULTS: AutoUpdateSettings = {
	// Repositório real deste plugin (confere com o remote do git). FIXO de
	// propósito — nunca configurável pela UI: apontar o auto-update para
	// outro repo abriria caminho para atualização maliciosa.
	repo: "ioNeXd/All-in-oNe",
	channel: "stable",
	lastCheckedAt: 0,
	checkIntervalMs: 1000 * 60 * 60 * 6, // checa no máximo a cada 6h automaticamente
	verifySignature: false, // opt-in — sem isso, proteção = checksum do release
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
		version: "0.2.0",
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
	private currentVersion = ""; // preenchido pelo main.ts a partir do manifest.json real
	/** true quando o BRAT está instalado E gerencia este plugin — módulo cede o controle. */
	private managedByBrat = false;
	/** Motivo do yield ao BRAT, para o painel. */
	private bratYieldReason?: string;
	/** Estado da ÚLTIMA verificação de assinatura — alimenta o Diagnóstico. */
	private lastSignatureStatus: { ok: boolean; detail: string } | undefined;

	onRegister(context: ModuleContext): void {
		this.context = context;
	}

	async onEnable(): Promise<void> {
		await this.migrateLegacyInlineBackup();

		// Interoperabilidade com o BRAT: se o BRAT gerencia este plugin, ele é
		// o dono do ciclo de atualização — duas mãos escrevendo main.js é
		// corrida de escrita (e rollback de dois donos). O módulo CEDe: sem
		// checagem automática, sem comando, sem notificação.
		await this.refreshBratStatus();

		if (this.managedByBrat) {
			this.context?.log("Auto-update cedido ao BRAT", { reason: this.bratYieldReason });
			return; // sem comando e sem checagem automática
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

	/**
	 * Migração do formato LEGADO do backup (conteúdos inline no data.json →
	 * arquivos em .backup/): roda no primeiro onEnable após a atualização,
	 * escreve os arquivos e troca o metadado. Em caso de falha de escrita, o
	 * legado PERMANECE no settings (rollback continua funcionando pelo caminho
	 * antigo) — migração idempotente, tenta de novo no próximo enable.
	 */
	private async migrateLegacyInlineBackup(): Promise<void> {
		const settings = this.readSettings();
		const backup = settings.previousVersionBackup as
			| { version: string; files: unknown }
			| undefined;
		// Formato novo já (files: string[]) → nada a fazer. Detecção: no legado,
		// `files` é um Record de conteúdos; no novo, um array de nomes.
		if (!backup || Array.isArray(backup.files)) return;

		const migrated = migrateLegacyBackup(backup as never);
		if (!migrated) {
			// Legado vazio (sem conteúdos): o botão "Reverter" nunca funcionaria —
			// limpa o metadado em vez de manter uma promessa falsa.
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
			// Sem trocar o metadado: o legado continua restaurável pelo caminho
			// antigo; a migração tenta de novo no próximo onEnable.
			console.error("[All iₙ oNe] Falha ao migrar backup legado do auto-update:", err);
		}
	}

	/** Reavalia o BRAT a cada onEnable (o usuário pode ter instalado/desinstalado desde o load). */
	private async refreshBratStatus(): Promise<void> {
		const bratJson = await this.readBratDataJson();
		const detection = detectBratInstallation(bratJson, this.readSettings().repo);
		// A regra de ceder é a função pura testada — o módulo não re-decide.
		this.managedByBrat = shouldYieldToBrat(bratJson !== undefined, detection);
		this.bratYieldReason = detection.reason;
	}

	/**
	 * Lê o data.json do BRAT (plugins/.obsidian42-brat), se ele existir.
	 * Qualquer falha de leitura devolve undefined — a checagem de update
	 * própria nunca pode quebrar por causa de um plugin de terceiros.
	 */
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

	/**
	 * A chave pública colada pelo usuário tem de parecer uma armadura OpenPGP;
	 * qualquer outra coisa é quase sempre erro de colagem (CSS, log, texto).
	 * Síncrono e barato — só o cabeçalho é inspecionado, sem I/O.
	 */
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
						// sem salvamento a cada tecla (armadura é grande); salvamento no blur:
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
						// rollback escreve arquivos no disco — sem catch, uma falha de
						// IO viraria rejection não tratada sem aviso algum.
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
	 * Verifica atualizações. CONTRATO DO RETORNO (documentado de propósito,
	 * ver item de revisão — o antigo branch "ignorado" devolvia o release
	 * SEM notificar, e um caller futuro podia auto-aplicar sem UI):
	 *
	 *   - GitHubRelease = a versão foi apresentada ao usuário NESTA chamada
	 *     (notice com botões Atualizar/Ignorar + evento autoupdate:available).
	 *     O retorno é só para feedback de chamadores DE UI (ex.: painel que
	 *     quer atualizar o próprio resumo) — NUNCA um gatilho para aplicar.
	 *   - null = nada foi apresentado (sem candidate, mesma versão, versão
	 *     dispensada pelo usuário, BRAT no controle ou falha de rede).
	 *
	 * Ou seja: "candidate no retorno" ⇒ "usuário notificado". O fluxo de
	 * instalação mora EXCLUSIVAMENTE no botão do notice (applyUpdate);
	 * caller nenhum deve agir sobre o retorno além de exibir estado.
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
			// Comparação SemVer real: v0.10.0 > v0.9.0 (a comparação de string
			// tratava "0.10.0" < "0.9.0" lexicograficamente e "0.2.0" == "0.2").
			if (!isNewerVersion(remoteVersion, this.currentVersion)) {
				if (opts.manual && remoteVersion === this.currentVersion) {
					new Notice("All iₙ oNe: você já está na versão mais recente.");
				}
				return null;
			}

			// "Ignorar" significa ignorar ESTA versão: o lastKnownVersion guarda
			// a versão dispensada, e a notificação automática não reaparece a
			// cada 6h pela mesma versão. Checagem manual sempre mostra — o
			// usuário pediu explicitamente.
			if (!opts.manual && settings.lastKnownVersion === remoteVersion) {
				// Versão dispensada: NADA é apresentado → null (contrato acima).
				// O antigo `return candidate` aqui era o vício: devolvia o release
				// sem notificar, quebrando a implicação "retorno ⇒ notificado".
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
			// Persiste a versão dispensada para o próximo ciclo de 6h não re-avisar.
			void this.context?.updateSettings({ lastKnownVersion: version });
		};
	}

	async applyUpdate(release: GitHubRelease): Promise<void> {
		try {
			const settings = this.readSettings();
			const assetNames = ["main.js", "manifest.json", "styles.css"];
			const downloaded: Record<string, string> = {};

			// Assinatura (opt-in): decide por asset se a verificação é obrigatória
			// e, quando é, verifica ANTES de escrever qualquer arquivo — mesmo
			// esqueleto do checksum: tudo validado antes da primeira escrita, para
			// não deixar instalação pela metade.
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

			await this.backupCurrentVersion();

			const expected = parseChecksums(release.body);

			// Baixa TUDO e verifica ANTES de escrever qualquer arquivo — assim um
			// checksum ruim no meio do caminho não deixa a instalação pela metade.
			for (const name of assetNames) {
				const asset = release.assets.find((a) => a.name === name);
				if (!asset) continue; // styles.css é opcional
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
					// Guarda o desfecho para o Diagnóstico: ok nunca esconde uma
					// verificação que reprovou; reprovada mantém o resumo honesto
					// até a próxima verificação bem-sucedida.
					this.lastSignatureStatus = check.valid
						? { ok: true, detail: `assinatura verificada (${name})` }
						: { ok: false, detail: `assinatura de "${name}" reprovada: ${check.reason ?? "inválida"}` };
					if (!check.valid) {
						throw new Error(`Assinatura do arquivo "${name}" ${check.reason ?? "inválida"} — instalação abortada por segurança.`);
					}
				}

				// main.js e manifest.json são obrigatórios: asset existe + checksum
				// ausente = release malformado. styles.css é opcional (pode faltar
				// checksum sem problema — ele não existe em todos os releases).
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

			for (const [name, content] of Object.entries(downloaded)) {
				await this.writePluginFile(name, content);
			}

			new Notice("All iₙ oNe atualizado. Recarregue o Obsidian ou recarregue o plugin para aplicar.");
			await this.context?.bus.emit(
				"autoupdate:applied",
				{ version: release.tag_name },
				"autoupdate"
			);
			this.context?.log(`Plugin atualizado para ${release.tag_name}`);
		} catch (err) {
			console.error("[All iₙ oNe] Falha ao aplicar atualização:", err);
			// Honestidade: "nenhum arquivo foi corrompido" só vale para falha de
			// checksum/assinatura ANTES da escrita. Se a falha foi no meio da
			// escrita (IO, disco cheio), o backup feito no início permite rollback.
			new Notice(
				`All iₙ oNe: falha ao aplicar a atualização: ${err instanceof Error ? err.message : String(err)} — nenhum arquivo foi escrito se a falha ocorreu antes da gravação. Se o plugin não carregar, use "Reverter para a versão anterior" no painel do módulo.`,
				10000
			);
		}
	}

	/**
	 * Verifica a assinatura de um asset num KEYRING TEMPORÁRIO isolado:
	 * nunca toca no keyring do usuário — importa a chave pública configurada
	 * para uma pasta de casa (GNUPGHOME própria), verifica e descarta.
	 * Falha de execução (gpg ausente, permissão) propaga — o chamador decide
	 * (decisão fechada: com a verificação ligada, não rodar = abortar).
	 */
	private async verifyAssetSignature(
		assetName: string,
		signatureUrl: string,
		assetContent: string
	): Promise<{ valid: boolean; reason?: string; keyFingerprint?: string }> {
		const settings = this.readSettings();				if (!settings.signingPublicKey?.trim()) {
					this.lastSignatureStatus = {
						ok: false,
						detail: "chave pública não configurada — verificação ligada não pôde rodar",
					};
			return {
				valid: false,
				reason: "nenhuma chave pública foi configurada no painel do módulo (cole a chave pública de quem assina os releases)",
			};
		}

		const tempDir = await mkdtemp(path.join(tmpdir(), "all-in-one-gpg-"));
		try {
			const keyPath = path.join(tempDir, "trusted-key.asc");
			const sigPath = path.join(tempDir, `${assetName}.sig`);
			const dataPath = path.join(tempDir, assetName);
			await writeFile(keyPath, settings.signingPublicKey);

			// O .sig é BINÁRIO (formato OpenPGP) — lê como arrayBuffer, nunca como
			// texto (a conversão para string corromperia os bytes da assinatura).
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
			return interpretGpgStatusOutput(verifyRun.stdout);
		} finally {
			await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
		}
	}

	/**
	 * Guarda uma cópia dos arquivos atuais antes de sobrescrever — permite
	 * rollback. Os CONTEÚDOS vão para arquivos em `.backup/` (na pasta do
	 * plugin); no settings entra só o metadado — o data.json deixou de
	 * carregar main.js inteiro a cada save.
	 */
	private async backupCurrentVersion(): Promise<void> {
		const adapter = this.context!.app.vault.adapter;
		const pluginDir = this.getPluginDir();
		const existence: Record<string, boolean> = {};
		for (const name of BACKUP_FILES) {
			existence[name] = await adapter.exists(`${pluginDir}/${name}`);
		}
		const toCopy = pickExisting(existence);
		if (toCopy.length === 0) return; // nada a copiar — sem metadado mentiroso

		await adapter.mkdir(`${pluginDir}/${BACKUP_DIR}`).catch(() => undefined); // já existe = ok
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

	/**
	 * Restaura a versão anterior: lê os conteúdos de `.backup/` e reescreve
	 * os arquivos do plugin. Backup em ARQUIVOS (metadado pequeno no settings).
	 */
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
			// Metadado sem nenhum arquivo legível: o backup apodreceu (usuário
			// apagou a pasta, sync conflitante). O botão morre COM aviso claro —
			// nunca um rollback que escreve nada e "funciona".
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
		// Deve bater com o `id` do manifest.json — o Obsidian instala o plugin
		// em plugins/<id>/. Se o id mudar um dia, mudar aqui JUNTO (a Rodada 7
		// já trocou o id uma vez; atualizar só um dos lados faria o update
		// gravar main.js/manifest.json numa pasta que o Obsidian não lê).
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
 * Se o release não declarar nenhum, a verificação é simplesmente pulada
 * (não é obrigatório — mas quando existe, precisa bater).
 */
async function sha256Hex(text: string): Promise<string> {
	const bytes = new TextEncoder().encode(text);
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}
