import { TFile, TFolder, normalizePath, Setting, Notice, Modal, App } from "obsidian";
import type { HubModule, ModuleContext, ModuleManifest } from "../../core/ModuleContract";
import { ensureVaultFolder, uniqueVaultPath } from "../../core/VaultPaths";
import { type CalendarEvent, monthFolderName, describeEvent, shouldFire, MONTH_NAMES } from "./EventTypes";
import { ReminderModal, playReminderChime } from "./ReminderModal";
import { attachFilterSuggest } from "../../ui/FilterSuggest";
import { isPendingStatus } from "../templates/NoteStatus";
export type { CalendarEvent } from "./EventTypes";

export interface CalendarModuleSettings {
	events: CalendarEvent[];
	view: "month" | "week" | "agenda";
	/**
	 * Pasta única para notas de evento — tanto para uma nota EXISTENTE que o
	 * usuário vincula (é movida pra cá) quanto para uma nota NOVA criada na
	 * hora. Antes havia duas pastas separadas ("eventos" e "notas"); ficou
	 * uma só, por pedido, para não duplicar o conceito.
	 */
	eventNotesFolder: string;
	/**
	 * Se true, o lembrete força a janela do Obsidian pra frente mesmo com o
	 * app minimizado. Desligado por padrão — ver ReminderModal.
	 */
	autoFocusOnReminder: boolean;
}

export const CALENDAR_DEFAULTS: CalendarModuleSettings = {
	events: [],
	view: "month",
	eventNotesFolder: "Calendario/notas",
	autoFocusOnReminder: false,
};

const WEEKDAY_LABELS = ["D", "S", "T", "Q", "Q", "S", "S"];

/**
 * MÓDULO DE CALENDÁRIO
 * ---------------------
 * Os caminhos usados aqui (pasta de notas do calendário, pasta de templates)
 * vêm de `settings.paths` no núcleo — não são fixos, conforme decidido na
 * fase de design ("todos os caminhos configuráveis"). Este módulo só lê
 * `context.getFullSettings().paths`.
 *
 * Três visões: mês (grade navegável), semana e agenda (lista dos próximos
 * dias). A grade indica visualmente quais dias já têm nota, quais têm nota
 * pendente (cruzamento com o módulo de Templates via frontmatter `status`)
 * e quais têm eventos marcados.
 */
export class CalendarModule implements HubModule {
	readonly manifest: ModuleManifest = {
		id: "calendar",
		displayName: "Calendário",
		description: "Calendário integrado com o sistema de templates e eventos recorrentes notificáveis.",
		icon: "calendar",
		version: "0.2.0",
		contractVersion: "2.0.0",
		desktopOnly: false,
		emits: ["calendar:event-fired", "calendar:note-opened", "calendar:note-created"],
		listensTo: [],
		settingsSchema: [
			{
				key: "view",
				label: "Visualização padrão",
				type: "select",
				options: [
					{ value: "month", label: "Mês" },
					{ value: "week", label: "Semana" },
					{ value: "agenda", label: "Agenda" },
				],
				default: CALENDAR_DEFAULTS.view,
			},
		],
	};

	private context?: ModuleContext;
	private dailyCheckInterval?: number;
	/** Mês exibido na grade (independente do mês atual) — controlado pela navegação. */
	private displayedMonth = new Date();
	/**
	 * Raiz do painel no Lobby. Guardada porque a navegação de mês precisa
	 * redesenhar o painel INTEIRO a partir do topo — antes ela redesenhava
	 * dentro do container da própria visão, aninhando um painel dentro do
	 * outro e duplicando os controles a cada clique em ‹ › ou "Hoje".
	 */
	private panelRoot?: HTMLElement;

	onRegister(context: ModuleContext): void {
		this.context = context;
	}

	onEnable(): void {
		this.checkTodaysEvents();
		// 10s em vez dos 60s originais: o atraso relatado (~40-50s depois da
		// hora marcada) era simplesmente a granularidade do setInterval — o
		// pior caso era esperar quase um minuto inteiro pela próxima checagem.
		// Com 10s o pior caso cai para 10s, sem pesar no desempenho.
		this.dailyCheckInterval = window.setInterval(() => this.checkTodaysEvents(), 10_000);

		this.context!.registerCommand("calendar-open-today", "Calendário: Abrir nota de hoje", () => {
			void this.openOrCreateForDate(new Date());
		});
	}

	onDisable(): void {
		if (this.dailyCheckInterval) window.clearInterval(this.dailyCheckInterval);
	}

	/** Aba ativa: grade do calendário ou lista de eventos. */
	private activeTab: "calendar" | "events" | "settings" = "calendar";

	renderSettingsPanel(container: HTMLElement): void {
		this.panelRoot = container;

		const tabs = container.createDiv({ cls: "ione-hub-tabs" });
		const eventCount = this.readSettings().events.length;
		const tabDefs: [typeof this.activeTab, string][] = [
			["calendar", "📅 Calendário"],
			["events", `🔔 Eventos (${eventCount})`],
			["settings", "⚙️ Configurações"],
		];
		for (const [id, label] of tabDefs) {
			const tab = tabs.createDiv({ cls: "ione-hub-tabs__tab", text: label });
			if (this.activeTab === id) tab.addClass("is-active");
			tab.tabIndex = 0;
			const activate = () => {
				this.activeTab = id;
				this.refreshPanel();
			};
			tab.onclick = activate;
			tab.onkeydown = (evt) => {
				if (evt.key === "Enter" || evt.key === " ") {
					evt.preventDefault();
					activate();
				}
			};
		}

		const body = container.createDiv({ cls: "ione-hub-tabs__body" });
		if (this.activeTab === "events") this.renderEventsTab(body);
		else if (this.activeTab === "settings") this.renderSettingsTab(body);
		else this.renderCalendarTab(body);
	}

