import { App, Menu, Modal, Notice, Setting, TFile, TFolder, normalizePath } from "obsidian";
import type { HubModule, ModuleContext, ModuleManifest } from "../../core/ModuleContract";
import { ensureVaultFolder, uniqueVaultPath } from "../../core/VaultPaths";

export interface FileLifecycleSettings {
	askNameOnCreate: boolean;
	confirmOnDelete: boolean;
	/** Ambos desligados por padrão — renomear/mover são ações já intencionais. */
	confirmOnRename: boolean;
	confirmOnMove: boolean;
}

export const FILE_LIFECYCLE_DEFAULTS: FileLifecycleSettings = {
	askNameOnCreate: true,
	confirmOnDelete: true,
	confirmOnRename: false,
	confirmOnMove: false,
};

/**
 * MÓDULO: CICLO DE VIDA DE ARQUIVOS
 * ----------------------------------
 * Intercepta a criação de notas para perguntar o nome ANTES de qualquer outro
 * módulo reagir. Isso resolve um problema em cadeia: o Obsidian cria a nota
 * como "Untitled" e só depois o usuário digita o nome, então o Histórico
 * registrava "Untitled", os Templates renomeavam tarde, e o vault enchia de
 * "Untitled 1", "Untitled 2"...
 *
 * Como o resto do plugin conversa com isto: em vez de escutar `file:created`
 * do vault, os outros módulos escutam `lifecycle:note-ready`, emitido só
 * depois que a nota tem nome definitivo.
 */
export class FileLifecycleModule implements HubModule {
	readonly manifest: ModuleManifest = {
		id: "filelifecycle",
		displayName: "Ciclo de vida de arquivos",
		description:
			"Pergunta o nome ao criar uma nota (evitando 'Untitled') e confirma exclusões, renomeações e movimentações.",
		icon: "file-pen",
		version: "0.1.0",
		contractVersion: "2.0.0",
		desktopOnly: false,
		emits: ["lifecycle:note-ready", "lifecycle:note-renamed"],
		listensTo: [],
		settingsSchema: [],
	};

	private context?: ModuleContext;
	private detachers: (() => void)[] = [];
	/** Notas aguardando nome — evita que o mesmo arquivo abra dois modais. */
	private awaiting = new Set<string>();

	/**
	 * Usado pelo VaultEventBridge para não duplicar entradas no Histórico: o
	 * rename que ACONTECE DENTRO do processo de perguntar o nome (Untitled →
	 * nome escolhido) não é uma ação "renomear" do ponto de vista do usuário
	 * — é a própria criação. Enquanto `originalPath` estiver neste Set, esse
	 * rename específico é interno.
	 */
	isInternalNamingRename(originalPath: string): boolean {
		return this.awaiting.has(originalPath);
	}

	onRegister(context: ModuleContext): void {
		this.context = context;
	}

	onEnable(): void {
		const app = this.context!.app;

		app.workspace.onLayoutReady(() => {
			const createRef = app.vault.on("create", (file) => {
				if (file instanceof TFile && file.extension === "md") {
					void this.handleCreate(file);
				}
			});
			this.detachers.push(() => app.vault.offref(createRef));
		});

		// Entradas extras no menu de clique-direito, e uma tentativa de
		// remover as nativas equivalentes (ver removeNativeMenuItems abaixo
		// para o porquê e os riscos disso).
		const fileMenuRef = app.workspace.on("file-menu", (menu, file) => {
			if (!(file instanceof TFile) || file.extension !== "md") return;

			removeNativeMenuItems(menu);

			menu.addItem((item) =>
				item
					.setTitle("Renomear")
					.setIcon("file-pen")
					.onClick(() => void this.promptRename(file))
			);
			menu.addItem((item) =>
				item
					.setTitle("Mover")
					.setIcon("folder-input")
					.onClick(() => void this.promptMove(file))
			);
			menu.addItem((item) =>
				item
					.setTitle("Excluir")
					.setIcon("trash-2")
					.onClick(() => void this.promptDelete(file))
			);
		});
		this.detachers.push(() => app.workspace.offref(fileMenuRef));

		// Renomear/mover/excluir NÃO viram comandos do Command Palette de
		// propósito — ficam só como itens de menu (acima) e botões dentro do
		// painel do módulo, para não competir com atalhos que o usuário já
		// tem configurados.
	}

	onDisable(): void {
		this.detachers.forEach((d) => d());
		this.detachers = [];
		this.awaiting.clear();
	}

	getHealthStatus() {
		const settings = this.readSettings();
		return {
			ok: true,
			summary: settings.askNameOnCreate ? "Perguntando nome ao criar" : "Sem perguntar nome",
		};
	}

