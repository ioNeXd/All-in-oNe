import { ItemView, WorkspaceLeaf } from "obsidian";
import type { HubCore } from "../../core/HubCore";
import { CalendarModule } from "./CalendarModule";

export const CALENDAR_SIDEBAR_VIEW_TYPE = "ione-hub-calendar-sidebar";

export class CalendarSidebarView extends ItemView {
	constructor(leaf: WorkspaceLeaf, private core: HubCore) { super(leaf); }
	getViewType(): string { return CALENDAR_SIDEBAR_VIEW_TYPE; }
	getDisplayText(): string { return "Calendário"; }
	getIcon(): string { return "calendar"; }
	async onOpen(): Promise<void> {
		this.contentEl.empty();
		if (!this.core.isModuleEnabled("calendar")) {
			this.contentEl.createEl("p", { text: "O módulo Calendário está desligado." });
			return;
		}
		const calendar = this.core.getModules().find((m) => m.manifest.id === "calendar");
		if (!(calendar instanceof CalendarModule)) {
			this.contentEl.createEl("p", { text: "O módulo Calendário está indisponível." });
			return;
		}
		const calendarContainer = this.contentEl.createDiv({ cls: "ione-hub-calendar-sidebar" });
		await calendar.renderSidebarCalendar(calendarContainer);
		const open = this.contentEl.createEl("button", { text: "Abrir Calendário", cls: "ione-hub-calendar-sidebar__open" });
		open.onclick = async () => {
			const leaf = this.app.workspace.getLeaf("tab");
			await leaf.setViewState({ type: "ione-hub-lobby-view", active: true });
			this.app.workspace.revealLeaf(leaf);
			await this.core.bus.emit("calendar:open-main", {}, "calendar-sidebar");
		};
	}
	async onClose(): Promise<void> { this.contentEl.empty(); }
}
