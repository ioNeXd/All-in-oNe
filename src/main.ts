import { Plugin, WorkspaceLeaf, Modal, App, Setting, Notice } from "obsidian";
import { HubCore } from "./core/HubCore";
import { createSplitPersistence } from "./core/SplitPersistence";
import type { HubSettings } from "./core/types";
import { LOBBY_VIEW_TYPE, LobbyView, LobbyModal } from "./ui/LobbyView";
import { OnboardingModal } from "./ui/OnboardingModal";
import { McpModule } from "./modules/mcp/McpModule";
import { StylesModule } from "./modules/styles/StylesModule";
import { AutoUpdateModule } from "./modules/autoupdate/AutoUpdateModule";
import { TemplatesModule } from "./modules/templates/TemplatesModule";
import { CalendarModule } from "./modules/calendar/CalendarModule";
import { NotificationsModule } from "./modules/notifications/NotificationsModule";
import { HistoryModule } from "./modules/history/HistoryModule";
import { FileLifecycleModule } from "./modules/filelifecycle/FileLifecycleModule";
import { VaultEventBridge } from "./core/VaultEventBridge";
import { CommandBridge } from "./core/CommandBridge";
import { ManualManager } from "./core/ManualManager";
import { CalendarSidebarView, CALENDAR_SIDEBAR_VIEW_TYPE } from "./modules/calendar/CalendarSidebarView";

/**
 * PLUGIN PRINCIPAL
 * -----------------
 * Este arquivo é deliberadamente enxuto: toda a lógica de verdade vive no
 * núcleo (src/core) e nos módulos (src/modules). O que este arquivo faz é
 * só a "cola" com a API real do Obsidian — coisas que só uma classe Plugin
 * consegue fazer (addCommand, addRibbonIcon, registerView, loadData/saveData).
 *
 * ORDEM DE INICIALIZAÇÃO (importante — não reordenar sem entender por quê):
 *   1. HubCore é criado e `init()` carrega/migra a configuração salva.
 *   2. A view do Lobby é registrada no workspace do Obsidian.
 *   3. Os 8 módulos são instanciados e registrados no núcleo — o núcleo
 *      decide, com base em `enabledModules`, quais de fato habilitar
 *      (lazy loading: um módulo desligado nunca chega a rodar onEnable).
 *   4. Comandos e ícone da ribbon são registrados por último, já que alguns
 *      dependem de módulos já estarem prontos (ex.: comando de restart do MCP
 *      é registrado pelo próprio módulo via context.registerCommand).
 */
export default class IoneHubPlugin extends Plugin {
	core!: HubCore;
	private vaultBridge?: VaultEventBridge;
	private calendarRibbon?: HTMLElement;
	private calendarRibbonUnsub?: () => void;

	async onload(): Promise<void> {
		this.core = new HubCore(
			this.app,
			() => this.loadData() as Promise<HubSettings | null>,
			(data) => this.saveData(data)
		);
		// Persistência SPLIT: fatias pesadas (Histórico/Notificações — write-
		// behind a cada ~2s) vão para arquivo próprio; o data.json principal
		// só é regravado quando o resto da config muda. Sem isto, cada flush
		// reescrevia o JSON inteiro (I/O e sync do vault). O load pelo
		// loadData() cru do core continua funcionando como fallback: sem os
		// arquivos por módulo, as fatias vêm do data.json como antes.
		this.core.settings.setSplitPersistence(
			createSplitPersistence(this.app, this.manifest.dir ?? ".obsidian/plugins/All-in-oNe")
		);

		// Ponte para que módulos consigam registrar comandos nativos do
		// Obsidian através do contrato (context.registerCommand). A lógica está
		// em src/core/CommandBridge.ts (testada) — aqui só a fiação:
		// - register = o addCommand real do plugin;
		// - isModuleEnabled = o estado de verdade do núcleo, consultado a cada
		//   invocação (checkCallback), nunca capturado no momento do registro.
		const commandBridge = new CommandBridge(
			(cmd) => this.addCommand(cmd),
			(moduleId) => this.core.isModuleEnabled(moduleId)
		);
		this.core.onRegisterCommand = (moduleId, cmdId, name, callback) => {
			commandBridge.registerCommand(moduleId, cmdId, name, callback);
		};

		await this.core.init();

		const syncCalendarRibbon = () => {
			if (this.core.isModuleEnabled("calendar")) {
				if (!this.calendarRibbon) {
					this.calendarRibbon = this.addRibbonIcon("calendar", "Abrir Calendário", () => {
						const leaf = this.app.workspace.getLeavesOfType(CALENDAR_SIDEBAR_VIEW_TYPE)[0];
						if (leaf) void this.app.workspace.revealLeaf(leaf);
						else {
							const target = this.app.workspace.getLeaf("tab");
							void target.setViewState({ type: CALENDAR_SIDEBAR_VIEW_TYPE, active: true });
						}
					});
				}
			} else if (this.calendarRibbon) {
				this.calendarRibbon.remove();
				this.calendarRibbon = undefined;
			}
		};
		syncCalendarRibbon();


		// Traduz eventos nativos do vault para o barramento interno. Fica no
		// núcleo (não num módulo) para que esses eventos existam sempre,
		// independentemente de quais módulos estejam ligados.
		// ORDEM IMPORTA: o módulo de Ciclo de Vida precisa existir (e registrar
		// seu listener de criação) ANTES do primeiro evento de criação que a
		// ponte possa repassar — e o callback abaixo o referencia, então a
		// instância tem que já existir aqui.
		const fileLifecycle = new FileLifecycleModule();
		this.vaultBridge = new VaultEventBridge(
			this.app,
			this.core.bus,
			() => this.core.isModuleEnabled("filelifecycle"),
			(oldPath) => fileLifecycle.isInternalNamingRename(oldPath)
		);
		this.vaultBridge.start();

		this.registerView(LOBBY_VIEW_TYPE, (leaf) => new LobbyView(leaf, this.core));
		this.registerView(CALENDAR_SIDEBAR_VIEW_TYPE, (leaf) => new CalendarSidebarView(leaf, this.core));

		const autoUpdate = new AutoUpdateModule();
		autoUpdate.setCurrentVersion(this.manifest.version);

		const modules = [
			fileLifecycle,
			new McpModule(),
			new StylesModule(),
			autoUpdate,
			new TemplatesModule(),
			new CalendarModule(),
			new NotificationsModule(),
			new HistoryModule(),
		];

		for (const module of modules) {
			await this.core.registerModule(module);
		}

		this.addRibbonIcon("layout-dashboard", "Abrir All iₙ oNe", () => {
			void this.openLobby();
		});

		this.addCommand({
			id: "open-lobby",
			name: "Abrir All iₙ oNe",
			callback: () => void this.openLobby(),
		});

		if (!this.core.settings.get().onboardingCompleted) {
			// Espera o layout do Obsidian estabilizar antes de abrir o modal.
			this.app.workspace.onLayoutReady(() => {
				new OnboardingModal(this.app, this.core).open();
			});
		}
	}

