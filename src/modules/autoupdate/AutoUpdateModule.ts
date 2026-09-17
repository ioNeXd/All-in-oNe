import { Notice, requestUrl, Setting } from "obsidian";
import type { HubModule, ModuleContext, ModuleManifest } from "../../core/ModuleContract";

export interface AutoUpdateSettings {
	repo: string; // formato "usuario/repositorio" — hardcoded no manifesto do plugin, não editável por terceiros
	channel: "stable" | "beta";
	lastCheckedAt: number;
	checkIntervalMs: number;
	lastKnownVersion?: string;
	previousVersionBackup?: { version: string; files: Record<string, string> };
}

export const AUTOUPDATE_DEFAULTS: AutoUpdateSettings = {
	repo: "ioNeXd/All-in-oNe", // ajuste para o repositório real do plugin
	channel: "stable",
	lastCheckedAt: 0,
	checkIntervalMs: 1000 * 60 * 60 * 6, // checa no máximo a cada 6h automaticamente
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
		version: "0.1.0",
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

	onRegister(context: ModuleContext): void {
		this.context = context;
	}

	onEnable(): void {
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

	onDisable(): void {
		/* nada para limpar — sem timers persistentes além do check no onEnable */
	}

	setCurrentVersion(version: string): void {
		this.currentVersion = version;
	}

	getHealthStatus() {
		const settings = this.readSettings();
		const lastCheck = settings.lastCheckedAt
			? new Date(settings.lastCheckedAt).toLocaleString("pt-BR")
			: "nunca";
		return { ok: true, summary: `Última verificação: ${lastCheck}` };
	}

	renderSettingsPanel(container: HTMLElement): void {
		const settings = this.readSettings();

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
					.onClick(() => this.rollback())
			);
	}

	private readSettings(): AutoUpdateSettings {
		return { ...AUTOUPDATE_DEFAULTS, ...this.context?.getSettings<AutoUpdateSettings>() };
	}

	async checkForUpdates(opts: { manual: boolean }): Promise<GitHubRelease | null> {
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
			if (remoteVersion === this.currentVersion) {
				if (opts.manual) new Notice("All iₙ oNe: você já está na versão mais recente.");
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
		dismissBtn.onclick = () => notice.hide();
	}

	async applyUpdate(release: GitHubRelease): Promise<void> {
		try {
			await this.backupCurrentVersion();

			const expected = parseChecksums(release.body);
			const assetNames = ["main.js", "manifest.json", "styles.css"];
			const downloaded: Record<string, string> = {};

			// Baixa TUDO e verifica ANTES de escrever qualquer arquivo — assim um
			// checksum ruim no meio do caminho não deixa a instalação pela metade.
			for (const name of assetNames) {
				const asset = release.assets.find((a) => a.name === name);
				if (!asset) continue; // styles.css é opcional
				const content = await requestUrl({ url: asset.browser_download_url, method: "GET" });

				if (expected[name]) {
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
			new Notice("All iₙ oNe: falha ao aplicar a atualização. Nenhum arquivo foi corrompido.");
		}
	}

	/** Guarda uma cópia dos arquivos atuais antes de sobrescrever — permite rollback. */
	private async backupCurrentVersion(): Promise<void> {
		const adapter = this.context!.app.vault.adapter;
		const pluginDir = this.getPluginDir();
		const files: Record<string, string> = {};
		for (const name of ["main.js", "manifest.json", "styles.css"]) {
			const path = `${pluginDir}/${name}`;
			if (await adapter.exists(path)) {
				files[name] = await adapter.read(path);
			}
		}
		await this.context?.updateSettings({
			previousVersionBackup: { version: this.currentVersion, files },
		});
	}

	async rollback(): Promise<void> {
		const settings = this.readSettings();
		const backup = settings.previousVersionBackup;
		if (!backup) {
			new Notice("All iₙ oNe: não há versão anterior salva para rollback.");
			return;
		}
		for (const [name, content] of Object.entries(backup.files)) {
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
 * Se o release não declarar nenhum, a verificação é simplesmente pulada
 * (não é obrigatório — mas quando existe, precisa bater).
 */
function parseChecksums(body: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const line of (body ?? "").split("\n")) {
		const match = line.match(/sha256\s+([\w.\-]+)\s*[:=]\s*([a-fA-F0-9]{64})/);
		if (match) result[match[1]] = match[2];
	}
	return result;
}

async function sha256Hex(text: string): Promise<string> {
	const bytes = new TextEncoder().encode(text);
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}
