import { App, Modal, Setting } from "obsidian";
import type { HubCore } from "../core/HubCore";

/**
 * ONBOARDING
 * ----------
 * Roda uma única vez (settings.onboardingCompleted === false). Em vez de o
 * usuário abrir o Lobby e encontrar tudo vazio, este assistente pergunta o
 * essencial primeiro — hoje: pasta do calendário e pasta de templates do
 * calendário. Fica fácil estender com mais perguntas conforme novos módulos
 * forem adicionados, já que cada pergunta só escreve em `settings.paths` ou
 * `settings.modules[x]`, sem lógica acoplada ao restante do onboarding.
 */
export class OnboardingModal extends Modal {
	private calendarFolder: string;
	private calendarTemplatesFolder: string;

	constructor(app: App, private core: HubCore) {
		super(app);
		const settings = core.settings.get();
		this.calendarFolder = settings.paths.calendarFolder;
		this.calendarTemplatesFolder = settings.paths.calendarTemplatesFolder;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: "Bem-vindo ao ioNe Hub" });
		contentEl.createEl("p", {
			text:
				"Antes de começar, vamos configurar alguns caminhos básicos. Você pode mudar tudo " +
				"isso depois no Lobby, a qualquer momento.",
		});

		new Setting(contentEl)
			.setName("Pasta do calendário")
			.setDesc("Onde as notas de data criadas pelo módulo Calendário serão salvas.")
			.addText((text) =>
				text.setValue(this.calendarFolder).onChange((value) => (this.calendarFolder = value))
			);

		new Setting(contentEl)
			.setName("Pasta de templates do calendário")
			.setDesc("Arquivos .md colocados aqui aparecem como opções ao criar uma nota de data.")
			.addText((text) =>
				text
					.setValue(this.calendarTemplatesFolder)
					.onChange((value) => (this.calendarTemplatesFolder = value))
			);

		const footer = contentEl.createDiv({ cls: "ione-hub-onboarding__footer" });
		const finishBtn = footer.createEl("button", { text: "Concluir configuração inicial", cls: "mod-cta" });
		finishBtn.onclick = () => void this.finish();
	}

	private async finish(): Promise<void> {
		const settings = this.core.settings.get();
		await this.core.settings.save({
			...settings,
			onboardingCompleted: true,
			paths: {
				...settings.paths,
				calendarFolder: this.calendarFolder,
				calendarTemplatesFolder: this.calendarTemplatesFolder,
			},
		});

		await this.core.app.vault
			.createFolder(this.calendarTemplatesFolder)
			.catch(() => void 0);

		this.close();
	}
}
