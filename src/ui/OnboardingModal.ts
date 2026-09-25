import { App, Modal, Notice, Setting } from "obsidian";
import type { HubCore } from "../core/HubCore";
import { ensureVaultFolder } from "../core/VaultPaths";
import { StylesModule } from "../modules/styles/StylesModule";

type Step = "tour" | "config" | "style";

export class OnboardingModal extends Modal {
\tprivate step: Step = "tour";
\tprivate calendarFolder: string;
\tprivate calendarTemplatesFolder: string;
\tprivate eventNotesFolder: string;
\tprivate inboxFolder: string;
\tprivate systemFolder: string;
\tprivate filesFolder: string;
\tprivate tourIndex = 0;

\tconstructor(app: App, private core: HubCore) {
\t\tsuper(app);
\t\tconst s=core.settings.get();
\t\tthis.calendarFolder=s.paths.calendarFolder; this.calendarTemplatesFolder=s.paths.calendarTemplatesFolder;
\t\tthis.eventNotesFolder=(s.modules.calendar?.eventNotesFolder as string)||"01 - Calendario/Notas-Eventos";
\t\tthis.inboxFolder=s.paths.inboxFolder||"00 - Inbox"; this.systemFolder=s.paths.systemFolder||"99 - Sistema"; this.filesFolder=s.paths.filesFolder||"99 - Sistema/arquivos";
\t}

\tonOpen():void{this.render()}
\tprivate render():void{this.contentEl.empty();if(this.step==="tour")this.renderTour();else if(this.step==="config")this.renderConfig();else this.renderStyle()}
\tprivate renderTour():void{
\t\tconst pages=[
\t\t\t["All-in-oNe","Um hub modular para organizar seu vault, calendário, templates, estilos e ferramentas."],
\t\t\t["Calendário","Crie notas por data, use templates, marque eventos e receba lembretes."],
\t\t\t["Templates e Estilos","Templates automatizam notas por pasta; Estilos centraliza a aparência do plugin e do Obsidian."],
\t\t\t["Pronto","Depois do tour, você poderá revisar os caminhos e escolher um estilo inicial."]
\t\t];
\t\tconst [title,body]=pages[this.tourIndex];this.contentEl.createEl("h2",{text:title});this.contentEl.createEl("p",{text:body});this.contentEl.createEl("p",{cls:"ione-hub-lobby__description",text:(this.tourIndex+1)+" / "+pages.length});
\t\tconst footer=this.contentEl.createDiv({cls:"ione-hub-onboarding__footer"});
\t\tfooter.createEl("button",{text:"Pular tour"}).onclick=()=>{this.step="config";this.render()};
\t\tconst next=footer.createEl("button",{text:this.tourIndex===pages.length-1?"Configurar":"Próximo",cls:"mod-cta"});next.onclick=()=>{if(this.tourIndex===pages.length-1){this.step="config";this.render()}else{this.tourIndex++;this.render()}};
\t}
\tprivate renderConfig():void{
\t\tthis.contentEl.createEl("h2",{text:"Configuração inicial"});this.contentEl.createEl("p",{text:"Revise os caminhos. Nada será criado até confirmar."});
\t\tconst fields:Array<[keyof OnboardingModal,string,string]> = [
\t\t\t["calendarFolder","Calendário","01 - Calendario"],["calendarTemplatesFolder","Templates","99 - Sistema/templetes"],["eventNotesFolder","Notas de eventos","01 - Calendario/Notas-Eventos"],["inboxFolder","Inbox","00 - Inbox"],["systemFolder","Sistema","99 - Sistema"],["filesFolder","Arquivos","99 - Sistema/arquivos"]];
\t\tfor(const [key,label,placeholder] of fields)new Setting(this.contentEl).setName(label).addText(t=>{t.setValue(String(this[key]));t.setPlaceholder(placeholder);t.onChange(v=>{(this as unknown as Record<string,unknown>)[key as string]=v})});
\t\tconst footer=this.contentEl.createDiv({cls:"ione-hub-onboarding__footer"});
\t\tfooter.createEl("button",{text:"Pular configuração"}).onclick=()=>void this.finish(false);
\t\tfooter.createEl("button",{text:"Continuar",cls:"mod-cta"}).onclick=()=>{this.step="style";this.render()};
\t}
\tprivate renderStyle():void{
\t\tthis.contentEl.createEl("h2",{text:"Estilo inicial"});this.contentEl.createEl("p",{text:"A escolha usa o mesmo módulo Estilos. Você pode ignorar e ajustar depois."});
\t\tconst panel=this.contentEl.createDiv({cls:"ione-hub-onboarding__style-preview"});
\t\tconst styles=this.core.getModules().find(m=>m.manifest.id==="styles");
\t\tif(styles?.renderSettingsPanel)this.contentEl.createEl("p",{text:"Abra o módulo Estilos depois para escolher ou editar o tema. O onboarding não cria um segundo mecanismo de estilos."});
\t\tconst footer=this.contentEl.createDiv({cls:"ione-hub-onboarding__footer"});
\t\tfooter.createEl("button",{text:"Ignorar"}).onclick=()=>void this.finish(true);footer.createEl("button",{text:"Concluir",cls:"mod-cta"}).onclick=()=>void this.finish(true);
\t\tvoid panel;
\t}
\tprivate async finish(completed:boolean):Promise<void>{
\t\tconst s=this.core.settings.get();
\t\ttry{
\t\t\tconst issues=await this.core.settings.save({...s,onboardingCompleted:completed,paths:{...s.paths,calendarFolder:this.calendarFolder,calendarTemplatesFolder:this.calendarTemplatesFolder,inboxFolder:this.inboxFolder,systemFolder:this.systemFolder,filesFolder:this.filesFolder},modules:{...s.modules,calendar:{...(s.modules.calendar||{}),eventNotesFolder:this.eventNotesFolder}}});
\t\t\tconst blocking=issues.filter(i=>i.level==="error");if(blocking.length){new Notice(blocking.map(i=>i.message).join("\n"),8000);return}
\t\t\tfor(const p of [this.inboxFolder,this.calendarFolder,this.eventNotesFolder,this.systemFolder,this.filesFolder,this.calendarTemplatesFolder])await ensureVaultFolder(this.core.app,p);
\t\t\tthis.close();
\t\t}catch(err){console.error("[All iₙ oNe] Onboarding:",err);new Notice("Não foi possível salvar a configuração inicial.",8000)}
\t}
}