	private readSettings(): FileLifecycleSettings {
		return { ...FILE_LIFECYCLE_DEFAULTS, ...this.context?.getSettings<FileLifecycleSettings>() };
	}

	/** Pergunta o nome logo na criação e só então libera o resto do plugin. */
	private async handleCreate(file: TFile): Promise<void> {
		const settings = this.readSettings();

		if (!settings.askNameOnCreate || !isUntitled(file.basename)) {
			await this.announceReady(file);
			return;
		}

		// BUG CORRIGIDO (crítico): `file` é um TFile mutável — o Obsidian
		// atualiza `.path` NO PRÓPRIO OBJETO quando o arquivo é renomeado. Ler
		// `file.path` de novo depois do rename (como na v0.4.0) já retornava o
		// caminho NOVO, então o `delete()` nunca removia o caminho ORIGINAL do
		// Set — "Untitled.md" ficava preso lá pra sempre. Como o Obsidian
		// reaproveita esse nome assim que fica livre, a segunda nota criada
		// caía direto no `return` de baixo, sem perguntar nada e sem avisar
		// ninguém (por isso também não notificava). A correção é guardar o
		// caminho original numa constante ANTES de qualquer rename.
		const originalPath = file.path;
		if (this.awaiting.has(originalPath)) return;
		this.awaiting.add(originalPath);

		try {
			const name = await this.askName(file.basename, "Nome da nova nota");
			let target = file;

			if (name && name !== file.basename) {
				const folder = originalPath.substring(0, originalPath.lastIndexOf("/"));
				const desired = normalizePath(`${folder ? folder + "/" : ""}${name}.md`);
				const finalPath = await uniqueVaultPath(this.context!.app, desired);
				await this.context!.fileWriteQueueRun(originalPath, () =>
					this.context!.app.fileManager.renameFile(file, finalPath)
				);
				const renamed = this.context!.app.vault.getAbstractFileByPath(finalPath);
				if (renamed instanceof TFile) target = renamed;
			}

			await this.announceReady(target);
		} finally {
			this.awaiting.delete(originalPath);
		}
	}

	/**
	 * Sinaliza que a nota tem nome definitivo. Os outros módulos (Templates,
	 * Histórico) usam este evento em vez do `file:created` cru.
	 */
	/**
	 * Sinaliza que a nota tem nome definitivo. Emite dois eventos: o interno
	 * `lifecycle:note-ready` (usado por Templates) e o `file:created` "oficial"
	 * — este módulo é quem manda essa notícia pro resto do plugin quando está
	 * ligado, com o nome JÁ definitivo (ver VaultEventBridge, que fica calado
	 * para notas em vez de emitir cedo demais com "Untitled").
	 */
	private async announceReady(file: TFile): Promise<void> {
		await this.context?.bus.emit("lifecycle:note-ready", { path: file.path }, "filelifecycle");
		await this.context?.bus.emit("file:created", { path: file.path }, "filelifecycle");
	}

	private askName(initial: string, title: string): Promise<string | null> {
		return new Promise((resolve) => {
			new NamePromptModal(this.context!.app, initial, title, resolve).open();
		});
	}

	async promptRename(file: TFile): Promise<void> {
		const name = await this.askName(file.basename, "Renomear nota");
		if (!name || name === file.basename) return;

		const doRename = async () => {
			const folder = file.path.substring(0, file.path.lastIndexOf("/"));
			const target = await uniqueVaultPath(this.context!.app, 
				normalizePath(`${folder ? folder + "/" : ""}${name}.md`)
			);
			const oldPath = file.path;
			await this.context!.app.fileManager.renameFile(file, target);
			await this.context?.bus.emit(
				"lifecycle:note-renamed",
				{ path: target, oldPath },
				"filelifecycle"
			);
			new Notice(`Renomeada para "${name}".`);
		};

		if (this.readSettings().confirmOnRename) {
			new ConfirmModal(
				this.context!.app,
				"Renomear nota",
				`Renomear "${file.basename}" para "${name}"?`,
				doRename
			).open();
		} else {
			await doRename();
		}
	}

	async promptDelete(file: TFile): Promise<void> {
		if (!this.readSettings().confirmOnDelete) {
			await this.context!.app.vault.trash(file, true);
			return;
		}
		new ConfirmModal(
			this.context!.app,
			"Excluir nota",
			`Mandar "${file.path}" para a lixeira? Dá para recuperar de lá depois.`,
			async () => {
				// Sempre lixeira, nunca exclusão direta — rede de segurança.
				await this.context!.app.vault.trash(file, true);
				new Notice("Nota movida para a lixeira.");
			}
		).open();
	}

