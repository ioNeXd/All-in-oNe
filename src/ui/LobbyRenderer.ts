import { App, Notice, Setting, TFile, Modal } from "obsidian";
import type { HubCore } from "../core/HubCore";
import type { HubModule } from "../core/ModuleContract";
import { isPendingStatus } from "../modules/templates/NoteStatus";

/** Rótulos amigáveis para as chaves de `settings.paths`. */
const PATH_LABELS: Record<string, string> = {
	calendarFolder: "Pasta das notas do calendário",
	calendarTemplatesFolder: "Pasta dos templates do calendário",
};

const BRAND = "All i\u2099 oNe";

type Section = "geral" | "diagnostico" | "eventos" | "ajuda" | string;

/**
 * RENDERIZADOR DO LOBBY
 * ----------------------
 * Toda a UI do Lobby vive aqui, desacoplada de COMO ela é exibida. Isso
 * existe porque, até a v0.2.0, o modo "janela" simplesmente não funcionava:
 * o `LobbyModal` tentava instanciar um `ItemView` com um `WorkspaceLeaf`
 * falso e sobrescrever o `contentEl` dele — um hack que quebrava em
 * silêncio, deixando o botão da barra lateral sem resposta nenhuma.
 *
 * Agora `LobbyView` (aba) e `LobbyModal` (janela) são apenas cascas finas
 * que apontam esta classe para o container delas. Nenhuma lógica duplicada,
 * e os dois modos se comportam exatamente igual.
 */
export class LobbyRenderer {
	private activeSection: Section = "geral";
	private searchQuery = "";

	constructor(private app: App, private core: HubCore, private containerEl: HTMLElement) {}

	render(): void {
		const container = this.containerEl;
		container.empty();
		container.addClass("ione-hub-lobby");

		const layout = container.createDiv({ cls: "ione-hub-lobby__layout" });
		this.renderSidebar(layout.createDiv({ cls: "ione-hub-lobby__sidebar" }));
		this.renderContent(layout.createDiv({ cls: "ione-hub-lobby__content" }));
	}

	private renderSidebar(sidebar: HTMLElement): void {
		const searchInput = sidebar.createEl("input", {
			type: "text",
			placeholder: "Buscar módulo...",
			cls: "ione-hub-lobby__search",
		});
		searchInput.value = this.searchQuery;
		searchInput.oninput = () => {
			this.searchQuery = searchInput.value;
			this.render();
		};

		const quickActions = sidebar.createDiv({ cls: "ione-hub-lobby__quick-actions" });
		quickActions.createEl("div", { text: "Ações rápidas", cls: "ione-hub-lobby__section-title" });
		this.quickButton(quickActions, "Nota de hoje", () => void this.quickOpenToday());
		this.quickButton(quickActions, "Ver pendentes", () => void this.quickShowPending());

		const nav = sidebar.createDiv({ cls: "ione-hub-lobby__nav" });
		nav.createEl("div", { text: "Módulos", cls: "ione-hub-lobby__section-title" });

		for (const module of this.core.getModules()) {
			const matches =
				!this.searchQuery ||
				module.manifest.displayName.toLowerCase().includes(this.searchQuery.toLowerCase());
			if (!matches) continue;
			this.renderModuleNavItem(nav, module);
		}

		const fixedNav = sidebar.createDiv({ cls: "ione-hub-lobby__nav" });
		const fixedSections: [Section, string][] = [
			["geral", "Configurações gerais"],
			["diagnostico", "Diagnóstico"],
			["eventos", "Central de Eventos"],
			["ajuda", "Ajuda / Como funciona"],
		];
		for (const [id, label] of fixedSections) {
			this.navItem(fixedNav, label, id);
		}

		const resetBtn = sidebar.createEl("button", {
			text: "Restaurar tudo",
			cls: "ione-hub-lobby__reset-btn",
		});
		resetBtn.onclick = () => new ResetModal(this.app, this.core, () => this.render()).open();
	}

