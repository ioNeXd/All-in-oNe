import { App, Modal, Setting, TFile } from "obsidian";
import type { CalendarEvent } from "./EventTypes";\nimport type { AudioUnlocker } from "../../core/AudioUnlock";

export class ReminderModal extends Modal {
\tconstructor(
\t\tapp: App,
\t\tprivate events: CalendarEvent[],
\t\tprivate onOpenNote: (refId: string) => void | Promise<void>,
\t\tprivate onEditEvent: (event: CalendarEvent) => void,
\t\tprivate autoFocus = false
\t) { super(app); }

\tonOpen(): void {
\t\tthis.modalEl.addClass("ione-hub-reminder"); flashTaskbarIcon(); if (this.autoFocus) bringWindowToFront();
\t\tthis.contentEl.createEl("div",{cls:"ione-hub-reminder__badge",text:"⏰ Lembretes"});
\t\tthis.contentEl.createEl("h2",{text:this.events.length===1?this.events[0].title:this.events.length+" eventos"});
\t\tfor(const event of this.events){
\t\t\tconst card=this.contentEl.createDiv({cls:"ione-hub-reminder__event"});
\t\t\tcard.createEl("strong",{text:event.title});
\t\t\tif(event.description)card.createEl("p",{cls:"ione-hub-reminder__description",text:event.description});
\t\t\tcard.createEl("div",{cls:"ione-hub-reminder__when",text:event.time?"Hoje às "+event.time:"Hoje"});
\t\t\tconst actions=new Setting(card);
\t\t\tif(event.noteRefId){
\t\t\t\tactions.addButton(btn=>btn.setButtonText("Abrir nota").onClick(async()=>{await this.onOpenNote(event.noteRefId!);this.close()}));
\t\t\t\tactions.addButton(btn=>btn.setButtonText("Criar/selecionar nova nota").onClick(()=>{this.close();this.onEditEvent(event)}));
\t\t\t}
\t\t\tactions.addButton(btn=>btn.setButtonText("Editar evento").onClick(()=>{this.close();this.onEditEvent(event)}));
\t\t}
\t\tnew Setting(this.contentEl).addButton(btn=>btn.setButtonText("Ok, entendi").setCta().onClick(()=>this.close()));
\t}
\tonClose():void{stopFlashing();this.contentEl.empty();}
}

function flashTaskbarIcon():void{const win=getElectronWindow();if(!win)return;try{if(!win.isFocused?.())win.flashFrame?.(true)}catch{}}
export function bringWindowToFront():void{const win=getElectronWindow();if(!win)return;try{if(win.isMinimized?.())win.restore?.();win.show?.();win.setAlwaysOnTop?.(true);window.setTimeout(()=>win.setAlwaysOnTop?.(false),1500)}catch{}}
export function stopFlashing():void{try{getElectronWindow()?.flashFrame?.(false)}catch{}}
interface ElectronWindowLike{isFocused?:()=>boolean;isMinimized?:()=>boolean;restore?:()=>void;show?:()=>void;flashFrame?:(flag:boolean)=>void;setAlwaysOnTop?:(flag:boolean)=>void}
function getElectronWindow():ElectronWindowLike|null{try{const electron=(window as unknown as {require?: (m:string)=>unknown}).require?.("electron");const remote=(electron as {remote?:{getCurrentWindow?:()=>ElectronWindowLike}})?.remote;return remote?.getCurrentWindow?.()??null}catch{return null}}
export async function playReminderChime(unlocker: AudioUnlocker): Promise<void>{const audioCtx=unlocker.getRunningContext();if(!audioCtx)return;try{const ctx=audioCtx as unknown as AudioContext;[659.25,783.99,1046.5].forEach((frequency,index)=>{const start=ctx.currentTime+index*.18,osc=ctx.createOscillator(),gain=ctx.createGain();osc.type="sine";osc.frequency.value=frequency;osc.connect(gain);gain.connect(ctx.destination);gain.gain.setValueAtTime(.0001,start);gain.gain.exponentialRampToValueAtTime(.25,start+.02);gain.gain.exponentialRampToValueAtTime(.0001,start+.35);osc.start(start);osc.stop(start+.4)})}catch{}}
export async function openNoteByPath(app:App,path:string):Promise<void>{const file=app.vault.getAbstractFileByPath(path);if(file instanceof TFile)await app.workspace.getLeaf(false).openFile(file)}
