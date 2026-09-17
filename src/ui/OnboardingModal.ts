import { App, Modal, Notice, Setting } from "obsidian";
import type { HubCore } from "../core/HubCore";
import { ensureVaultFolder } from "../core/VaultPaths";

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
		let issues;
		try {
			issues = await this.core.settings.save({
				...settings,
				onboardingCompleted: true,
				paths: {
					...settings.paths,
					calendarFolder: this.calendarFolder,
					calendarTemplatesFolder: this.calendarTemplatesFolder,
				},
			});
		} catch (err) {
			// O botão chama `void this.finish()` — sem este catch, uma falha de
			// disco (saveData) viraria rejection não tratada, sem feedback nenhum.
			console.error("[All iₙ oNe] Onboarding: falha ao salvar configuração inicial:", err);
			new Notice("Não foi possível salvar a configuração inicial. Tente novamente.", 8000);
			return; // modal continua aberto
		}

		// A validação do núcleo bloqueia gravação com erro (ex.: os dois campos
		// apontando para a MESMA pasta — conflito de caminho entre módulos).
		// Antes as issues eram ignoradas: o modal fechava sem salvar nem avisar,
		// e o usuário só descobriria o problema na próxima abertura do plugin.
		const blocking = issues.filter((i) => i.level === "error");
		if (blocking.length > 0) {
			new Notice(blocking.map((i) => i.message).join("\n"), 8000);
			return; // mantém o modal aberto para o usuário corrigir os caminhos
		}

		// `vault.createFolder` NÃO cria pastas-pai — num caminho aninhado
		// (ex.: "Calendario/templates") ele falhava em silêncio aqui, e a
		// primeira nota de data da vida do usuário morria com ENOENT.
		// Helper centralizado do núcleo (mesmo usado por Templates,
		// Calendário e Ciclo de Vida).
		await ensureVaultFolder(this.core.app, this.calendarTemplatesFolder);

		this.close();
	}
}