	/**
	 * Configurações específicas do Calendário, reunidas aqui em vez de
	 * espalhadas na tela genérica "Configurações gerais" do Lobby — os
	 * caminhos continuam salvos em `settings.paths` (mesmo lugar de sempre),
	 * só a UI de edição é que vive dentro do módulo.
	 */
	private renderSettingsTab(container: HTMLElement): void {
		const settings = this.readSettings();
		const paths = this.context!.getFullSettings().paths;

		container.createEl("h3", { text: "Pastas" });

		new Setting(container)
			.setName("Pasta das notas do calendário")
			.setDesc("Onde as notas de data ficam — ex.: Calendario/2026/09 - Setembro/.")
			.addText((text) => {
				text.setValue(paths.calendarFolder);
				text.inputEl.onblur = () => this.updateGlobalPath("calendarFolder", text.getValue());
			});

		new Setting(container)
			.setName("Pasta dos templates do calendário")
			.setDesc("Arquivos .md aqui viram opção ao criar uma nota de data.")
			.addText((text) => {
				text.setValue(paths.calendarTemplatesFolder);
				text.inputEl.onblur = () => this.updateGlobalPath("calendarTemplatesFolder", text.getValue());
			});

		new Setting(container)
			.setName("Pasta das notas de evento")
			.setDesc(
				"Usada tanto para notas EXISTENTES vinculadas (são movidas pra cá) quanto para " +
					"notas NOVAS criadas a partir de um evento. Criada automaticamente se não existir."
			)
			.addText((text) => {
				text.setValue(settings.eventNotesFolder);
				text.inputEl.onblur = async () => {
					await this.context?.updateSettings({ eventNotesFolder: text.getValue().trim() });
				};
			});

		container.createEl("h3", { text: "Lembretes" });
		new Setting(container)
			.setName("Trazer a janela para frente automaticamente")
			.setDesc(
				"Desligado por padrão: um lembrete só pisca o ícone na barra de tarefas e toca o som " +
					"uma vez — não força o Obsidian pra frente (isso atrapalharia quem está em outro " +
					"programa, como um jogo). Ligue se preferir que a janela sempre apareça sozinha."
			)
			.addToggle((toggle) =>
				toggle.setValue(settings.autoFocusOnReminder).onChange(async (value) => {
					await this.context?.updateSettings({ autoFocusOnReminder: value });
				})
			);

		new Setting(container)
			.setName("Testar lembrete agora")
			.addButton((btn) => btn.setButtonText("Testar").onClick(() => this.testGenericReminder()));
	}

	private renderCalendarTab(container: HTMLElement): void {
		const settings = this.readSettings();

		new Setting(container)
			.setName("Visualização")
			.addDropdown((dd) =>
				dd
					.addOption("month", "Mês")
					.addOption("week", "Semana")
					.addOption("agenda", "Agenda")
					.setValue(settings.view)
					.onChange(async (value) => {
						await this.context?.updateSettings({ view: value });
						this.refreshPanel();
					})
			);

		container.createEl("p", {
			cls: "ione-hub-lobby__description",
			text: "Clique em qualquer dia para criar uma nota (com ou sem template) ou marcar um evento.",
		});

		void this.renderCurrentView(container.createDiv(), settings.view);

		// Estava escrita mas nunca chamada em lugar nenhum — corrigido agora.
		void this.renderPendingTimeline(container.createDiv());
	}

	/** Aba dedicada com todos os eventos marcados. */
	private renderEventsTab(container: HTMLElement): void {
		const settings = this.readSettings();



		new Setting(container)
			.setName("Novo evento")
			.addButton((btn) =>
				btn
					.setButtonText("Criar evento")
					.setCta()
					.onClick(() => this.openEventEditor(new Date()))
			)
			.addButton((btn) =>
				btn.setButtonText("Testar lembrete genérico").onClick(() => this.testGenericReminder())
			);

		container.createEl("h3", { text: "Eventos marcados" });
		if (settings.events.length === 0) {
			container.createEl("p", {
				cls: "ione-hub-lobby__description",
				text: "Nenhum evento ainda. Crie um acima, ou clique numa data na aba Calendário.",
			});
			return;
		}

		const sorted = [...settings.events].sort((a, b) =>
			a.month === b.month ? a.day - b.day : a.month - b.month
		);
		for (const event of sorted) {
			new Setting(container)
				.setName(`${event.reminder ? "⏰ " : ""}${event.title}`)
				.setDesc(describeEvent(event) + (event.description ? ` — ${event.description}` : ""))
				.addButton((btn) =>
					btn.setButtonText("Editar").onClick(() => this.editEvent(event))
				)
				.addButton((btn) =>
					btn.setButtonText("Testar").onClick(() => {
						new ReminderModal(
							this.context!.app,
							event,
							(refId) => this.openNoteByRef(refId),
							this.readSettings().autoFocusOnReminder
						).open();
						void playReminderChime();
					})
				)
				.addButton((btn) =>
					btn.setButtonText("Remover").onClick(async () => {
						await this.removeEvent(event.id);
						this.refreshPanel();
					})
				);
		}
	}

