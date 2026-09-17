import type { App, TAbstractFile } from "obsidian";
import { TFile, TFolder } from "obsidian";
import type { EventBus } from "./EventBus";

/**
 * PONTE DE EVENTOS DO VAULT
 * --------------------------
 * Traduz os eventos nativos do Obsidian (criar/alterar/renomear/excluir
 * arquivo e pasta) para eventos do nosso barramento interno.
 *
 * Isto existe porque, até a v0.2.0, eventos como `file:created` estavam
 * declarados como gatilhos de notificação mas NENHUM módulo os emitia — ou
 * seja, ligar a notificação de "arquivo criado" não fazia nada. Centralizar
 * a emissão aqui (no núcleo, não num módulo) garante que esses eventos
 * existam independentemente de quais módulos estejam ligados, e que o
 * Histórico e as Notificações vejam a mesma verdade.
 */
export class VaultEventBridge {
	private detachers: (() => void)[] = [];

	/**
	 * @param isLifecycleHandlingNotes Quando retorna true, o módulo de Ciclo
	 * de Vida está ligado e é ele quem anuncia `file:created` para notas
	 * `.md` (depois de perguntar o nome). Enquanto isso, esta ponte cuida só
	 * de pastas e anexos, que não passam por aquele fluxo. Se retornar false
	 * (módulo desligado), a ponte assume o papel sozinha, sem nome definido.
	 */
	constructor(
		private app: App,
		private bus: EventBus,
		private isLifecycleHandlingNotes: () => boolean = () => false,
		/**
		 * Quando retorna true para um `oldPath`, esse rename é parte do
		 * processo INTERNO de "perguntar o nome" do Ciclo de Vida — não é uma
		 * ação que o usuário pediu conscientemente como "renomear". Sem isso,
		 * toda nota criada gerava DUAS entradas no Histórico para a mesma
		 * ação: "Arquivo criado: Teste.md" e "Arquivo movido/renomeado:
		 * Untitled.md → Teste.md", quando na cabeça do usuário foi uma coisa só.
		 */
		private isInternalNamingRename: (oldPath: string) => boolean = () => false
	) {}

	start(): void {
		// O Obsidian dispara "create" para todo arquivo existente durante a
		// indexação inicial. Só começamos a escutar depois que o layout está
		// pronto, senão o usuário levaria centenas de notificações ao abrir.
		this.app.workspace.onLayoutReady(() => {
			this.register("create", (file) =>
				this.emitFor(file, "file:created", "folder:created", "Criado")
			);
			this.register("delete", (file) =>
				this.emitFor(file, "file:deleted", "folder:deleted", "Excluído")
			);
			this.register("modify", (file) => {
				if (file instanceof TFile) {
					void this.bus.emit("file:modified", { path: file.path }, "core");
				}
			});
			this.registerRename();
		});
	}

	private register(
		event: "create" | "delete" | "modify",
		handler: (file: TAbstractFile) => void
	): void {
		// As sobrecargas de `vault.on` são por literal de evento; o switch
		// mantém cada chamada com o literal certo para o TypeScript.
		const ref =
			event === "create"
				? this.app.vault.on("create", handler)
				: event === "delete"
					? this.app.vault.on("delete", handler)
					: this.app.vault.on("modify", handler);
		this.detachers.push(() => this.app.vault.offref(ref));
	}

	private registerRename(): void {
		const ref = this.app.vault.on("rename", (file, oldPath) => {
			if (this.isInternalNamingRename(oldPath)) return;
			void this.bus.emit("file:renamed", { path: file.path, oldPath }, "core");
		});
		this.detachers.push(() => this.app.vault.offref(ref));
	}

	private emitFor(
		file: TAbstractFile,
		fileEvent: string,
		folderEvent: string,
		_label: string
	): void {
		if (file instanceof TFolder) {
			void this.bus.emit(folderEvent, { path: file.path }, "core");
			return;
		}

		// Para CRIAÇÃO de nota .md especificamente: se o Ciclo de Vida está
		// ligado, é ele quem emite `file:created` — só depois de perguntar o
		// nome. Emitir aqui também faria o Histórico registrar "Untitled"
		// antes da renomeação acontecer.
		const isMarkdownCreate = fileEvent === "file:created" && file.path.endsWith(".md");
		if (isMarkdownCreate && this.isLifecycleHandlingNotes()) return;

		void this.bus.emit(fileEvent, { path: file.path }, "core");
	}

	stop(): void {
		this.detachers.forEach((d) => d());
		this.detachers = [];
	}
}