	private renderModuleNavItem(nav: HTMLElement, module: HubModule): void {
		const item = nav.createDiv({ cls: "ione-hub-lobby__nav-item" });
		if (this.activeSection === module.manifest.id) item.addClass("is-active");

		item.createSpan({ text: module.manifest.displayName });

		const toggle = item.createEl("input", { type: "checkbox" });
		toggle.checked = this.core.isModuleEnabled(module.manifest.id);
		toggle.setAttr("aria-label", `Ligar/desligar ${module.manifest.displayName}`);
		// O checkbox tem seu próprio foco; tirá-lo da ordem de tabulação evita
		// o "quadrado duplo" ao navegar por teclado — a linha inteira já é focável.
		toggle.tabIndex = -1;
		toggle.onclick = (evt) => {
			evt.stopPropagation();
			void this.toggleModule(module.manifest.id, toggle.checked);
		};

		const activate = () => {
			this.activeSection = module.manifest.id;
			this.render();
		};
		item.tabIndex = 0;
		item.onclick = activate;
		item.onkeydown = (evt) => {
			if (evt.key === "Enter" || evt.key === " ") {
				evt.preventDefault();
				activate();
			}
		};
	}

	private navItem(parent: HTMLElement, label: string, id: Section): void {
		const item = parent.createDiv({ cls: "ione-hub-lobby__nav-item" });
		if (this.activeSection === id) item.addClass("is-active");
		item.setText(label);
		item.tabIndex = 0;
		const activate = () => {
			this.activeSection = id;
			this.render();
		};
		item.onclick = activate;
		item.onkeydown = (evt) => {
			if (evt.key === "Enter" || evt.key === " ") {
				evt.preventDefault();
				activate();
			}
		};
	}

	private quickButton(container: HTMLElement, label: string, onClick: () => void): void {
		const btn = container.createEl("button", { text: label, cls: "ione-hub-lobby__quick-btn" });
		btn.onclick = onClick;
	}

	private async toggleModule(id: string, enable: boolean): Promise<void> {
		if (enable) {
			await this.core.enableModule(id);
			if (!this.core.isModuleEnabled(id)) {
				new Notice(`Não foi possível ligar "${id}": ${this.core.getLastEnableError(id) ?? "erro"}`, 8000);
				this.render();
				return;
			}
		} else {
			await this.core.disableModule(id);
		}
		const settings = this.core.settings.get();
		const enabledModules = enable
			? [...new Set([...settings.enabledModules, id])]
			: settings.enabledModules.filter((m) => m !== id);
		await this.core.settings.save({ ...settings, enabledModules });
		this.render();
	}

	private renderContent(content: HTMLElement): void {
		switch (this.activeSection) {
			case "geral":
				return this.renderGeneralSettings(content);
			case "diagnostico":
				return this.renderDiagnostics(content);
			case "eventos":
				return this.renderEventCenter(content);
			case "ajuda":
				return this.renderHelp(content);
		}

		const module = this.core.getModules().find((m) => m.manifest.id === this.activeSection);
		if (!module) {
			content.createEl("p", { text: "Selecione uma seção na barra lateral." });
			return;
		}

		content.createEl("h2", { text: module.manifest.displayName });
		content.createEl("p", { text: module.manifest.description, cls: "ione-hub-lobby__description" });

		if (!this.core.isModuleEnabled(module.manifest.id)) {
			const box = content.createDiv({ cls: "ione-hub-lobby__disabled-box" });
			box.createEl("div", { cls: "ione-hub-lobby__disabled-title", text: "⏸️ Módulo desligado" });
			box.createEl("p", {
				text:
					`"${module.manifest.displayName}" não está em execução, então nada deste módulo ` +
					"acontece no momento. Você ainda pode ajustar tudo abaixo — as configurações são " +
					"salvas e passam a valer assim que você ligar o módulo no interruptor da barra lateral.",
			});
		}

		const panel = content.createDiv({ cls: "ione-hub-lobby__module-panel" });
		if (module.renderSettingsPanel) {
			module.renderSettingsPanel(panel);
		} else {
			panel.createEl("p", {
				text: "Este módulo não tem configurações.",
				cls: "ione-hub-lobby__description",
			});
		}
	}