	async promptMove(file: TFile): Promise<void> {
		const folders = this.listFolders();
		new MovePromptModal(this.context!.app, file, folders, async (targetFolder) => {
			const doMove = async () => {
				const desired = normalizePath(`${targetFolder}/${file.name}`);
				const finalPath = await uniqueVaultPath(this.context!.app, desired);
				await ensureVaultFolder(this.context!.app, targetFolder);
				const oldPath = file.path;
				await this.context!.app.fileManager.renameFile(file, finalPath);
				await this.context?.bus.emit(
					"lifecycle:note-renamed",
					{ path: finalPath, oldPath },
					"filelifecycle"
				);
				new Notice(`Movida para ${targetFolder}.`);
			};

			if (this.readSettings().confirmOnMove) {
				new ConfirmModal(
					this.context!.app,
					"Mover nota",
					`Mover "${file.path}" para "${targetFolder}"?`,
					doMove
				).open();
			} else {
				await doMove();
			}
		}).open();
	}

	private listFolders(): string[] {
		const folders: string[] = ["/"];
		for (const file of this.context!.app.vault.getAllLoadedFiles()) {
			if (file instanceof TFolder && file.path !== "/") folders.push(file.path);
		}
		return folders.sort();
	}


	renderSettingsPanel(container: HTMLElement): void {
		const settings = this.readSettings();

		new Setting(container)
			.setName("Perguntar o nome ao criar uma nota")
			.setDesc(
				"Ao criar uma nota nova, abre uma janela pedindo o nome antes de qualquer outra coisa. " +
					"Sem isso, a nota entra no vault e no histórico como 'Untitled'."
			)
			.addToggle((toggle) =>
				toggle.setValue(settings.askNameOnCreate).onChange(async (value) => {
					await this.context?.updateSettings({ askNameOnCreate: value });
				})
			);

		new Setting(container)
			.setName("Confirmar antes de excluir")
			.setDesc("Pede confirmação ao usar o botão de exclusão do plugin. Sempre vai para a lixeira.")
			.addToggle((toggle) =>
				toggle.setValue(settings.confirmOnDelete).onChange(async (value) => {
					await this.context?.updateSettings({ confirmOnDelete: value });
				})
			);

		new Setting(container)
			.setName("Confirmar antes de renomear")
			.setDesc("Desligado por padrão — o próprio ato de digitar o nome novo já é a confirmação.")
			.addToggle((toggle) =>
				toggle.setValue(settings.confirmOnRename).onChange(async (value) => {
					await this.context?.updateSettings({ confirmOnRename: value });
				})
			);

		new Setting(container)
			.setName("Confirmar antes de mover")
			.setDesc("Desligado por padrão — escolher a pasta de destino já é a confirmação.")
			.addToggle((toggle) =>
				toggle.setValue(settings.confirmOnMove).onChange(async (value) => {
					await this.context?.updateSettings({ confirmOnMove: value });
				})
			);

		container.createEl("h3", { text: "Ações na nota aberta" });
		container.createEl("p", {
			cls: "ione-hub-lobby__description",
			text: "Disponíveis só aqui no painel — não aparecem no Command Palette nem podem receber atalho.",
		});

		const active = this.context!.app.workspace.getActiveFile();
		new Setting(container)
			.setName(active ? `Nota aberta: ${active.path}` : "Nenhuma nota aberta")
			.addButton((btn) =>
				btn
					.setButtonText("Renomear")
					.setDisabled(!active)
					.onClick(() => active && void this.promptRename(active))
			)
			.addButton((btn) =>
				btn
					.setButtonText("Mover")
					.setDisabled(!active)
					.onClick(() => active && void this.promptMove(active))
			)
			.addButton((btn) =>
				btn
					.setButtonText("Excluir")
					.setDisabled(!active)
					.onClick(() => active && void this.promptDelete(active))
			);
	}
}

/** "Untitled", "Untitled 1", "Sem título" — nomes que o Obsidian gera sozinho. */
function isUntitled(basename: string): boolean {
	return /^(untitled|sem t[íi]tulo|nova nota)(\s+\d+)?$/i.test(basename.trim());
}