	/** Abre o formulário para CRIAR um evento novo, já com a data preenchida. */
	openEventEditor(date: Date): void {
		void this.ensureEventNotesFolder();
		const notes = this.context!.app.vault.getMarkdownFiles().map((f) => f.path);
		const defaultFolder = this.readSettings().eventNotesFolder;
		new EventEditorModal(
			this.context!.app,
			date,
			notes,
			defaultFolder,
			async (event, noteAction) => {
				await this.resolveNoteAction(noteAction, event);
				await this.addEvent(event);
				new Notice(`Evento "${event.title}" marcado.`);
				this.refreshPanel();
			}
		).open();
	}

	/** Abre o formulário para EDITAR um evento já existente. */
	editEvent(event: CalendarEvent): void {
		void this.ensureEventNotesFolder();
		const notes = this.context!.app.vault.getMarkdownFiles().map((f) => f.path);
		const defaultFolder = this.readSettings().eventNotesFolder;
		const date = new Date(event.year ?? new Date().getFullYear(), event.month - 1, event.day);
		new EventEditorModal(
			this.context!.app,
			date,
			notes,
			defaultFolder,
			async (updated, noteAction) => {
				await this.resolveNoteAction(noteAction, updated);
				const settings = this.readSettings();
				await this.context?.updateSettings({
					events: settings.events.map((e) => (e.id === event.id ? { ...updated, id: event.id } : e)),
				});
				new Notice(`Evento "${updated.title}" atualizado.`);
				this.refreshPanel();
			},
			event
		).open();
	}

	/** Executa a ação de nota escolhida no formulário (nenhuma / existente / criar). */
	private async resolveNoteAction(
		action:
			| { kind: "none" }
			| { kind: "existing"; path: string }
			| { kind: "create"; name: string; folder: string },
		event: Omit<CalendarEvent, "id">
	): Promise<void> {
		if (action.kind === "none" || !event.noteRefId) return;
		if (action.kind === "existing") {
			const file = this.context!.app.vault.getAbstractFileByPath(action.path);
			if (file instanceof TFile) await this.linkExistingNote(file, event.noteRefId);
		} else if (action.kind === "create") {
			await this.createLinkedNote(action.name.trim(), event.noteRefId, action.folder);
		}
	}

	/** Dispara um lembrete de exemplo, sem precisar de um evento salvo. */
	testGenericReminder(): void {
		const sample: CalendarEvent = {
			id: "test",
			title: "Evento de teste",
			description: "Esta é uma prévia de como um lembrete vai aparecer.",
			recurrence: "once",
			day: new Date().getDate(),
			month: new Date().getMonth() + 1,
			year: new Date().getFullYear(),
			reminder: true,
		};
		new ReminderModal(
			this.context!.app,
			sample,
			() => Promise.resolve(),
			this.readSettings().autoFocusOnReminder
		).open();
		void playReminderChime();
	}

	/** Único ponto de redesenho do painel — sempre a partir da raiz guardada. */
	private refreshPanel(container?: HTMLElement): void {
		const root = container ?? this.panelRoot;
		if (!root) return;
		root.empty();
		this.renderSettingsPanel(root);
	}



	private async renderCurrentView(container: HTMLElement, view: string): Promise<void> {
		if (view === "week") return this.renderWeekView(container);
		if (view === "agenda") return this.renderAgendaView(container);
		return this.renderMonthGrid(container);
	}

	/** Grade do mês com navegação entre meses e indicadores visuais por dia. */
	private async renderMonthGrid(container: HTMLElement): Promise<void> {
		const year = this.displayedMonth.getFullYear();
		const month = this.displayedMonth.getMonth();

		const header = container.createDiv({ cls: "ione-hub-calendar__header" });
		const prev = header.createEl("button", { text: "‹" });
		header.createSpan({
			text: this.displayedMonth.toLocaleDateString("pt-BR", { month: "long", year: "numeric" }),
			cls: "ione-hub-calendar__title",
		});
		const next = header.createEl("button", { text: "›" });
		const todayBtn = header.createEl("button", { text: "Hoje" });

		prev.onclick = () => {
			this.displayedMonth = new Date(year, month - 1, 1);
			this.rerenderView();
		};
		next.onclick = () => {
			this.displayedMonth = new Date(year, month + 1, 1);
			this.rerenderView();
		};
		todayBtn.onclick = () => {
			this.displayedMonth = new Date();
			this.rerenderView();
		};

		const grid = container.createDiv({ cls: "ione-hub-calendar" });
		for (const label of WEEKDAY_LABELS) {
			grid.createDiv({ cls: "ione-hub-calendar__weekday", text: label });
		}

		// Células vazias até o primeiro dia cair no dia da semana certo.
		const firstWeekday = new Date(year, month, 1).getDay();
		for (let i = 0; i < firstWeekday; i++) {
			grid.createDiv({ cls: "ione-hub-calendar__day ione-hub-calendar__day--empty" });
		}

		const daysInMonth = new Date(year, month + 1, 0).getDate();
		const statuses = await this.getMonthStatuses(year, month, daysInMonth);

		for (let day = 1; day <= daysInMonth; day++) {
			const cell = grid.createDiv({ cls: "ione-hub-calendar__day" });
			cell.createSpan({ text: String(day) });

			const status = statuses[day];
			if (status.hasNote) cell.addClass("ione-hub-calendar__day--has-note");
			if (status.pending) cell.addClass("ione-hub-calendar__day--pending");
			if (status.events.length > 0) {
				cell.addClass("ione-hub-calendar__day--has-event");
				cell.setAttr("title", status.events.map((e) => e.title).join(", "));
			}
			if (this.isToday(year, month, day)) cell.addClass("ione-hub-calendar__day--today");

			cell.onclick = () => void this.handleDayClick(new Date(year, month, day));
		}

		container.createEl("p", {
			cls: "ione-hub-lobby__description",
			text: "Legenda: borda destacada = já tem nota · vermelho = nota pendente · ponto = evento marcado.",
		});
	}

