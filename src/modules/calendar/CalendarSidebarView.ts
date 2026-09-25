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
		const calendar = this.core.getModules().find((m) => m.manifest.id === "calendar");
		if (!(calendar instanceof CalendarModule)) {
			this.contentEl.createEl("p",{text:"O módulo Calendário está desligado."});
			return;
		}
		await calendar.renderSidebarCalendar(this.contentEl);
		const open = this.contentEl.createEl("button",{text:"Abrir Calendário"});
		open.onclick = async () => {
			const leaf = this.app.workspace.getLeaf("tab");
			await leaf.setViewState({type:"ione-hub-lobby-view",active:true});
			this.app.workspace.revealLeaf(leaf);
			await this.core.bus.emit("calendar:open-main",{}, "calendar-sidebar");
		};
	}
	async onClose(): Promise<void> { this.contentEl.empty(); }
}
