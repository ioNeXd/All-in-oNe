import { ItemView, WorkspaceLeaf } from "obsidian";
import type { HubCore } from "../../core/HubCore";
import { CalendarModule } from "./CalendarModule";

export const CALENDAR_SIDEBAR_VIEW_TYPE = "ione-hub-calendar-sidebar";

export class CalendarSidebarView extends ItemView {
\tconstructor(leaf: WorkspaceLeaf, private core: HubCore) { super(leaf); }
\tgetViewType(): string { return CALENDAR_SIDEBAR_VIEW_TYPE; }
\tgetDisplayText(): string { return "Calendário"; }
\tgetIcon(): string { return "calendar"; }
\tasync onOpen(): Promise<void> {
\t\tthis.contentEl.empty();
\t\tconst calendar = this.core.getModules().find((m) => m.manifest.id === "calendar");
\t\tif (!(calendar instanceof CalendarModule)) {
\t\t\tthis.contentEl.createEl("p",{text:"O módulo Calendário está desligado."});
\t\t\treturn;
\t\t}
\t\tawait calendar.renderSidebarCalendar(this.contentEl);
\t\tconst open = this.contentEl.createEl("button",{text:"Abrir Calendário"});
\t\topen.onclick = async () => {
\t\t\tconst leaf = this.app.workspace.getLeaf("tab");
\t\t\tawait leaf.setViewState({type:"ione-hub-lobby-view",active:true});
\t\t\tthis.app.workspace.revealLeaf(leaf);
\t\t\tawait this.core.bus.emit("calendar:open-main",{}, "calendar-sidebar");
\t\t};
\t}
\tasync onClose(): Promise<void> { this.contentEl.empty(); }
}
