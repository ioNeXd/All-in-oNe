import { App, Modal, Setting, TFile } from "obsidian";
import type { CalendarEvent } from "./EventTypes";
import type { AudioUnlocker } from "../../core/AudioUnlock";

export class ReminderModal extends Modal {
	constructor(app: App, private events: CalendarEvent[], private onOpenNote: (refId: string) => void | Promise<void>, private onEditEvent: (event: CalendarEvent) => void, private autoFocus = false) { super(app); }
	onOpen(): void {
		this.modalEl.addClass("ione-hub-reminder"); flashTaskbarIcon(); if (this.autoFocus) bringWindowToFront();
		this.contentEl.createEl("div", { cls: "ione-hub-reminder__badge", text: "⏰ Lembretes" });
		this.contentEl.createEl("h2", { text: this.events.length === 1 ? this.events[0].title : this.events.length + " eventos" });
		for (const event of this.events) {
			const card = this.contentEl.createDiv({ cls: "ione-hub-reminder__event" }); card.createEl("strong", { text: event.title });
			if (event.description) card.createEl("p", { cls: "ione-hub-reminder__description", text: event.description });
			card.createEl("div", { cls: "ione-hub-reminder__when", text: event.time ? "Hoje às " + event.time : "Hoje" });
			const actions = new Setting(card);
			if (event.noteRefId) {
				actions.addButton(btn => btn.setButtonText("Abrir nota").onClick(async () => { await this.onOpenNote(event.noteRefId!); this.close(); }));
				actions.addButton(btn => btn.setButtonText("Criar/selecionar nova nota").onClick(() => { this.close(); this.onEditEvent(event); }));
			}
			actions.addButton(btn => btn.setButtonText("Editar evento").onClick(() => { this.close(); this.onEditEvent(event); }));
		}
		new Setting(this.contentEl).addButton(btn => btn.setButtonText("Ok, entendi").setCta().onClick(() => this.close()));
	}
	onClose(): void { stopFlashing(); this.contentEl.empty(); }
}
export function flashTaskbarIcon(): void { const win=getElectronWindow(); if(!win)return; try{if(!win.isFocused?.())win.flashFrame?.(true)}catch{} }
export function bringWindowToFront(): void { const win=getElectronWindow(); if(!win)return; try{if(win.isMinimized?.())win.restore?.();win.show?.();win.setAlwaysOnTop?.(true);window.setTimeout(()=>win.setAlwaysOnTop?.(false),1500)}catch{} }
export function stopFlashing(): void { try{getElectronWindow()?.flashFrame?.(false)}catch{} }
interface ElectronWindowLike { isFocused?:()=>boolean; isMinimized?:()=>boolean; restore?:()=>void; show?:()=>void; flashFrame?:(flag:boolean)=>void; setAlwaysOnTop?:(flag:boolean)=>void; }
function getElectronWindow(): ElectronWindowLike|null { try{const electron=(window as unknown as {require?: (m:string)=>unknown}).require?.("electron");const remote=(electron as {remote?:{getCurrentWindow?:()=>ElectronWindowLike}})?.remote;return remote?.getCurrentWindow?.()??null}catch{return null} }
export async function playReminderChime(unlocker: AudioUnlocker): Promise<void> { const audioCtx=unlocker.getRunningContext();if(!audioCtx)return;try{const ctx=audioCtx as unknown as AudioContext;[659.25,783.99,1046.5].forEach((frequency,index)=>{const start=ctx.currentTime+index*.18,osc=ctx.createOscillator(),gain=ctx.createGain();osc.type="sine";osc.frequency.value=frequency;osc.connect(gain);gain.connect(ctx.destination);gain.gain.setValueAtTime(.0001,start);gain.gain.exponentialRampToValueAtTime(.25,start+.02);gain.gain.exponentialRampToValueAtTime(.0001,start+.35);osc.start(start);osc.stop(start+.4)})}catch{} }
export async function openNoteByPath(app: App,path: string): Promise<void> { const file=app.vault.getAbstractFileByPath(path);if(file instanceof TFile)await app.workspace.getLeaf(false).openFile(file); }