/** Remove caracteres que o sistema de arquivos não aceita em nomes. */
function sanitize(name: string): string {
	return name.trim().replace(/[\\/:*?"<>|]/g, "-");
}

export class NamePromptModal extends Modal {
	private value: string;
	private resolved = false;

	constructor(
		app: App,
		initial: string,
		private title: string,
		private resolve: (name: string | null) => void
	) {
		super(app);
		this.value = isUntitled(initial) ? "" : initial;
	}

	onOpen(): void {
		this.contentEl.createEl("h2", { text: this.title });

		const input = this.contentEl.createEl("input", { type: "text" });
		input.placeholder = "Digite o nome da nota";
		input.value = this.value;
		input.style.width = "100%";
		input.oninput = () => (this.value = input.value);
		input.onkeydown = (evt) => {
			if (evt.key === "Enter") {
				evt.preventDefault();
				this.finish(this.value);
			}
		};
		window.setTimeout(() => {
			input.focus();
			input.select();
		}, 30);

		new Setting(this.contentEl)
			.addButton((btn) =>
				btn
					.setButtonText("Confirmar")
					.setCta()
					.onClick(() => this.finish(this.value))
			)
			.addButton((btn) => btn.setButtonText("Deixar como está").onClick(() => this.finish(null)));
	}

	private finish(name: string | null): void {
		if (this.resolved) return;
		this.resolved = true;
		const clean = name ? sanitize(name) : "";
		this.resolve(clean || null);
		this.close();
	}

	onClose(): void {
		// Fechar pelo X ou Esc também precisa resolver a promessa, senão o
		// fluxo de criação da nota ficaria travado esperando para sempre.
		if (!this.resolved) {
			this.resolved = true;
			this.resolve(null);
		}
		this.contentEl.empty();
	}
}

class ConfirmModal extends Modal {
	constructor(
		app: App,
		private title: string,
		private message: string,
		private onConfirm: () => void | Promise<void>
	) {
		super(app);
	}

	onOpen(): void {
		this.contentEl.createEl("h2", { text: this.title });
		this.contentEl.createEl("p", { text: this.message });
		new Setting(this.contentEl)
			.addButton((btn) =>
				btn
					.setButtonText("Confirmar")
					.setWarning()
					.onClick(async () => {
						await this.onConfirm();
						this.close();
					})
			)
			.addButton((btn) => btn.setButtonText("Cancelar").onClick(() => this.close()));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

class MovePromptModal extends Modal {
	private target = "/";

	constructor(
		app: App,
		private file: TFile,
		private folders: string[],
		private onMove: (folder: string) => void | Promise<void>
	) {
		super(app);
	}

	onOpen(): void {
		this.contentEl.createEl("h2", { text: "Mover nota" });
		this.contentEl.createEl("p", { text: `Arquivo: ${this.file.path}` });

		new Setting(this.contentEl)
			.setName("Pasta de destino")
			.addDropdown((dd) => {
				for (const folder of this.folders) dd.addOption(folder, folder);
				dd.setValue(this.target);
				dd.onChange((v) => (this.target = v));
			});

		new Setting(this.contentEl)
			.setName("Ou digite um caminho novo")
			.setDesc("Se a pasta não existir, ela será criada.")
			.addText((text) => text.onChange((v) => (this.target = v.trim() || this.target)));

		new Setting(this.contentEl)
			.addButton((btn) =>
				btn
					.setButtonText("Mover")
					.setCta()
					.onClick(async () => {
						await this.onMove(this.target === "/" ? "" : this.target);
						this.close();
					})
			)
			.addButton((btn) => btn.setButtonText("Cancelar").onClick(() => this.close()));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/**
 * Remove os itens NATIVOS de "Rename"/"Delete"/"Move file to..." (e as
 * traduções em português) do menu de clique-direito, para que só sobrem os
 * itens deste plugin — que passam pela pergunta de confirmação.
 *
 * IMPORTANTE: isto usa `(menu as unknown as { items: unknown[] }).items`, um
 * campo INTERNO do `Menu` do Obsidian, não uma API pública/documentada. É a
 * mesma técnica que vários plugins da comunidade usam para isso — funciona
 * hoje, mas pode parar de funcionar num futuro update do Obsidian sem
 * aviso, já que nada garante que esse campo continue existindo com esse
 * nome. Por isso todo o bloco está em try/catch: se a estrutura mudar, o
 * pior que acontece é os itens nativos voltarem a aparecer (nada quebra).
 *
 * Isto NÃO é possível de outra forma: o Obsidian não oferece um gancho
 * público "antes de renomear/excluir, cancelável" para plugins — mesmo
 * assim, dá pra pelo menos tirar a opção nativa da frente e deixar só a
 * deste plugin no menu.
 */
function removeNativeMenuItems(menu: Menu): void {
	const NATIVE_LABELS = [
		"rename...",
		"rename",
		"renomear...",
		"renomear",
		"delete",
		"excluir",
		"move file to...",
		"move file to folder...",
		"mover arquivo para...",
		"mover para...",
	];

	try {
		const items = (menu as unknown as { items?: { title?: string; titleEl?: HTMLElement }[] }).items;
		if (!Array.isArray(items)) return;

		for (let i = items.length - 1; i >= 0; i--) {
			const label = (items[i]?.title ?? items[i]?.titleEl?.textContent ?? "").trim().toLowerCase();
			if (NATIVE_LABELS.includes(label)) items.splice(i, 1);
		}
	} catch {
		// Estrutura interna mudou — sem problema, os itens nativos só continuam aparecendo.
	}
}