	/** Visão de semana: os 7 dias da semana atual, em linha, com mais detalhe. */
	private async renderWeekView(container: HTMLElement): Promise<void> {
		const base = new Date();
		const start = new Date(base);
		start.setDate(base.getDate() - base.getDay());

		container.createEl("div", {
			cls: "ione-hub-calendar__title",
			text: `Semana de ${start.toLocaleDateString("pt-BR")}`,
		});

		const list = container.createDiv({ cls: "ione-hub-calendar__week" });
		for (let i = 0; i < 7; i++) {
			const date = new Date(start);
			date.setDate(start.getDate() + i);
			const row = list.createDiv({ cls: "ione-hub-calendar__week-row" });
			const hasNote = !!this.findNoteForDate(date);
			row.createSpan({
				text: date.toLocaleDateString("pt-BR", { weekday: "short", day: "2-digit", month: "2-digit" }),
			});
			const events = this.eventsForDate(date);
			if (events.length > 0) row.createSpan({ text: ` — ${events.map((e) => e.title).join(", ")}` });
			if (hasNote) row.addClass("ione-hub-calendar__day--has-note");
			row.onclick = () => void this.handleDayClick(date);
		}
	}

	/** Visão de agenda: próximos 30 dias que tenham nota, evento ou pendência. */
	private async renderAgendaView(container: HTMLElement): Promise<void> {
		container.createEl("div", { cls: "ione-hub-calendar__title", text: "Próximos 30 dias" });
		const list = container.createDiv({ cls: "ione-hub-calendar__agenda" });
		const today = new Date();
		let found = 0;

		for (let i = 0; i < 30; i++) {
			const date = new Date(today);
			date.setDate(today.getDate() + i);
			const events = this.eventsForDate(date);
			const note = this.findNoteForDate(date);
			if (events.length === 0 && !note) continue;

			found++;
			const row = list.createDiv({ cls: "ione-hub-calendar__week-row" });
			row.createSpan({ text: date.toLocaleDateString("pt-BR") + " — " });
			const parts: string[] = [];
			if (events.length > 0) parts.push(events.map((e) => e.title).join(", "));
			if (note) parts.push("nota criada");
			row.createSpan({ text: parts.join(" · ") });
			row.onclick = () => void this.handleDayClick(date);
		}

		if (found === 0) {
			list.createEl("p", {
				cls: "ione-hub-lobby__description",
				text: "Nada marcado nos próximos 30 dias.",
			});
		}
	}

	/** Linha do tempo de notas pendentes — cruzamento com o módulo de Templates. */
	async renderPendingTimeline(container: HTMLElement): Promise<void> {
		const pending = this.findPendingNotes();
		container.createEl("h3", { text: "Notas pendentes" });
		if (pending.length === 0) {
			container.createEl("p", {
				cls: "ione-hub-lobby__description",
				text: "Nenhuma nota pendente no vault.",
			});
			return;
		}
		const list = container.createDiv({ cls: "ione-hub-calendar__agenda" });
		for (const file of pending.slice(0, 50)) {
			const row = list.createDiv({ cls: "ione-hub-calendar__week-row" });
			row.setText(file.path);
			row.onclick = () => void this.context!.app.workspace.getLeaf(false).openFile(file);
		}
	}

	private findPendingNotes(): TFile[] {
		const app = this.context!.app;
		return app.vault.getMarkdownFiles().filter((file) => {
			const fm = app.metadataCache.getFileCache(file)?.frontmatter;
			return isPendingStatus(fm?.status);
		});
	}

	private rerenderView(): void {
		this.refreshPanel();
	}

	private isToday(year: number, month: number, day: number): boolean {
		const now = new Date();
		return now.getFullYear() === year && now.getMonth() === month && now.getDate() === day;
	}

	/** Estado de cada dia do mês: tem nota? está pendente? tem evento? */
	private async getMonthStatuses(
		year: number,
		month: number,
		daysInMonth: number
	): Promise<Record<number, { hasNote: boolean; pending: boolean; events: CalendarEvent[] }>> {
		const result: Record<number, { hasNote: boolean; pending: boolean; events: CalendarEvent[] }> = {};
		const app = this.context!.app;

		for (let day = 1; day <= daysInMonth; day++) {
			const date = new Date(year, month, day);
			const file = this.findNoteForDate(date);
			let pending = false;
			if (file) {
				const fm = app.metadataCache.getFileCache(file)?.frontmatter;
				pending = isPendingStatus(fm?.status);
			}
			result[day] = { hasNote: !!file, pending, events: this.eventsForDate(date) };
		}
		return result;
	}