	async onunload(): Promise<void> {
		this.vaultBridge?.stop();
		this.calendarRibbonUnsub?.();
		this.calendarRibbonUnsub = undefined;
		this.calendarRibbon?.remove();
		this.calendarRibbon = undefined;
		await this.core.disableAll();
	}

	private async openLobby(): Promise<void> {
		const mode = this.core.settings.get().lobby.openMode;

		if (mode === "modal") {
			new LobbyModal(this.app, this.core).open();
			return;
		}

		if (mode === "tab") {
			return this.openLobbyTab();
		}

		// "ask-each-time": pergunta a cada abertura, com opção de fixar a escolha.
		new OpenModeModal(this.app, async (choice, remember) => {
			try {
				if (remember) {
					const settings = this.core.settings.get();
					await this.core.settings.save({
						...settings,
						lobby: { ...settings.lobby, openMode: choice },
					});
				}
				if (choice === "modal") new LobbyModal(this.app, this.core).open();
				else await this.openLobbyTab();
			} catch (err) {
				// Mesma defesa dos outros botões que gravam no disco: o onClick
				// do Obsidian engole rejections — sem isto, falha de save/setViewState
				// morreria sem aviso e o usuário ficaria sem o Lobby aberto.
				console.error("[All iₙ oNe] Falha ao abrir o Lobby:", err);
				new Notice("Não foi possível abrir o All iₙ oNe. Veja o console.", 8000);
			}
		}).open();
	}

	private async openLobbyTab(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(LOBBY_VIEW_TYPE)[0];
		if (existing) {
			this.app.workspace.revealLeaf(existing);
			return;
		}
		const leaf: WorkspaceLeaf = this.app.workspace.getLeaf("tab");
		await leaf.setViewState({ type: LOBBY_VIEW_TYPE, active: true });
		this.app.workspace.revealLeaf(leaf);
	}
}

/** Perguntado a cada abertura quando `lobby.openMode === "ask-each-time"`. */
class OpenModeModal extends Modal {
	private remember = false;

	constructor(
		app: App,
		private onChoose: (choice: "tab" | "modal", remember: boolean) => void | Promise<void>
	) {
		super(app);
	}

	onOpen(): void {
		this.contentEl.createEl("h2", { text: "Como abrir o All iₙ oNe?" });

		new Setting(this.contentEl)
			.setName("Lembrar desta escolha")
			.setDesc("Não perguntar novamente — dá para mudar depois nas configurações do Lobby.")
			.addToggle((toggle) => toggle.setValue(false).onChange((v) => (this.remember = v)));

		new Setting(this.contentEl)
			.addButton((btn) =>
				btn
					.setButtonText("Abrir como aba")
					.setCta()
					.onClick(async () => {
						await this.onChoose("tab", this.remember);
						this.close();
					})
			)
			.addButton((btn) =>
				btn.setButtonText("Abrir como janela").onClick(async () => {
					await this.onChoose("modal", this.remember);
					this.close();
				})
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
