import { App, Modal, Notice, Setting } from "obsidian";
import type { HubCore } from "../core/HubCore";
import { ensureVaultFolder } from "../core/VaultPaths";
import { StylesModule } from "../modules/styles/StylesModule";

type Step = "tour" | "config" | "style";

export class OnboardingModal extends Modal {
	private step: Step = "tour";
	private calendarFolder: string;
	private calendarTemplatesFolder: string;
	private eventNotesFolder: string;
	private inboxFolder: string;
	private systemFolder: string;
	private filesFolder: string;
	private tourIndex = 0;

	constructor(app: App, private core: HubCore) {
		super(app);
		const s=core.settings.get();
		this.calendarFolder=s.paths.calendarFolder; this.calendarTemplatesFolder=s.paths.calendarTemplatesFolder;
		this.eventNotesFolder=(s.modules?.calendar?.eventNotesFolder as string)||"01 - Calendario/Notas-Eventos";
		this.inboxFolder=s.paths.inboxFolder||"00 - Inbox"; this.systemFolder=s.paths.systemFolder||"99 - Sistema"; this.filesFolder=s.paths.filesFolder||"99 - Sistema/arquivos";
	}

	onOpen():void{this.render()}
	private render():void{this.contentEl.empty();if(this.step==="tour")this.renderTour();else if(this.step==="config")this.renderConfig();else this.renderStyle()}
	private renderTour():void{
		const pages=[
			["All-in-oNe","Um hub modular para organizar seu vault, calendário, templates, estilos e ferramentas."],
			["Calendário","Crie notas por data, use templates, marque eventos e receba lembretes."],
			["Templates e Estilos","Templates automatizam notas por pasta; Estilos centraliza a aparência do plugin e do Obsidian."],
			["Pronto","Depois do tour, você poderá revisar os caminhos e escolher um estilo inicial."]
		];
		const [title,body]=pages[this.tourIndex];this.contentEl.createEl("h2",{text:title});this.contentEl.createEl("p",{text:body});this.contentEl.createEl("p",{cls:"ione-hub-lobby__description",text:(this.tourIndex+1)+" / "+pages.length});
		const footer=this.contentEl.createDiv({cls:"ione-hub-onboarding__footer"});
		footer.createEl("button",{text:"Pular tour"}).onclick=()=>{this.step="config";this.render()};
		const next=footer.createEl("button",{text:this.tourIndex===pages.length-1?"Configurar":"Próximo",cls:"mod-cta"});next.onclick=()=>{if(this.tourIndex===pages.length-1){this.step="config";this.render()}else{this.tourIndex++;this.render()}};
	}
	private renderConfig():void{
		this.contentEl.createEl("h2",{text:"Configuração inicial"});this.contentEl.createEl("p",{text:"Revise os caminhos. Nada será criado até confirmar."});
		const fields:Array<["calendarFolder"|"calendarTemplatesFolder"|"eventNotesFolder"|"inboxFolder"|"systemFolder"|"filesFolder",string,string]> = [
			["calendarFolder","Calendário","01 - Calendario"],["calendarTemplatesFolder","Templates","99 - Sistema/templetes"],["eventNotesFolder","Notas de eventos","01 - Calendario/Notas-Eventos"],["inboxFolder","Inbox","00 - Inbox"],["systemFolder","Sistema","99 - Sistema"],["filesFolder","Arquivos","99 - Sistema/arquivos"]];
		for(const [key,label,placeholder] of fields)new Setting(this.contentEl).setName(label).addText(t=>{t.setValue(String(this[key]));t.setPlaceholder(placeholder);t.onChange(v=>{(this as unknown as Record<string,unknown>)[key as string]=v})});
		const footer=this.contentEl.createDiv({cls:"ione-hub-onboarding__footer"});
		footer.createEl("button",{text:"Pular configuração"}).onclick=()=>void this.finish(false);
		footer.createEl("button",{text:"Continuar",cls:"mod-cta"}).onclick=()=>{this.step="style";this.render()};
	}
	private renderStyle():void{
		this.contentEl.createEl("h2",{text:"Estilo inicial"});this.contentEl.createEl("p",{text:"A escolha usa o mesmo módulo Estilos. Você pode ignorar e ajustar depois."});
		const panel=this.contentEl.createDiv({cls:"ione-hub-onboarding__style-preview"});
		const styles=this.core.getModules().find(m=>m.manifest.id==="styles");
		if(styles?.renderSettingsPanel)this.contentEl.createEl("p",{text:"Abra o módulo Estilos depois para escolher ou editar o tema. O onboarding não cria um segundo mecanismo de estilos."});
		const footer=this.contentEl.createDiv({cls:"ione-hub-onboarding__footer"});
		footer.createEl("button",{text:"Ignorar"}).onclick=()=>void this.finish(true);footer.createEl("button",{text:"Concluir",cls:"mod-cta"}).onclick=()=>void this.finish(true);
		void panel;
	}
	private async finish(completed: boolean): Promise<void> {
		const settings = this.core.settings.get();
		const currentModules = settings.modules ?? {};
		const next = {
			...settings,
			onboardingCompleted: completed,
			paths: {
				...settings.paths,
				calendarFolder: this.calendarFolder,
				calendarTemplatesFolder: this.calendarTemplatesFolder,
				inboxFolder: this.inboxFolder,
				systemFolder: this.systemFolder,
				filesFolder: this.filesFolder,
			},
			modules: {
				...currentModules,
				calendar: { ...(currentModules.calendar ?? {}), eventNotesFolder: this.eventNotesFolder },
			},
		};
		let issues;
		try {
			issues = await this.core.settings.save(next);
		} catch (err) {
			console.error("[All iₙ oNe] Onboarding: falha ao salvar configuração inicial:", err);
			new Notice("Não foi possível salvar a configuração inicial. Tente novamente.", 8000);
			return;
		}
		const blocking = issues.filter((i) => i.level === "error");
		if (blocking.length > 0) {
			new Notice(blocking.map((i) => i.message).join("\n"), 8000);
			return;
		}
		for (const path of [this.inboxFolder, this.calendarFolder, this.eventNotesFolder, this.systemFolder, this.filesFolder, this.calendarTemplatesFolder]) {
			await ensureVaultFolder(this.core.app, path);
		}
		this.close();
	}
}