	private findNoteForDate(date: Date): TFile | null {
		const file = this.context!.app.vault.getAbstractFileByPath(this.pathForDate(date));
		return file instanceof TFile ? file : null;
	}

	private eventsForDate(date: Date): CalendarEvent[] {
		return this.readSettings().events.filter(
			(e) =>
				e.day === date.getDate() &&
				e.month === date.getMonth() + 1 &&
				(e.recurrence === "yearly" || e.year === date.getFullYear())
		);
	}

	/** Clique num dia: abre a nota existente, ou pergunta o que fazer. */
	private async handleDayClick(date: Date): Promise<void> {
		const existing = this.findNoteForDate(date);
		if (existing) {
			await this.context!.app.workspace.getLeaf(false).openFile(existing);
			await this.context?.bus.emit("calendar:note-opened", { path: existing.path }, "calendar");
			return;
		}

		const templates = await this.listAvailableTemplates();
		new DayActionModal(this.context!.app, date, templates, async (action: DayAction) => {
			if (action.kind === "event") {
				this.openEventEditor(date);
				return;
			}
			const file = await this.openOrCreateForDate(date, action.template ?? undefined);
			await this.context!.app.workspace.getLeaf(false).openFile(file);
			this.refreshPanel();
		}).open();
	}

	private async updateGlobalPath(key: string, value: string): Promise<void> {
		const trimmed = value.trim();
		if (!trimmed) return;
		const issues = await this.context!.updatePaths({ [key]: trimmed });
		const blocking = issues.filter((i) => i.level === "error");
		if (blocking.length > 0) {
			new Notice(blocking.map((i) => i.message).join("\n"), 8000);
			return;
		}
		new Notice("Caminho salvo.");
		this.refreshPanel();
	}

	private readSettings(): CalendarModuleSettings {
		return { ...CALENDAR_DEFAULTS, ...this.context?.getSettings<CalendarModuleSettings>() };
	}

	private lastCheckedMinute = "";

	/**
	 * Roda a cada minuto. Verifica a virada do dia E a chegada do horário de
	 * cada evento — por isso a granularidade é de minuto, não de dia.
	 */
	private checkTodaysEvents(): void {
		const now = new Date();
		const minuteKey = `${now.toDateString()} ${now.getHours()}:${now.getMinutes()}`;
		if (minuteKey === this.lastCheckedMinute) return;
		this.lastCheckedMinute = minuteKey;

		for (const event of this.readSettings().events) {
			if (shouldFire(event, now)) void this.fireEvent(event, now);
		}
	}

	private async fireEvent(event: CalendarEvent, now: Date): Promise<void> {
		await this.context?.bus.emit("calendar:event-fired", { event }, "calendar");

		if (event.reminder) {
			// Som toca uma vez aqui, dentro do ReminderModal.onOpen (não duas).
			// A janela por padrão NÃO se força para frente — só a aba pisca na
			// barra de tarefas (autoFocusOnReminder controla o oposto).
			new ReminderModal(
				this.context!.app,
				event,
				(refId) => this.openNoteByRef(refId),
				this.readSettings().autoFocusOnReminder
			).open();
			void playReminderChime();
		} else if (event.noteRefId) {
			await this.openNoteByRef(event.noteRefId);
		}

		// Evento único já cumpriu seu papel: sai da lista. Anual só marca o ano.
		const settings = this.readSettings();
		const events =
			event.recurrence === "once"
				? settings.events.filter((e) => e.id !== event.id)
				: settings.events.map((e) =>
						e.id === event.id ? { ...e, lastFiredYear: now.getFullYear() } : e
					);
		await this.context?.updateSettings({ events });
	}

	private pathForDate(date: Date): string {
		const paths = this.context!.getFullSettings().paths;
		const year = date.getFullYear();
		const month = pad(date.getMonth() + 1);
		const day = pad(date.getDate());
		// Pasta do mês com número E nome ("09 - Setembro"): o número mantém a
		// ordenação alfabética correta, o nome torna a pasta legível.
		const folder = monthFolderName(date.getMonth());
		return normalizePath(`${paths.calendarFolder}/${year}/${folder}/${day}-${month}-${year}.md`);
	}

	/** Cria (ou retorna) a nota daquela data, aplicando o template escolhido. */
	async openOrCreateForDate(date: Date, templateName?: string): Promise<TFile> {
		const path = this.pathForDate(date);
		const existing = this.context!.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			await this.context?.bus.emit("calendar:note-opened", { path }, "calendar");
			return existing;
		}

		const folder = path.substring(0, path.lastIndexOf("/"));
		await ensureVaultFolder(this.context!.app, folder);

		const year = date.getFullYear();
		const month = pad(date.getMonth() + 1);
		const day = pad(date.getDate());

		// O corpo vem do template (se houver); os metadados são gravados depois,
		// via processFrontMatter, para o bloco `---` ficar sempre no topo.
		let body = "";
		if (templateName) {
			body = (await this.readTemplate(templateName)) ?? "";
		}

		const file = await this.context!.app.vault.create(path, stripFrontmatter(body).trim());

