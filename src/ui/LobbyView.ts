import { ItemView, WorkspaceLeaf, Modal, App } from "obsidian";
import type { HubCore } from "../core/HubCore";
import { LobbyRenderer } from "./LobbyRenderer";

export const LOBBY_VIEW_TYPE = "ione-hub-lobby-view";

/**
 * Lobby como ABA do workspace. Casca fina: toda a UI está em LobbyRenderer,
 * compartilhada com o LobbyModal (janela).
 */
export class LobbyView extends ItemView {
	private renderer?: LobbyRenderer;

	constructor(leaf: WorkspaceLeaf, private core: HubCore) {
		super(leaf);
	}

	getViewType(): string {
		return LOBBY_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "ioNe Hub";
	}

	getIcon(): string {
		return "layout-dashboard";
	}

	async onOpen(): Promise<void> {
		this.renderer = new LobbyRenderer(this.app, this.core, this.contentEl);
		this.renderer.render();
	}

	async onClose(): Promise<void> {
		this.renderer?.destroy();
		this.contentEl.empty();
	}
}

/** Lobby como JANELA (modal). Mesma UI da aba, sem duplicar lógica. */
export class LobbyModal extends Modal {
	private renderer?: LobbyRenderer;

	constructor(app: App, private core: HubCore) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("ione-hub-lobby-modal");
		this.renderer = new LobbyRenderer(this.app, this.core, this.contentEl);
		this.renderer.render();
	}

	onClose(): void {
		this.renderer?.destroy();
		this.renderer = undefined;
		this.contentEl.empty();
	}
}