	private renderGeneralSettings(content: HTMLElement): void {
		content.createEl("h2", { text: "Configurações gerais" });
		const settings = this.core.settings.get();

		new Setting(content)
			.setName("Como abrir o Lobby")
			.setDesc("Vale para o ícone da barra lateral e para o comando do Command Palette.")
			.addDropdown((dd) =>
				dd
					.addOption("tab", "Sempre como aba")
					.addOption("modal", "Sempre como janela")
					.addOption("ask-each-time", "Perguntar toda vez")
					.setValue(settings.lobby.openMode)
					.onChange(async (value) => {
						const current = this.core.settings.get();
						await this.core.settings.save({
							...current,
							lobby: { ...current.lobby, openMode: value as typeof current.lobby.openMode },
						});
					})
			);

		content.createEl("h3", { text: "Caminhos" });
		content.createEl("p", {
			cls: "ione-hub-lobby__description",
			text: "Pastas usadas pelos módulos. Dois módulos não podem apontar para a mesma pasta.",
		});

		for (const [key, value] of Object.entries(settings.paths)) {
			let draft = value;
			new Setting(content)
				.setName(PATH_LABELS[key] ?? key)
				.addText((text) => text.setValue(value).onChange((v) => (draft = v)))
				.addButton((btn) =>
					btn.setButtonText("Aplicar").onClick(async () => {
						const current = this.core.settings.get();
						const issues = await this.core.settings.save({
							...current,
							paths: { ...current.paths, [key]: draft.trim() },
						});
						const blocking = issues.filter((i) => i.level === "error");
						if (blocking.length > 0) {
							new Notice(blocking.map((i) => i.message).join("\n"), 8000);
							return;
						}
						new Notice("Caminho salvo.");
						this.render();
					})
				);
		}
	}

	private renderDiagnostics(content: HTMLElement): void {
		content.createEl("h2", { text: "Diagnóstico" });
		const list = content.createDiv({ cls: "ione-hub-lobby__diagnostics" });
		for (const status of this.core.getHealthSnapshot()) {
			const module = this.core.getModules().find((m) => m.manifest.id === status.moduleId);
			const enabled = this.core.isModuleEnabled(status.moduleId);
			const row = list.createDiv({ cls: "ione-hub-lobby__diagnostic-row" });
			// Um módulo desligado não é "saudável" — é desligado. Antes ficava
			// verde, o que dava a impressão errada de que estava funcionando.
			row.createSpan({ text: !enabled ? "🔴 " : status.ok ? "🟢 " : "🟠 " });
			row.createSpan({ text: `${module?.manifest.displayName ?? status.moduleId}: ` });
			row.createSpan({ text: enabled ? status.summary : "Desligado" });
		}
	}

	private renderEventCenter(content: HTMLElement): void {
		content.createEl("h2", { text: "Central de Eventos" });
		content.createEl("p", {
			cls: "ione-hub-lobby__description",
			text: "O que trafegou pelo barramento nesta sessão — útil para entender por que algo disparou (ou não).",
		});

		const actions = content.createDiv({ cls: "ione-hub-lobby__quick-actions" });
		const refresh = actions.createEl("button", { text: "Atualizar" });
		refresh.onclick = () => this.render();

		const testBtn = actions.createEl("button", { text: "Disparar evento de teste" });
		testBtn.onclick = async () => {
			await this.core.bus.emit("core:test-event", { origem: "Central de Eventos" }, "core");
			new Notice("Evento de teste emitido no barramento.");
			this.render();
		};

		const clearBtn = actions.createEl("button", { text: "Limpar lista" });
		clearBtn.onclick = () => {
			this.core.bus.clearHistory();
			new Notice("Lista de eventos limpa.");
			this.render();
		};

		new Setting(content)
			.setName("Máximo de eventos guardados nesta sessão")
			.setDesc("Eventos mais antigos são descartados ao passar deste limite.")
			.addText((text) => {
				text.setValue(String(this.core.bus.getHistoryLimit()));
				text.inputEl.onblur = () => {
					const n = Number(text.getValue());
					if (!Number.isInteger(n) || n < 10) {
						new Notice("Informe um número inteiro maior ou igual a 10.");
						text.setValue(String(this.core.bus.getHistoryLimit()));
						return;
					}
					this.core.bus.setHistoryLimit(n);
					new Notice(`Limite ajustado para ${n} eventos.`);
				};
			});

		const events = this.core.bus.getHistory().slice().reverse().slice(0, 100);
		if (events.length === 0) {
			content.createEl("p", {
				text: "Nenhum evento nesta sessão ainda.",
				cls: "ione-hub-lobby__description",
			});
		}
		const list = content.createDiv({ cls: "ione-hub-lobby__history" });
		for (const event of events) {
			const row = list.createDiv({ cls: "ione-hub-lobby__history-row" });
			row.createSpan({
				text: `[${new Date(event.timestamp).toLocaleTimeString("pt-BR")}] `,
				cls: "ione-hub-lobby__history-time",
			});
			row.createSpan({ text: `${event.name} ` });
			row.createSpan({ text: `(de: ${event.source})`, cls: "ione-hub-lobby__history-time" });
		}

		content.createEl("h3", { text: "Mapa de conexões" });
		for (const module of this.core.getModules()) {
			const box = content.createDiv({ cls: "ione-hub-lobby__diagnostic-row" });
			box.createEl("strong", { text: module.manifest.displayName });
			box.createEl("div", { text: `emite: ${module.manifest.emits.join(", ") || "(nada)"}` });
			box.createEl("div", { text: `escuta: ${module.manifest.listensTo.join(", ") || "(nada)"}` });
		}
	}