		await this.context!.app.fileManager.processFrontMatter(file, (fm) => {
			fm.date = `${year}-${month}-${day}`;
			// Mesmos metadados do módulo de Templates, para as duas famílias de
			// notas ficarem consultáveis do mesmo jeito.
			fm.thema = ["Calendario", String(year), MONTH_NAMES[date.getMonth()]];
			fm.origem = path;
			fm.status = "Completo";
		});
		this.context?.log(`Nota de calendário criada: ${path}`, { path });
		await this.context?.bus.emit("calendar:note-created", { path, templateName }, "calendar");
		return file;
	}

	async listAvailableTemplates(): Promise<string[]> {
		const paths = this.context!.getFullSettings().paths;
		const folder = this.context!.app.vault.getAbstractFileByPath(
			normalizePath(paths.calendarTemplatesFolder)
		);
		if (!(folder instanceof TFolder)) return [];
		return folder.children
			.filter((c): c is TFile => c instanceof TFile && c.extension === "md")
			.map((c) => c.basename);
	}

	private async readTemplate(name: string): Promise<string | null> {
		const paths = this.context!.getFullSettings().paths;
		const path = normalizePath(`${paths.calendarTemplatesFolder}/${name}.md`);
		const file = this.context!.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return null;
		return this.context!.app.vault.read(file);
	}


	async addEvent(event: Omit<CalendarEvent, "id">): Promise<void> {
		const settings = this.readSettings();
		const full: CalendarEvent = { ...event, id: `evt-${Date.now()}` };
		await this.context?.updateSettings({ events: [...settings.events, full] });
	}

	async removeEvent(id: string): Promise<void> {
		const settings = this.readSettings();
		await this.context?.updateSettings({ events: settings.events.filter((e) => e.id !== id) });
	}

	/**
	 * Localiza a nota vinculada a um evento pelo METADADO `origem_evento`
	 * (não pelo caminho/nome) — assim, renomear ou mover a nota não quebra
	 * o vínculo, diferente de guardar só um caminho fixo.
	 */
	private findNoteByRefId(refId: string): TFile | null {
		for (const file of this.context!.app.vault.getMarkdownFiles()) {
			const fm = this.context!.app.metadataCache.getFileCache(file)?.frontmatter;
			if (fm?.origem_evento === refId) return file;
		}
		return null;
	}

	private async openNoteByRef(refId: string): Promise<void> {
		const file = this.findNoteByRefId(refId);
		if (file) await this.context!.app.workspace.getLeaf(false).openFile(file);
	}

	/** Vincula uma nota EXISTENTE a um evento: grava o metadado e move para a pasta de eventos. */
	async linkExistingNote(file: TFile, refId: string): Promise<void> {
		const folder = this.readSettings().eventNotesFolder;

		await ensureVaultFolder(this.context!.app, folder);
		const target = await uniqueVaultPath(this.context!.app, normalizePath(`${folder}/${file.name}`));
		if (target !== file.path) {
			await this.context!.app.fileManager.renameFile(file, target);
		}
		const moved = this.context!.app.vault.getAbstractFileByPath(target);
		if (moved instanceof TFile) {
			await this.context!.app.fileManager.processFrontMatter(moved, (fm) => {
				fm.origem_evento = refId;
			});
			await this.openInBackground(moved);
		}
	}

	/** Cria uma nota NOVA já vinculada, na pasta configurável (padrão: Calendario/notas). */
	async createLinkedNote(name: string, refId: string, folderOverride?: string): Promise<TFile> {
		const folder = folderOverride?.trim() || this.readSettings().eventNotesFolder;
		await ensureVaultFolder(this.context!.app, folder);
		const path = await uniqueVaultPath(this.context!.app, normalizePath(`${folder}/${name}.md`));
		const file = await this.context!.app.vault.create(path, "");
		await this.context!.app.fileManager.processFrontMatter(file, (fm) => {
			fm.origem_evento = refId;
			fm.date = new Date().toISOString().slice(0, 10);
			fm.thema = ["Calendario", "Eventos"];
		});
		await this.openInBackground(file);
		return file;
	}

	/**
	 * Abre a nota numa aba nova SEM tirar o foco — `active: false` é o que
	 * evita roubar o foco do formulário de evento que ainda está aberto.
	 * Antes, a nota criada/vinculada não abria em lugar nenhum; o usuário
	 * tinha que ir procurá-la depois.
	 */
	private async openInBackground(file: TFile): Promise<void> {
		const leaf = this.context!.app.workspace.getLeaf(true);
		await leaf.openFile(file, { active: false });
	}


	/** Pasta das notas de evento, criada sob demanda. */
	async ensureEventNotesFolder(): Promise<string> {
		const folder = this.readSettings().eventNotesFolder;

		await ensureVaultFolder(this.context!.app, folder);
		return folder;
	}

	getHealthStatus() {
		const settings = this.readSettings();
		return { ok: true, summary: `${settings.events.length} evento(s) configurado(s)` };
	}
}

function pad(n: number): string {
	return String(n).padStart(2, "0");
}


/** Remove um bloco de frontmatter do início do texto, se houver. */
function stripFrontmatter(content: string): string {
	if (!content.startsWith("---")) return content;
	const end = content.indexOf("\n---", 3);
	if (end === -1) return content;
	return content.slice(end + 4);
}

/** O que o usuário escolheu fazer ao clicar num dia. */
export type DayAction =
	| { kind: "note"; template: string | null }
	| { kind: "event" };

/**
 * Modal de escolha ao clicar numa data: nota com template, nota vazia ou
 * marcar um evento. Substitui o antigo seletor que só oferecia templates.
 */
class DayActionModal extends Modal {
	constructor(
		app: App,
		private date: Date,
		private templates: string[],
		private onChoose: (action: DayAction) => void | Promise<void>
	) {
		super(app);
	}

