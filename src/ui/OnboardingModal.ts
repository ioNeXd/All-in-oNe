import { App, Modal, Notice, Setting } from "obsidian";
import type { HubCore } from "../core/HubCore";
import { ensureVaultFolder } from "../core/VaultPaths";
import { resolvePaths } from "../core/PathResolver";
import { DEFAULT_PATHS } from "../core/types";

type Step = "tour" | "config" | "style";
type PathKey = "calendarFolder" | "calendarTemplatesFolder" | "inboxFolder" | "systemFolder" | "filesFolder";

export class OnboardingModal extends Modal {
	private step: Step = "tour";
	private calendarFolder: string;
	private calendarTemplatesFolder: string;
	private eventNotesFolder: string;
	private inboxFolder: string;
	private systemFolder: string;
	private filesFolder: string;
	private tourIndex = 0;

	constructor(app: App, private core: HubCore) {
		super(app);
		const paths = resolvePaths(core.settings.get().paths);
		this.calendarFolder = paths.calendarFolder;
		this.calendarTemplatesFolder = paths.calendarTemplatesFolder;
		this.eventNotesFolder = paths.eventNotesFolder;
		this.inboxFolder = paths.inboxFolder;
		this.systemFolder = paths.systemFolder;
		this.filesFolder = paths.filesFolder;
	}

	onOpen(): void { this.render(); }

	private render(): void {
		this.contentEl.empty();
		if (this.step === "tour") this.renderTour();
		else if (this.step === "config") this.renderConfig();
		else this.renderStyle();
	}

	private renderTour(): void {
		const pages: [string, string][] = [
			["All-in-oNe", "Um hub modular para organizar seu vault, calendário, templates, estilos e ferramentas."],
			["Calendário", "Crie notas por data, use templates, marque eventos e receba lembretes."],
			["Templates e Estilos", "Templates automatizam notas por pasta; Estilos centraliza a aparência do plugin e do Obsidian."],
			["Pronto", "Depois do tour, você poderá revisar os caminhos e escolher um estilo inicial."],
		];
		const [title, body] = pages[this.tourIndex];
		this.contentEl.createEl("h2", { text: title });
		this.contentEl.createEl("p", { text: body });
		this.contentEl.createEl("p", { cls: "ione-hub-lobby__description", text: `${this.tourIndex + 1} / ${pages.length}` });
		const footer = this.contentEl.createDiv({ cls: "ione-hub-onboarding__footer" });
		footer.createEl("button", { text: "Pular tour" }).onclick = () => { this.step = "config"; this.render(); };
		const next = footer.createEl("button", { text: this.tourIndex === pages.length - 1 ? "Configurar" : "Próximo", cls: "mod-cta" });
		next.onclick = () => {
			if (this.tourIndex === pages.length - 1) { this.step = "config"; this.render(); }
			else { this.tourIndex++; this.render(); }
		};
	}

	private renderConfig(): void {
		this.contentEl.createEl("h2", { text: "Configuração inicial" });
		this.contentEl.createEl("p", { text: "Os caminhos derivados acompanham as raízes. Caminhos personalizados existentes são preservados." });
		const fields: Array<[PathKey, string, string]> = [
			["calendarFolder", "Calendário", DEFAULT_PATHS.calendarFolder],
			["calendarTemplatesFolder", "Templates", DEFAULT_PATHS.calendarTemplatesFolder],
			["eventNotesFolder", "Notas de eventos", DEFAULT_PATHS.eventNotesFolder],
			["inboxFolder", "Inbox", DEFAULT_PATHS.inboxFolder],
			["systemFolder", "Sistema", DEFAULT_PATHS.systemFolder],
			["filesFolder", "Arquivos", DEFAULT_PATHS.filesFolder],
		];
		for (const [key, label, placeholder] of fields) {
			new Setting(this.contentEl).setName(label).addText((text) => {
				text.setValue(String(this[key]));
				text.setPlaceholder(placeholder);
				text.onChange((value) => { this[key] = value.trim(); });
			});
		}
		const footer = this.contentEl.createDiv({ cls: "ione-hub-onboarding__footer" });
		footer.createEl("button", { text: "Pular configuração" }).onclick = () => void this.finish();
		footer.createEl("button", { text: "Continuar", cls: "mod-cta" }).onclick = () => { this.step = "style"; this.render(); };
	}

	private renderStyle(): void {
		this.contentEl.createEl("h2", { text: "Estilo inicial" });
		this.contentEl.createEl("p", { text: "Esta é a mesma interface de temas do módulo Estilos, sem uma segunda implementação no onboarding." });
		const panel = this.contentEl.createDiv({ cls: "ione-hub-onboarding__style-preview" });
		const styles = this.core.getModules().find((module) => module.manifest.id === "styles");
		if (styles && "renderOnboardingPicker" in styles && typeof (styles as { renderOnboardingPicker?: (container: HTMLElement) => void }).renderOnboardingPicker === "function") {
			(styles as { renderOnboardingPicker: (container: HTMLElement) => void }).renderOnboardingPicker(panel);
		} else if (styles?.renderSettingsPanel) {
			styles.renderSettingsPanel(panel);
		} else {
			panel.createEl("p", { text: "O módulo Estilos não está disponível neste momento. Você poderá configurar o estilo depois." });
		}
		const footer = this.contentEl.createDiv({ cls: "ione-hub-onboarding__footer" });
		footer.createEl("button", { text: "Ignorar" }).onclick = () => void this.finish();
		footer.createEl("button", { text: "Concluir", cls: "mod-cta" }).onclick = () => void this.finish();
	}

	private async finish(): Promise<void> {
		const settings = this.core.settings.get();
		const next = {
			...settings,
			onboardingCompleted: true,
			paths: {
				...settings.paths,
				calendarFolder: this.calendarFolder,
				calendarTemplatesFolder: this.calendarTemplatesFolder,
				inboxFolder: this.inboxFolder,
				systemFolder: this.systemFolder,
				filesFolder: this.filesFolder,
				eventNotesFolder: this.eventNotesFolder,
			},
			modules: {
				...settings.modules,
				calendar: { ...(settings.modules.calendar ?? {}), eventNotesFolder: this.eventNotesFolder },
			},
		};
		const issues = this.core.settings.validate(next);
		const blocking = issues.filter((issue) => issue.level === "error");
		if (blocking.length > 0) { new Notice(blocking.map((issue) => issue.message).join("\n"), 8000); return; }
		try {
			for (const path of [this.inboxFolder, this.calendarFolder, this.eventNotesFolder, this.systemFolder, this.filesFolder, this.calendarTemplatesFolder]) {
				await ensureVaultFolder(this.core.app, path);
			}
			const saveIssues = await this.core.settings.save(next);
			const saveErrors = saveIssues.filter((issue) => issue.level === "error");
			if (saveErrors.length > 0) { new Notice(saveErrors.map((issue) => issue.message).join("\n"), 8000); return; }
			this.close();
		} catch (err) {
			console.error("[All iₙ oNe] Onboarding: falha ao preparar configuração inicial:", err);
			new Notice("Não foi possível concluir a configuração inicial. Verifique os caminhos e tente novamente.", 8000);
		}
	}
}