	private renderHelp(content: HTMLElement): void {
		content.createEl("h2", { text: "Ajuda / Como funciona" });
		content.createEl("p", {
			text:
				"O All iₙ oNe é organizado em módulos independentes conectados por um barramento de eventos. " +
				"Ligar ou desligar um módulo não afeta os outros, e todos os caminhos de pasta são configuráveis.",
		});
		for (const module of this.core.getModules()) {
			content.createEl("h3", { text: module.manifest.displayName });
			content.createEl("p", { text: module.manifest.description });
		}
	}

	private async quickOpenToday(): Promise<void> {
		const calendar = this.core.getModules().find((m) => m.manifest.id === "calendar") as
			| (HubModule & { openOrCreateForDate?: (d: Date) => Promise<TFile> })
			| undefined;

		if (!this.core.isModuleEnabled("calendar") || !calendar?.openOrCreateForDate) {
			new Notice("O módulo Calendário precisa estar ligado para isso.");
			return;
		}
		const file = await calendar.openOrCreateForDate(new Date());
		await this.app.workspace.getLeaf(false).openFile(file);
	}

	private async quickShowPending(): Promise<void> {
		const pending = this.app.vault.getMarkdownFiles().filter((file) => {
			const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
			// Mesma regra do módulo de Templates (lista ["Pendente","Completo"]) —
			// comparar com a string "pendente" nunca casava e a ação rápida
			// dizia "Nenhuma nota pendente" mesmo com pendências.
			return isPendingStatus(fm?.status);
		});
		if (pending.length === 0) {
			new Notice("Nenhuma nota pendente no vault.");
			return;
		}
		new PendingNotesModal(this.app, pending).open();
	}
}

/** Modal com as 3 opções de "Restaurar tudo". */
class ResetModal extends Modal {
	constructor(app: App, private core: HubCore, private onDone: () => void) {
		super(app);
	}

	onOpen(): void {
		this.contentEl.createEl("h2", { text: "Restaurar tudo" });
		this.contentEl.createEl("p", {
			text: "Escolha o nível de reset. Suas notas nunca são apagadas por esta ação.",
		});
		this.option("Configuração padrão", "Reseta só as configurações do plugin.", "config");
		this.option(
			"Limpar dados gerados",
			"Reseta configurações e limpa histórico e cache. Notas continuam intactas.",
			"data"
		);
		this.option("Limpar tudo", "Reset completo do plugin.", "all");
	}

	private option(title: string, description: string, level: "config" | "data" | "all"): void {
		const row = this.contentEl.createDiv({ cls: "ione-hub-reset-option" });
		row.createEl("strong", { text: title });
		row.createEl("p", { text: description });
		const btn = row.createEl("button", { text: "Escolher" });
		btn.onclick = async () => {
			await this.core.resetAll(level);
			this.onDone();
			this.close();
		};
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Lista de notas com `status: pendente`, aberta pela ação rápida. */
class PendingNotesModal extends Modal {
	constructor(app: App, private files: TFile[]) {
		super(app);
	}

	onOpen(): void {
		this.contentEl.createEl("h2", { text: `${this.files.length} nota(s) pendente(s)` });
		for (const file of this.files) {
			const row = this.contentEl.createDiv({ cls: "ione-hub-lobby__history-row" });
			row.setText(file.path);
			row.tabIndex = 0;
			const open = async () => {
				await this.app.workspace.getLeaf(false).openFile(file);
				this.close();
			};
			row.onclick = () => void open();
			row.onkeydown = (evt) => {
				if (evt.key === "Enter") void open();
			};
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