	onOpen(): void {
		const label = this.date.toLocaleDateString("pt-BR", {
			day: "2-digit",
			month: "long",
			year: "numeric",
		});
		this.contentEl.createEl("h2", { text: label });
		this.contentEl.createEl("p", {
			cls: "ione-hub-lobby__description",
			text: "O que você quer fazer nesta data?",
		});

		this.contentEl.createEl("h3", { text: "Criar nota" });
		for (const template of this.templates) {
			this.action(`📄 Com o template "${template}"`, { kind: "note", template });
		}
		if (this.templates.length === 0) {
			this.contentEl.createEl("p", {
				cls: "ione-hub-lobby__description",
				text: "Nenhum template encontrado. Coloque arquivos .md na pasta de templates do calendário para que apareçam aqui.",
			});
		}
		this.action("📝 Nota vazia (só com os metadados)", { kind: "note", template: null });

		this.contentEl.createEl("h3", { text: "Marcar evento" });
		this.action("🔔 Criar um evento nesta data", { kind: "event" });
	}

	private action(label: string, action: DayAction): void {
		const btn = this.contentEl.createEl("button", { text: label });
		btn.style.display = "block";
		btn.style.width = "100%";
		btn.style.marginBottom = "6px";
		btn.style.textAlign = "left";
		btn.onclick = async () => {
			await this.onChoose(action);
			this.close();
		};
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/**
 * Formulário de evento — cria OU edita, dependendo se `existing` foi passado.
 * Recorrência, data, horário, lembrete, descrição e nota a abrir, tudo numa
 * janela só. A seção "nota vinculada" oferece selecionar uma nota já
 * existente (que é movida para a pasta de eventos e ganha o metadado
 * `origem_evento`) ou criar uma nota nova numa pasta configurável
 * (padrão: Calendario/notas).
 */
class EventEditorModal extends Modal {
	private draft: Omit<CalendarEvent, "id">;
	private noteMode: "none" | "existing" | "create" = "none";
	private selectedExistingPath = "";
	private newNoteName = "";
	private newNoteFolder: string;
	/** refId reaproveitado se já havia nota vinculada (edição); novo se ainda não. */
	private noteRefId: string;

	constructor(
		app: App,
		date: Date,
		private notes: string[],
		private defaultNoteFolder: string,
		private onSave: (
			event: Omit<CalendarEvent, "id">,
			noteAction: { kind: "none" } | { kind: "existing"; path: string } | { kind: "create"; name: string; folder: string }
		) => void | Promise<void>,
		private existing?: CalendarEvent
	) {
		super(app);
		this.newNoteFolder = defaultNoteFolder;
		this.noteRefId = existing?.noteRefId ?? `note-${Date.now()}`;
		if (existing) {
			this.noteMode = existing.noteRefId ? "existing" : "none";
			this.draft = { ...existing };
		} else {
			this.draft = {
				title: "",
				description: "",
				recurrence: "yearly",
				day: date.getDate(),
				month: date.getMonth() + 1,
				year: date.getFullYear(),
				reminder: true,
			};
		}
	}

	onOpen(): void {
		this.contentEl.empty();
		this.contentEl.createEl("h2", { text: this.existing ? "Editar evento" : "Novo evento" });

		new Setting(this.contentEl)
			.setName("Título")
			.setDesc('O que é o evento. Ex.: "Aniversário do Fulano".')
			.addText((text) => text.setValue(this.draft.title).onChange((v) => (this.draft.title = v)));

		new Setting(this.contentEl)
			.setName("Descrição")
			.setDesc('Texto mostrado no lembrete. Ex.: "lembrar de comprar presente".')
			.addTextArea((area) =>
				area.setValue(this.draft.description).onChange((v) => (this.draft.description = v))
			);

		new Setting(this.contentEl)
			.setName("Repetição")
			.setDesc("Anual repete todo ano na mesma data. Único dispara uma vez e some da lista.")
			.addDropdown((dd) =>
				dd
					.addOption("yearly", "Todo ano nesta data")
					.addOption("once", "Só uma vez")
					.setValue(this.draft.recurrence)
					.onChange((v) => {
						this.draft.recurrence = v as "once" | "yearly";
						this.onOpen();
					})
			);

		new Setting(this.contentEl)
			.setName("Dia")
			.addText((text) =>
				text.setValue(String(this.draft.day)).onChange((v) => (this.draft.day = Number(v)))
			);

		new Setting(this.contentEl)
			.setName("Mês")
			.addDropdown((dd) => {
				MONTH_NAMES.forEach((name, index) => dd.addOption(String(index + 1), name));
				dd.setValue(String(this.draft.month));
				dd.onChange((v) => (this.draft.month = Number(v)));
			});

		if (this.draft.recurrence === "once") {
			new Setting(this.contentEl)
				.setName("Ano")
				.setDesc("Obrigatório para eventos de data única.")
				.addText((text) =>
					text.setValue(String(this.draft.year ?? "")).onChange((v) => (this.draft.year = Number(v)))
				);
		}

		new Setting(this.contentEl)
			.setName("Horário (opcional)")
			.setDesc("Formato HH:MM. Com horário, o evento só dispara a partir dele. Vazio = qualquer hora do dia.")
			.addText((text) =>
				text
					.setPlaceholder("14:30")
					.setValue(this.draft.time ?? "")
					.onChange((v) => (this.draft.time = v.trim() || undefined))
			);

		new Setting(this.contentEl)
			.setName("Mostrar lembrete")
			.setDesc(
				"Abre uma janela com som quando o evento chega. Por padrão, se o Obsidian estiver " +
					"minimizado, só o ícone da barra de tarefas pisca — configurável em Calendário → ⚙️ Configurações."
			)
			.addToggle((toggle) =>
				toggle.setValue(this.draft.reminder).onChange((v) => (this.draft.reminder = v))
			);

		// ---- Nota vinculada ----
		this.contentEl.createEl("h3", { text: "Nota vinculada (opcional)" });
		this.contentEl.createEl("p", {
			cls: "ione-hub-lobby__description",
			text:
				'Ex.: um evento "Fazer compras" que abre sua lista de compras. O vínculo é feito por ' +
				"um metadado dentro da nota, então renomear ou mover ela depois continua funcionando.",
		});

		new Setting(this.contentEl)
			.setName("O que fazer")
			.addDropdown((dd) =>
				dd
					.addOption("none", "Nenhuma nota")
					.addOption("existing", "Selecionar nota existente")
					.addOption("create", "Criar nota nova")
					.setValue(this.noteMode)
					.onChange((v) => {
						this.noteMode = v as typeof this.noteMode;
						this.onOpen();
					})
			);

		if (this.noteMode === "existing") {
			this.contentEl.createEl("p", {
				cls: "ione-hub-lobby__description",
				text: "Será movida para a pasta de notas de evento e ganhará o metadado de vínculo.",
			});
			const setting = new Setting(this.contentEl).setName("Nota");
			const input = setting.controlEl.createEl("input", {
				type: "text",
				placeholder: "Digite para filtrar entre suas notas...",
			});
			input.value = this.selectedExistingPath;
			input.style.width = "100%";
			const box = this.contentEl.createDiv();
			attachFilterSuggest(input, box, this.notes, (v) => (this.selectedExistingPath = v));
			input.oninput = () => (this.selectedExistingPath = input.value);
		} else if (this.noteMode === "create") {
			new Setting(this.contentEl)
				.setName("Nome da nova nota")
				.addText((text) => text.onChange((v) => (this.newNoteName = v)));

			this.contentEl.createEl("p", {
				cls: "ione-hub-lobby__description",
				text: `Pasta — padrão "${this.defaultNoteFolder}". Digite para filtrar entre as pastas do vault.`,
			});
			const folderSetting = new Setting(this.contentEl).setName("Pasta");
			const folderInput = folderSetting.controlEl.createEl("input", { type: "text" });
			folderInput.value = this.newNoteFolder;
			folderInput.style.width = "100%";
			const folderBox = this.contentEl.createDiv();
			attachFilterSuggest(folderInput, folderBox, this.allFolders(), (v) => (this.newNoteFolder = v));
			folderInput.oninput = () => (this.newNoteFolder = folderInput.value);
		}

		new Setting(this.contentEl)
			.addButton((btn) =>
				btn
					.setButtonText(this.existing ? "Salvar alterações" : "Salvar evento")
					.setCta()
					.onClick(async () => {
						const errors = this.validate();
						if (errors.length > 0) {
							new Notice(errors.join("\n"), 8000);
							return;
						}

						const finalDraft: Omit<CalendarEvent, "id"> = {
							...this.draft,
							noteRefId: this.noteMode === "none" ? undefined : this.noteRefId,
						};

						const noteAction =
							this.noteMode === "existing"
								? ({ kind: "existing", path: this.selectedExistingPath } as const)
								: this.noteMode === "create"
									? ({ kind: "create", name: this.newNoteName.trim(), folder: this.newNoteFolder } as const)
									: ({ kind: "none" } as const);

						if (this.noteMode === "existing" && !this.selectedExistingPath) {
							new Notice("Escolha uma nota, ou mude para \"Nenhuma nota\".");
							return;
						}
						if (this.noteMode === "create" && !this.newNoteName.trim()) {
							new Notice("Dê um nome para a nota nova.");
							return;
						}

						await this.onSave(finalDraft, noteAction);
						this.close();
					})
			)
			.addButton((btn) => btn.setButtonText("Cancelar").onClick(() => this.close()));
	}

	/** Lista de pastas do vault, para o filtro de digitação da pasta de destino. */
	private allFolders(): string[] {
		const folders: string[] = [];
		for (const file of this.app.vault.getAllLoadedFiles()) {
			if (file instanceof TFolder && file.path !== "/") folders.push(file.path);
		}
		return folders.sort();
	}

	private validate(): string[] {
		const errors: string[] = [];
		if (!this.draft.title.trim()) errors.push("Dê um título ao evento.");
		if (!Number.isInteger(this.draft.day) || this.draft.day < 1 || this.draft.day > 31) {
			errors.push("Dia inválido: use um número entre 1 e 31.");
		}
		if (this.draft.recurrence === "once") {
			const year = this.draft.year;
			if (!Number.isInteger(year) || !year || year < 1900 || year > 3000) {
				errors.push("Informe um ano válido para o evento de data única.");
			}
		}
		if (this.draft.time && !/^([01]?\d|2[0-3]):[0-5]\d$/.test(this.draft.time)) {
			errors.push("Horário inválido: use o formato HH:MM, como 14:30.");
		}
		return errors;
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
