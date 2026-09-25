import { TFile, TFolder, normalizePath, Setting, Notice, Modal, App } from "obsidian";
import type { HubModule, ModuleContext, ModuleManifest } from "../../core/ModuleContract";
import { randomId } from "../../core/types";
import { ensureVaultFolder, uniqueVaultPath } from "../../core/VaultPaths";
import {
	type CalendarEvent,
	monthFolderName,
	describeEvent,
	shouldFire,
	nextEventDelayMs,
	MONTH_NAMES,
} from "./EventTypes";
import { parseIcs, mergeIcsEvents, type IcsParseResult } from "./IcsParser";
import { ReminderModal, playReminderChime } from "./ReminderModal";
import { AudioUnlocker } from "../../core/AudioUnlock";
import { attachFilterSuggest } from "../../ui/FilterSuggest";
import { dateKey, dailyNoteFilename, templateNoteFilename, firstAvailableTemplateSuffix, isCalendarNoteForDate } from "./CalendarNotes";
import { makeInteractiveRow, focusSiblingTab } from "../../ui/interactiveRows";
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
	/**
	 * Se true, o lembrete força a janela do Obsidian pra frente mesmo com o
	 * app minimizado. Desligado por padrão — ver ReminderModal.
	 */
	autoFocusOnReminder: boolean;
}

export const CALENDAR_DEFAULTS: CalendarModuleSettings = {
	events: [],
	view: "month",
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
 * e quais têm eventos marcados. O Calendário não interpreta `status`/`concluido`; pendências são responsabilidade de outro módulo.
 */
export class CalendarModule implements HubModule {
	readonly manifest: ModuleManifest = {
		id: "calendar",
		displayName: "Calendário",
		description: "Calendário integrado com o sistema de templates e eventos recorrentes notificáveis.",
		icon: "calendar",
		version: "0.3.0", // 0.1.0→0.2.0 no dev pré-baseline (nunca lançado); .ics + onResetData → 0.3.0
		contractVersion: "2.0.0",
		desktopOnly: false,
		emits: ["calendar:event-fired", "calendar:note-opened", "calendar:note-created"],
		listensTo: ["calendar:open-today"],
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
	/** Timer do agendador de lembretes (loop de setTimeout, ver scheduleNextCheck). */
	private dailyCheckInterval?: number;
	/**
	 * Desbloqueio de áudio próprio (core/AudioUnlock): cada módulo tem sua
	 * instância, com ciclo de vida independente. O lembrete dispara sozinho —
	 * o destravamento acontece no primeiro gesto do usuário (clique/tecla),
	 * armado no onEnable.
	 */
	private readonly audioUnlocker = new AudioUnlocker();
	/** Desinscrição do pedido da UI (calendar:open-today) — limpo no onDisable. */
	private busUnsubscribe?: () => void;
	private metadataUnsubscribe?: () => void;
	/** Estado da ÚLTIMA importação .ics — alimenta o Diagnóstico. */
	private lastIcsImport: { ok: boolean; detail: string } | undefined;
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
		// Arma o destravamento de áudio no primeiro gesto (política de autoplay).
		this.audioUnlocker.arm();
		// Verificação RETROATIVA imediata: se o Obsidian abriu depois da hora
		// de um evento de hoje (máquina desligada, app fechado), o evento
		// dispara já na ativação — dever automático não é polling.
		this.checkTodaysEvents();
		// Agendamento por evento em vez de polling fixo: um setTimeout até o
		// próximo disparo futuro (com teto de 1h para re-checagem de rotina e
		// virada de dia). Zero trabalho despertando o event loop quando não
		// há evento próximo; atraso do lembrete cai de "até 10s" para ~ms.
		this.scheduleNextCheck();

		this.context!.registerCommand("calendar-open-today", "Calendário: Abrir nota de hoje", () => {
			void this.openOrCreateForDate(new Date());
		});

		// Contrato com a UI: o Lobby pede a nota de hoje por EVENTO (não por
		// cast de método — a UI não conhece API interna de módulo). Inscrito no
		// onEnable: com o módulo desligado o pedido não tem destinatário, e o
		// Lobby já avisa o usuário antes de emitir.
		this.busUnsubscribe = this.context!.bus.on("calendar:open-today", "calendar", () => {
			void this.openOrCreateForDate(new Date());
		});
	}

	onDisable(): void {
		if (this.dailyCheckInterval) window.clearTimeout(this.dailyCheckInterval);
		this.dailyCheckInterval = undefined;
		this.busUnsubscribe?.();
		this.busUnsubscribe = undefined;
		this.metadataUnsubscribe?.();
		this.metadataUnsubscribe = undefined;
		this.audioUnlocker.disarm();
		// Limpa a dedupe de minuto junto: sem isto, um desligar→ligar dentro
		// do mesmo minuto pulava a checagem retroativa (e um lembrete sem
		// horário, elegível o dia todo, podia demorar até 1h para aparecer).
		this.lastCheckedMinute = "";
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
			tab.setAttr("role", "tab");
			tab.setAttr("aria-selected", this.activeTab === id ? "true" : "false");
			const activate = () => {
				this.activeTab = id;
				this.refreshPanel();
			};
			tab.onclick = activate;
			tab.onkeydown = (evt) => {
				if (evt.key === "Enter" || evt.key === " ") {
					evt.preventDefault();
					activate();
				} else {
					focusSiblingTab(evt, tabs, tab);
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
			.addButton((btn) => btn.setButtonText("Importar .ics").onClick(() => this.importIcsFile()))
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
							[event],
							(refId) => this.openNoteByRef(refId),
							(event) => this.editEvent(event),
							this.readSettings().autoFocusOnReminder
						).open();
						void playReminderChime(this.audioUnlocker);
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
		const defaultFolder = normalizePath(this.context!.getFullSettings().paths.calendarFolder + "/Notas-Eventos");
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
			[sample],
			() => Promise.resolve(),
			(event) => this.editEvent(event),
			this.readSettings().autoFocusOnReminder
		).open();
		void playReminderChime(this.audioUnlocker);
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
	private async renderMonthGrid(container: HTMLElement, compact = false): Promise<void> {
		const year=this.displayedMonth.getFullYear(), month=this.displayedMonth.getMonth();
		const header=container.createDiv({cls:"ione-hub-calendar__header"});
		const prev=header.createEl("button",{text:"←"}), next=header.createEl("button",{text:"→"});
		header.createSpan({text:this.displayedMonth.toLocaleDateString("pt-BR",{month:"long",year:"numeric"}),cls:"ione-hub-calendar__title"});
		prev.setAttr("aria-label","Mês anterior"); next.setAttr("aria-label","Próximo mês");
		prev.onclick=()=>{this.displayedMonth=new Date(year,month-1,1);this.rerenderView()}; next.onclick=()=>{this.displayedMonth=new Date(year,month+1,1);this.rerenderView()};
		if(!compact){const today=header.createEl("button",{text:"Hoje"});today.onclick=()=>{this.displayedMonth=new Date();this.rerenderView()};}
		const grid=container.createDiv({cls:"ione-hub-calendar"+(compact?" ione-hub-calendar--compact":"")});
		for(const label of WEEKDAY_LABELS)grid.createDiv({cls:"ione-hub-calendar__weekday",text:label});
		const firstWeekday=new Date(year,month,1).getDay(), daysInMonth=new Date(year,month+1,0).getDate(), prevDays=new Date(year,month,0).getDate(), total=Math.ceil((firstWeekday+daysInMonth)/7)*7;
		for(let i=0;i<total;i++){let d:Date,adj=false;if(i<firstWeekday){d=new Date(year,month-1,prevDays-firstWeekday+i+1);adj=true}else if(i>=firstWeekday+daysInMonth){d=new Date(year,month+1,i-firstWeekday-daysInMonth+1);adj=true}else d=new Date(year,month,i-firstWeekday+1);
			const cell=grid.createDiv({cls:"ione-hub-calendar__day"+(adj?" ione-hub-calendar__day--adjacent":"")});cell.createSpan({text:String(d.getDate())});
			const notes=this.findNotesForDate(d),events=this.eventsForDate(d);if(notes.length)cell.createSpan({cls:"ione-hub-calendar__dots",text:"●".repeat(Math.min(3,notes.length))});if(events.length){cell.addClass("ione-hub-calendar__day--has-event");cell.createSpan({cls:"ione-hub-calendar__event-indicator",text:"🔔"});cell.setAttr("title",events.map(e=>e.title).join(", "));}if(this.isToday(d.getFullYear(),d.getMonth(),d.getDate()))cell.addClass("ione-hub-calendar__day--today");
			cell.tabIndex=0;cell.addClass("ione-hub-focusable");cell.setAttr("role","button");cell.setAttr("aria-label",d.toLocaleDateString("pt-BR")+": "+notes.length+" nota(s), "+events.length+" evento(s)");cell.onclick=()=>void this.handleDayClick(d);cell.onkeydown=evt=>{if(evt.key==="Enter"||evt.key===" "){evt.preventDefault();void this.handleDayClick(d)}};
		}
	}

	/** Renderiza a mesma grade usada pelo módulo em uma sidebar compacta. */
	async renderSidebarCalendar(container: HTMLElement): Promise<void> {
		await this.renderMonthGrid(container, true);
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
			const hasNote = this.findNotesForDate(date).length > 0;
			row.createSpan({
				text: date.toLocaleDateString("pt-BR", { weekday: "short", day: "2-digit", month: "2-digit" }),
			});
			const events = this.eventsForDate(date);
			if (events.length > 0) row.createSpan({ text: ` — ${events.map((e) => e.title).join(", ")}` });
			if (hasNote) row.addClass("ione-hub-calendar__day--has-note");
			makeInteractiveRow(
				row,
				{ ariaLabel: `Abrir dia ${date.toLocaleDateString("pt-BR")} (semana)` },
				() => void this.handleDayClick(date)
			);
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
			const notes = this.findNotesForDate(date);
			if (events.length === 0 && notes.length === 0) continue;

			found++;
			const row = list.createDiv({ cls: "ione-hub-calendar__week-row" });
			row.createSpan({ text: date.toLocaleDateString("pt-BR") + " — " });
			const parts: string[] = [];
			if (events.length > 0) parts.push(events.map((e) => e.title).join(", "));
			if (notes.length > 0) parts.push(notes.length + " nota(s)");
			row.createSpan({ text: parts.join(" · ") });
			makeInteractiveRow(
				row,
				{ ariaLabel: `Abrir dia ${date.toLocaleDateString("pt-BR")} (agenda)` },
				() => void this.handleDayClick(date)
			);
		}

		if (found === 0) {
			list.createEl("p", {
				cls: "ione-hub-lobby__description",
				text: "Nada marcado nos próximos 30 dias.",
			});
		}
	}


	private findDailyNote(date: Date): TFile | null {
		const file = this.context!.app.vault.getAbstractFileByPath(this.pathForDate(date));
		return file instanceof TFile ? file : null;
	}

	private findNotesForDate(date: Date): TFile[] {
		const paths = this.context!.getFullSettings().paths;
		const folder = this.context!.app.vault.getAbstractFileByPath(normalizePath(paths.calendarFolder + "/" + date.getFullYear() + "/" + monthFolderName(date.getMonth())));
		if (!(folder instanceof TFolder)) return [];
		return folder.children.filter((file): file is TFile => file instanceof TFile && file.extension === "md" && isCalendarNoteForDate(file, date));
	}

	private isToday(year: number, month: number, day: number): boolean {
		const now = new Date();
		return now.getFullYear() === year && now.getMonth() === month && now.getDate() === day;
	}

	private rerenderView(): void {
		this.refreshPanel();
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
		const notes=this.findNotesForDate(date),events=this.eventsForDate(date),templates=await this.listAvailableTemplates();
		new DateActionModal(this.context!.app,date,notes,events,templates,{openNote:file=>this.context!.app.workspace.getLeaf(false).openFile(file),createDaily:async()=>{const f=await this.createDailyNote(date);await this.context!.app.workspace.getLeaf(false).openFile(f)},createTemplate:async t=>{const f=await this.createTemplateNote(date,t);await this.context!.app.workspace.getLeaf(false).openFile(f)},createEvent:()=>this.openEventEditor(date),editEvent:e=>this.editEvent(e),deleteEvent:e=>this.removeEvent(e.id)}).open();
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
		if (!this.context!.app.vault.getAbstractFileByPath(trimmed)) new Notice(`Caminho salvo, mas a pasta "${trimmed}" ainda não existe no vault. Ela será criada quando necessária.`, 8000);
		else new Notice("Caminho salvo.");
		this.refreshPanel();
	}

	private readSettings(): CalendarModuleSettings {
		return { ...CALENDAR_DEFAULTS, ...this.context?.getSettings<CalendarModuleSettings>() };
	}

	private lastCheckedMinute = "";

	/**
	 * Reagenda o timer para o próximo momento útil (próximo evento futuro ou
	 * teto de 1h). Chamado após CADA checagem — um loop de setTimeout, não
	 * um intervalo: o agendamento se recalcula com os eventos atuais (novo
	 * evento criado reagenda na próxima passada) e a checagem retroativa
	 * cobre o wake-up tardio do Obsidian/suspensão do SO.
	 */
	private scheduleNextCheck(): void {
		if (typeof window === "undefined") return;
		if (this.dailyCheckInterval) window.clearTimeout(this.dailyCheckInterval);
		this.dailyCheckInterval = window.setTimeout(() => {
			this.checkTodaysEvents();
			this.scheduleNextCheck();
		}, nextEventDelayMs(this.readSettings().events, new Date()));
	}

	/**
	 * Checagem de disparos. Roda no activation, após cada agendamento e no
	 * teto de rotina (1h) — a dedupe por minuto evita processar o mesmo
	 * minuto duas vezes (cheque imediato + timer logo em seguida).
	 *
	 * Contrato de UMA VEZ POR DIA: quem marca "já disparou" é o estado que
	 * fireEvent grava (lastFiredYear / remoção do evento único). Sem time,
	 * shouldFire é true no dia inteiro por design ("a qualquer hora") — é o
	 * estado, não o relógio, que impede repetição.
	 */
	private checkTodaysEvents(): void {
		const now=new Date(),key=now.toDateString()+" "+now.getHours()+":"+now.getMinutes();if(key===this.lastCheckedMinute)return;this.lastCheckedMinute=key;const fired=this.readSettings().events.filter(e=>shouldFire(e,now));if(fired.length)void this.fireEvents(fired,now);
	}
	private async fireEvents(events: CalendarEvent[],now: Date): Promise<void>{
		for(const event of events)await this.context?.bus.emit("calendar:event-fired",{event},"calendar");const reminders=events.filter(e=>e.reminder);
		if(reminders.length){new ReminderModal(this.context!.app,reminders,refId=>this.openNoteByRef(refId),event=>this.editEvent(event),this.readSettings().autoFocusOnReminder).open();void playReminderChime(this.audioUnlocker)}
		for(const event of events.filter(e=>!e.reminder&&e.noteRefId))await this.openNoteByRef(event.noteRefId!);const settings=this.readSettings(),ids=new Set(events.map(e=>e.id));const next=settings.events.filter(e=>e.recurrence!=="once"||!ids.has(e.id)).map(e=>ids.has(e.id)?{...e,lastFiredYear:now.getFullYear()}:e);await this.context?.updateSettings({events:next});this.scheduleNextCheck();
	}

	private pathForDate(date: Date): string {
		const p=this.context!.getFullSettings().paths;return normalizePath(p.calendarFolder+"/"+date.getFullYear()+"/"+monthFolderName(date.getMonth())+"/"+dailyNoteFilename(date));
	}
	async openOrCreateForDate(date: Date): Promise<TFile>{const e=this.findDailyNote(date);if(e){await this.context?.bus.emit("calendar:note-opened",{path:e.path},"calendar");return e}return this.createDailyNote(date)}
	async createDailyNote(date: Date): Promise<TFile>{
		const path=this.pathForDate(date),existing=this.context!.app.vault.getAbstractFileByPath(path);if(existing instanceof TFile)return existing;await ensureVaultFolder(this.context!.app,path.substring(0,path.lastIndexOf("/")));
		const tp=normalizePath(this.context!.getFullSettings().paths.calendarTemplatesFolder+"/calendario/Nota diaria.md"),tf=this.context!.app.vault.getAbstractFileByPath(tp);const body=tf instanceof TFile?stripFrontmatter(await this.context!.app.vault.read(tf)).trim():"";
		const file=await this.context!.app.vault.create(path,body);await this.context!.app.fileManager.processFrontMatter(file,fm=>{fm.date=dateKey(date);fm.thema=["Calendario",String(date.getFullYear()),MONTH_NAMES[date.getMonth()]];fm.origem=path;fm.concluido=false;fm.status=["incompleto"]});await this.context?.bus.emit("calendar:note-created",{path,templateName:"Nota diaria"},"calendar");return file;
	}
	async createTemplateNote(date: Date,template: string): Promise<TFile>{
		const root=normalizePath(this.context!.getFullSettings().paths.calendarTemplatesFolder),source=this.context!.app.vault.getAbstractFileByPath(normalizePath(root+"/"+template));if(!(source instanceof TFile))throw new Error("Template não encontrado: "+template);
		const folder=normalizePath(this.context!.getFullSettings().paths.calendarFolder+"/"+date.getFullYear()+"/"+monthFolderName(date.getMonth()));await ensureVaultFolder(this.context!.app,folder);
		const suffix=firstAvailableTemplateSuffix(this.findNotesForDate(date).map(f=>f.name),source.basename,date),path=normalizePath(folder+"/"+templateNoteFilename(source.basename,date,suffix));const file=await this.context!.app.vault.create(path,stripFrontmatter(await this.context!.app.vault.read(source)).trim());await this.context!.app.fileManager.processFrontMatter(file,fm=>{fm.date=dateKey(date);fm.thema=["Calendario",String(date.getFullYear()),MONTH_NAMES[date.getMonth()]];fm.origem=path;fm.concluido=false;fm.status=["incompleto"]});await this.context?.bus.emit("calendar:note-created",{path,templateName:template},"calendar");return file;
	}
	async listAvailableTemplates(): Promise<string[]>{
		const root=normalizePath(this.context!.getFullSettings().paths.calendarTemplatesFolder),folder=this.context!.app.vault.getAbstractFileByPath(root);if(!(folder instanceof TFolder))return[];const out:string[]=[];const walk=(f:TFolder)=>{for(const child of f.children){if(child instanceof TFolder)walk(child);else if(child instanceof TFile&&child.extension==="md"&&child.basename!=="Nota diaria")out.push(child.path.slice(root.length+1))}};walk(folder);return out.sort((a,b)=>a.localeCompare(b,"pt-BR"));
	}

	async addEvent(event: Omit<CalendarEvent, "id">): Promise<void> {
		const settings = this.readSettings();
		const full: CalendarEvent = { ...event, id: `evt-${randomId()}`, source: "manual" };
		await this.context?.updateSettings({ events: [...settings.events, full] });
		this.scheduleNextCheck();
	}

	/**
	 * IMPORTAR .ics: abre o seletor de arquivos, lê o texto, converte com o
	 * parser puro (IcsParser.ts) e mescla na fatia de eventos via
	 * updateSettings. Dedupe por UID do iCalendar: importar o mesmo arquivo
	 * de novo SUBSTITUI os eventos anteriores em vez de duplicar — eventos
	 * criados à mão nunca são tocados.
	 *
	 * Regra do projeto: falha de leitura/validação NÃO fica silenciosa —
	 * Notice com o motivo e o painel segue aberto, do jeito que estava.
	 */
	importIcsFile(): void {
		const input = document.createElement("input");
		input.type = "file";
		input.accept = ".ics,text/calendar";
		input.onchange = async () => {
			const file = input.files?.[0];
			if (!file) return;

			let parsed: IcsParseResult;
			try {
				parsed = parseIcs(await file.text());
			} catch (err) {
				this.lastIcsImport = {
					ok: false,
					detail: err instanceof Error ? err.message.slice(0, 140) : String(err).slice(0, 140),
				};
				new Notice(err instanceof Error ? err.message : String(err), 8000);
				return;
			}

			const settings = this.readSettings();
			await this.context?.updateSettings({
				events: mergeIcsEvents(settings.events, parsed.events),
			});
			this.scheduleNextCheck();

			const message = [`${parsed.events.length} evento(s) importado(s) de "${file.name}".`];
			if (parsed.warnings.length > 0) message.push("", ...parsed.warnings);
			if (parsed.limitations.length > 0) {
				message.push("", "⚠️ Importação parcial — funcionalidades ignoradas:", ...parsed.limitations);
			}
			new Notice(message.join("\n"), 8000);
			this.context?.log(`Eventos importados do .ics: ${file.name}`, { count: parsed.events.length });
			this.refreshPanel();
		};
		input.click();
	}

	async removeEvent(id: string): Promise<void> {
		const settings = this.readSettings();
		await this.context?.updateSettings({ events: settings.events.filter((e) => e.id !== id) });
		this.scheduleNextCheck();
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
		const folder = normalizePath(this.context!.getFullSettings().paths.calendarFolder + "/Notas-Eventos");

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
		const folder = normalizePath(this.context!.getFullSettings().paths.calendarFolder + "/Notas-Eventos");
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
		// Falha da última importação aparece no Diagnóstico — ok nunca esconde
		// uma importação que reprovou (fica visível até a próxima boa).
		if (this.lastIcsImport) {
			return {
				ok: this.lastIcsImport.ok,
				summary: this.lastIcsImport.ok
					? `${settings.events.length} evento(s) configurado(s); última importação: ${this.lastIcsImport.detail}`
					: `última importação .ics FALHOU: ${this.lastIcsImport.detail}`,
			};
		}
		return { ok: true, summary: `${settings.events.length} evento(s) configurado(s)` };
	}

	/**
	 * Reset nível "data"/"all": limpa APENAS os dados gerados. Dois níveis,
	 * com rótulo por origem: os eventos criados à mão (evt-*) são considerados
	 * configuração do usuário e FICAM; os importados de .ics (ics:<uid>) são
	 * considerados dados derivados e SAEM — o comentário do "Restaurar tudo"
	 * promete que notas nunca são apagadas; eventos importados seguem essa
	 * filosofia (refazer é um clique: reimportar o arquivo).
	 */
	onResetData(): Promise<void> {
		const settings = this.readSettings();
		const manual = settings.events.filter((e) => e.source === "manual" || !e.source);
		return (this.context?.updateSettings({ events: manual }) ?? Promise.resolve([])).then(
			() => this.scheduleNextCheck()
		);
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
interface DateActionCallbacks {
	openNote(file: TFile): void | Promise<void>;
	createDaily(): void | Promise<void>;
	createTemplate(template: string): void | Promise<void>;
	createEvent(): void;
	editEvent(event: CalendarEvent): void;
	deleteEvent(event: CalendarEvent): void | Promise<void>;
}

class DateActionModal extends Modal {
	constructor(
		app: App,
		private date: Date,
		private notes: TFile[],
		private events: CalendarEvent[],
		private templates: string[],
		private callbacks: DateActionCallbacks
	) { super(app); }

	onOpen(): void {
		this.contentEl.createEl("h2", { text: this.date.toLocaleDateString("pt-BR", { day: "2-digit", month: "long", year: "numeric" }) });
		if (this.notes.length === 0) this.button("📝 Nota diária", () => this.callbacks.createDaily());
		else if (this.notes.length === 1) this.button("📝 Nota diária", () => this.callbacks.openNote(this.notes[0]));
		else {
			this.contentEl.createEl("h3", { text: "📝 Notas do dia" });
			for (const note of this.notes) this.button(note.basename, () => this.callbacks.openNote(note));
		}
		this.contentEl.createEl("h3", { text: "📋 Nota template" });
		this.button("➕ Criar nota adicional", () => this.renderTemplates());
		this.renderTemplates();
		this.contentEl.createEl("h3", { text: "🔔 Eventos" });
		if (this.events.length === 0) this.button("Criar evento", this.callbacks.createEvent);
		else {
			for (const event of this.events) {
				const row = this.contentEl.createDiv({ cls: "ione-hub-calendar__event-row" });
				row.createEl("strong", { text: event.title });
				row.createSpan({ text: (event.time ? " · " + event.time : "") + (event.description ? " · " + event.description : "") });
				row.createEl("button", { text: "Editar" }).onclick = () => { this.close(); this.callbacks.editEvent(event); };
				row.createEl("button", { text: "Excluir" }).onclick = () => { this.close(); void this.callbacks.deleteEvent(event); };
			}
			this.button("➕ Criar evento", this.callbacks.createEvent);
		}
	}

	private renderTemplates(): void {
		const input = this.contentEl.createEl("input", { type: "search", placeholder: "Pesquisar template..." });
		const list = this.contentEl.createDiv({ cls: "ione-hub-calendar__template-list" });
		const render = () => {
			list.empty();
			const q = input.value.trim().toLowerCase();
			for (const template of this.templates.filter((x) => !q || x.toLowerCase().includes(q))) this.buttonInto(list, template, () => this.callbacks.createTemplate(template));
		};
		input.oninput = render;
		render();
	}

	private button(label: string, action: () => void | Promise<void>): void { this.buttonInto(this.contentEl, label, action); }
	private buttonInto(parent: HTMLElement, label: string, action: () => void | Promise<void>): void {
		const button = parent.createEl("button", { text: label });
		button.style.display = "block"; button.style.width = "100%"; button.style.marginBottom = "6px";
		button.onclick = () => { void action(); this.close(); };
	}
	onClose(): void { this.contentEl.empty(); }
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
		} else {
			// Validação real de calendário: dia vs. mês/ano.
			// Para "once", usa o ano informado; para "yearly", usa um ano bissexto
			// fictício para que 29/02 passe (repete todo ano, incluindo bissextos).
			const testYear = this.draft.recurrence === "once" ? (this.draft.year ?? 2024) : 2024;
			const daysInMonth = new Date(testYear, this.draft.month, 0).getDate();
			if (this.draft.day > daysInMonth) {
				errors.push(
					`Dia ${this.draft.day} não existe em ${MONTH_NAMES[this.draft.month - 1]} ` +
					`(${daysInMonth} dias no máximo).`
				);
			}
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
