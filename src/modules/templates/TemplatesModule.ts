import { TFile, TFolder, normalizePath, Setting, Notice, Modal, App } from "obsidian";
import type { HubModule, ModuleContext, ModuleManifest } from "../../core/ModuleContract";
import { ensureVaultFolder, uniqueVaultPath } from "../../core/VaultPaths";
import {
	decidePendingAction,
	STATUS_PENDING_INITIAL,
	STATUS_COMPLETE_NORMALIZED,
} from "../../core/NoteStatus";
import {
	addSuggestion,
	removeSuggestion,
	validSuggestions,
	type PendingSuggestion,
} from "./PendingSuggestions";

export interface FolderTemplateRule {
	id: string;
	/** Pasta (ou pasta de categoria) à qual esta regra se aplica. */
	folderPath: string;
	templateContent: string;
	/** Regra "pai" para herança — o conteúdo do pai é aplicado antes do filho. */
	extendsRuleId?: string;
}

export interface TemplatesModuleSettings {
	rules: FolderTemplateRule[];
	ruleVersions: Record<string, { content: string; savedAt: number }[]>;
}

export const TEMPLATES_DEFAULTS: TemplatesModuleSettings = {
	rules: [],
	ruleVersions: {},
};

const MAX_RULE_HISTORY = 15;

/**
 * MÓDULO DE TEMPLATES POR PASTA
 * ------------------------------
 * Ao detectar a criação de uma nota dentro de uma pasta com regra
 * configurada, aplica o template (com suporte a herança via extendsRuleId),
 * preenche automaticamente os metadados deriváveis (`date`, `thema` — este
 * último a partir da hierarquia de pastas) e, se algum campo obrigatório
 * não puder ser preenchido, marca a nota como `status: incompleto` e a move
 * para a pasta "Pendente" um nível abaixo do root da categoria (criando essa
 * pasta se necessário; cai para "Pendente" na raiz se a categoria não puder
 * ser determinada).
 */
export class TemplatesModule implements HubModule {
	readonly manifest: ModuleManifest = {
		id: "templates",
		displayName: "Templates por pasta",
		description:
			"Aplica templates e metadados automáticos conforme a pasta onde a nota é criada; notas incompletas vão para Pendente.",
		icon: "file-stack",
		version: "0.1.0",
		contractVersion: "2.0.0",
		desktopOnly: false,
		emits: [
			"templates:note-pending",
			"templates:note-restored",
			"templates:similar-rule-suggested",
		],
		listensTo: ["lifecycle:note-ready"],
		settingsSchema: [],
	};

	private context?: ModuleContext;
	private detachCreate?: () => void;
	private detachModify?: () => void;
	/** Sugestões por similaridade aguardando decisão do usuário no painel. */
	private pendingSuggestions: PendingSuggestion[] = [];
	/** Caminhos em movimentação — evita reentrância nos handlers de modify. */
	private movingFiles = new Set<string>();

	onRegister(context: ModuleContext): void {
		this.context = context;
	}

	onEnable(): void {
		const context = this.context!;

		// Escuta o evento do módulo de Ciclo de Vida (nota já com nome definitivo)
		// em vez do "create" cru do vault — assim a regra nunca é aplicada a uma
		// nota ainda chamada "Untitled".
		const unsubReady = context.bus.on("lifecycle:note-ready", "templates", (event) => {
			const path = (event.payload as { path?: string }).path;
			if (!path) return;
			const file = context.app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile && file.extension === "md") {
				void this.handleNoteCreated(file);
			}
		});

		// Reserva: se o módulo de Ciclo de Vida não estiver ATIVO de verdade
		// (runtime, não config — um módulo listado na config pode ter falhado
		// ao habilitar), ninguém emite "lifecycle:note-ready" — então o create
		// cru do vault assume. Antes lia a config persistida e DIVERGIA do
		// VaultEventBridge (que usa runtime): com o Ciclo de Vida na config mas
		// falhado, a ponte emitia file:created, o fallback calava e o template
		// nunca era aplicado — sem erro em lugar nenhum.
		const createRef = context.app.vault.on("create", (file) => {
			if (!(file instanceof TFile) || file.extension !== "md") return;
			if (context.isModuleEnabled("filelifecycle")) return;
			void this.handleNoteCreated(file);
		});

		this.detachCreate = () => {
			unsubReady();
			context.app.vault.offref(createRef);
		};

		// BUG CORRIGIDO: escutar `vault.on("modify")` e ler o frontmatter logo
		// em seguida é uma corrida — o `metadataCache` reprocessa o arquivo de
		// forma assíncrona/debatida, então nesse momento o cache podia ainda
		// estar com o frontmatter ANTIGO (por isso "remover a tag pendente não
		// fazia nada": o código lia o status de antes da edição). O evento
		// `metadataCache.on("changed", ...)` só dispara depois que o cache já
		// foi reprocessado — é a garantia certa de "frontmatter atualizado".
		const modifyRef = context.app.metadataCache.on("changed", (file) => {
			if (file instanceof TFile && file.extension === "md") {
				void this.handleNoteModified(file);
			}
		});
		this.detachModify = () => context.app.metadataCache.offref(modifyRef);
	}

	renderSettingsPanel(container: HTMLElement): void {
		const settings = this.readSettings();

		container.createEl("h3", { text: "Regras existentes" });
		if (settings.rules.length === 0) {
			container.createEl("p", {
				text: "Nenhuma regra configurada ainda.",
				cls: "ione-hub-lobby__description",
			});
		}
		for (const rule of settings.rules) {
			new Setting(container)
				.setName(rule.folderPath)
				.setDesc(this.describeRule(rule, settings.rules))
				.addButton((btn) =>
					btn.setButtonText("Editar").onClick(() => {
						this.renderRuleForm(container, rule);
					})
				)
				.addButton((btn) =>
					btn.setButtonText("Remover").onClick(async () => {
						await this.context?.updateSettings({
							rules: settings.rules.filter((r) => r.id !== rule.id),
						});
						this.refreshPanel(container);
					})
				);
		}

		new Setting(container).addButton((btn) =>
			btn
				.setButtonText("Nova regra")
				.setCta()
				.onClick(() => this.renderRuleForm(container, null))
		);

		// Sugestões por similaridade pendentes de decisão do usuário.
		// Filtradas na hora de renderizar: nota movida/apagada ou regra removida
		// não geram linhas que vão falhar ao serem aplicadas.
		const liveSuggestions = validSuggestions(this.pendingSuggestions, {
			pathExists: (path) => this.context!.app.vault.getAbstractFileByPath(path) instanceof TFile,
			ruleExists: (ruleId) => settings.rules.some((r) => r.id === ruleId),
		});
		if (liveSuggestions.length !== this.pendingSuggestions.length) {
			this.pendingSuggestions = liveSuggestions;
		}
		if (liveSuggestions.length > 0) {
			container.createEl("h3", { text: "Sugestões de template" });
			for (const suggestion of liveSuggestions) {
				const rule = settings.rules.find((r) => r.id === suggestion.suggestedRuleId);
				new Setting(container)
					.setName(suggestion.path)
					.setDesc(`Parece encaixar na regra de "${rule?.folderPath ?? "?"}". Aplicar?`)
					.addButton((btn) =>
						btn.setButtonText("Aplicar").onClick(async () => {
							await this.applySuggestion(suggestion);
							this.refreshPanel(container);
						})
					)
				.addButton((btn) =>
					btn.setButtonText("Dispensar").onClick(() => {
						this.pendingSuggestions = removeSuggestion(this.pendingSuggestions, suggestion.path);
						this.refreshPanel(container);
					})
				);
			}
		}
	}

	/** Formulário de criação/edição de regra. `rule = null` significa nova regra. */
	private renderRuleForm(container: HTMLElement, rule: FolderTemplateRule | null): void {
		const settings = this.readSettings();
		container.empty();

		container.createEl("h3", { text: rule ? `Editando: ${rule.folderPath}` : "Nova regra" });

		const draft: FolderTemplateRule = rule
			? { ...rule }
			: {
					id: `rule-${Date.now()}`,
					folderPath: "",
					templateContent: "",
			  };

		// Seleção de pasta existente OU caminho novo digitado à mão (que é criado
		// ao salvar, inclusive com as pastas-pai que faltarem).
		const folders = this.listFolders();
		new Setting(container)
			.setName("Pasta existente")
			.setDesc("Escolha uma pasta do vault, ou deixe em branco e digite um caminho novo abaixo.")
			.addDropdown((dd) => {
				dd.addOption("", "(digitar caminho novo)");
				for (const folder of folders) dd.addOption(folder, folder);
				dd.setValue(folders.includes(draft.folderPath) ? draft.folderPath : "");
				dd.onChange((v) => {
					if (!v) return;
					draft.folderPath = v;
					pathInput.setValue(v);
				});
			});

		let pathInput!: import("obsidian").TextComponent;
		new Setting(container)
			.setName("Caminho da pasta")
			.setDesc("Ex.: Estudos/Matemática. Se não existir, será criada ao salvar.")
			.addText((text) => {
				pathInput = text;
				text.setValue(draft.folderPath).onChange((v) => (draft.folderPath = v));
			});

		container.createEl("p", {
			cls: "ione-hub-lobby__description",
			text:
				"Toda nota criada nesta pasta recebe o template abaixo, ganha os metadados " +
				"date, thema e origem automaticamente, e nasce com status: incompleto na pasta " +
				"Pendente da categoria. Quando você apagar o campo status (ou escrever Completo), " +
				"a nota volta sozinha para a pasta de origem.",
		});

		// Seletor de regra "pai" (herança de template).
		new Setting(container)
			.setName("Herdar de (regra pai)")
			.setDesc("O conteúdo do template pai é inserido antes deste.")
			.addDropdown((dd) => {
				dd.addOption("", "(nenhuma)");
				for (const other of settings.rules) {
					if (other.id === draft.id) continue; // não pode herdar de si mesma
					dd.addOption(other.id, other.folderPath);
				}
				dd.setValue(draft.extendsRuleId ?? "");
				dd.onChange((v) => (draft.extendsRuleId = v || undefined));
			});

		container.createEl("p", { text: "Conteúdo do template:" });
		const templateArea = container.createEl("textarea", { attr: { rows: "8" } });
		templateArea.style.width = "100%";
		templateArea.style.fontFamily = "var(--font-monospace)";
		templateArea.value = draft.templateContent;
		templateArea.oninput = () => (draft.templateContent = templateArea.value);

		new Setting(container)
			.addButton((btn) =>
				btn
					.setButtonText("Salvar regra")
					.setCta()
					.onClick(async () => {
						if (!draft.folderPath.trim()) {
							new Notice("Informe a pasta para a regra.");
							return;
						}
						if (this.wouldCreateInheritanceLoop(draft, settings.rules)) {
							new Notice("Essa herança criaria um ciclo entre regras. Escolha outra regra pai.");
							return;
						}
						draft.folderPath = draft.folderPath.trim().replace(/^\/+|\/+$/g, "");
						await ensureVaultFolder(this.context!.app, draft.folderPath);
						await this.saveRule(draft);
						new Notice(`Regra salva. Pasta "${draft.folderPath}" pronta para uso.`);
						this.refreshPanel(container);
					})
			)
			.addButton((btn) => btn.setButtonText("Cancelar").onClick(() => this.refreshPanel(container)));
	}

	private refreshPanel(container: HTMLElement): void {
		container.empty();
		this.renderSettingsPanel(container);
	}

	private describeRule(rule: FolderTemplateRule, all: FolderTemplateRule[]): string {
		const parts: string[] = [];
		if (rule.extendsRuleId) {
			const parent = all.find((r) => r.id === rule.extendsRuleId);
			if (parent) parts.push(`herda de "${parent.folderPath}"`);
		}
		return parts.join(" · ") || "Aplica template e metadados automáticos";
	}

	/** Evita herança circular (A herda de B que herda de A) — trava o build do template. */
	private wouldCreateInheritanceLoop(
		draft: FolderTemplateRule,
		rules: FolderTemplateRule[]
	): boolean {
		const seen = new Set<string>();
		let currentId = draft.extendsRuleId;
		while (currentId) {
			if (currentId === draft.id || seen.has(currentId)) return true;
			seen.add(currentId);
			currentId = rules.find((r) => r.id === currentId)?.extendsRuleId;
		}
		return false;
	}

	private async applySuggestion(suggestion: { path: string; suggestedRuleId: string }): Promise<void> {
		const file = this.context!.app.vault.getAbstractFileByPath(suggestion.path);
		if (!(file instanceof TFile)) return;
		const rule = this.readSettings().rules.find((r) => r.id === suggestion.suggestedRuleId);
		if (!rule) return;
		await this.applyRuleToNote(file, rule);
		this.pendingSuggestions = removeSuggestion(this.pendingSuggestions, suggestion.path);
	}

	onDisable(): void {
		this.detachCreate?.();
		this.detachModify?.();
		// Fila de sugestões é estado vivo do listener: desligado o módulo, não
		// há criação nova e a fila não sobrevive ao enable seguinte (as sugestões
		// são recriadas na hora, se ainda fizerem sentido).
		this.pendingSuggestions = [];
	}

	private readSettings(): TemplatesModuleSettings {
		return { ...TEMPLATES_DEFAULTS, ...this.context?.getSettings<TemplatesModuleSettings>() };
	}

	private findRuleForPath(path: string): FolderTemplateRule | undefined {
		const settings = this.readSettings();
		const folder = path.substring(0, path.lastIndexOf("/"));
		// Regra mais específica primeiro (caminho mais longo que ainda é prefixo).
		return settings.rules
			.filter((r) => folder === r.folderPath || folder.startsWith(r.folderPath + "/"))
			.sort((a, b) => b.folderPath.length - a.folderPath.length)[0];
	}

	/** Sugestão por similaridade quando não há regra exata (não aplica sozinha, só sugere via evento). */
	private findSimilarRule(path: string): FolderTemplateRule | undefined {
		const settings = this.readSettings();
		const folderName = path.split("/").slice(-2, -1)[0]?.toLowerCase();
		if (!folderName) return undefined;
		return settings.rules.find((r) => r.folderPath.toLowerCase().includes(folderName));
	}

	private async handleNoteCreated(file: TFile): Promise<void> {
		const rule = this.findRuleForPath(file.path);
		if (!rule) {
			const similar = this.findSimilarRule(file.path);
			if (similar) {
				// Guarda para o painel oferecer ao usuário — nunca aplica sozinha.
				// addSuggestion: dedupe por path + teto (MAX_PENDING_SUGGESTIONS);
				// só emite quando a fila de fato mudou.
				const { list, added } = addSuggestion(this.pendingSuggestions, {
					path: file.path,
					suggestedRuleId: similar.id,
				});
				this.pendingSuggestions = list;
				if (added) {
					this.context?.bus.emit(
						"templates:similar-rule-suggested",
						{ path: file.path, suggestedRuleId: similar.id },
						"templates"
					);
				}
			}
			return;
		}

		await this.applyRuleToNote(file, rule);
	}

	/**
	 * Aplica uma regra a uma nota: insere o template, grava os metadados
	 * automáticos e manda para a pasta Pendente.
	 *
	 * ORDEM IMPORTA: o conteúdo do template é inserido PRIMEIRO e o frontmatter
	 * só depois. Fazer o contrário (como na v0.3.0) colocava o texto do template
	 * acima do bloco `---`, o que quebra o frontmatter — o Obsidian passa a
	 * tratar tudo como texto comum e os metadados somem.
	 */
	async applyRuleToNote(file: TFile, rule: FolderTemplateRule): Promise<void> {
		const templateBody = this.buildTemplateContent(rule);

		// Conteúdo e frontmatter pertencem à mesma operação serializada. Isso evita
		// que outra escrita/rename observe a nota entre as duas fases.
		await this.context!.fileWriteQueueRun(file.path, async () => {
			if (templateBody.trim()) {
				const existing = await this.context!.app.vault.read(file);
				const body = stripFrontmatter(existing).trim();
				const merged = body ? `${templateBody}\n\n${body}` : templateBody;
				await this.context!.app.vault.modify(file, merged);
			}

			await this.context!.app.fileManager.processFrontMatter(file, (fm) => {
				fm.date = fm.date ?? new Date().toISOString().slice(0, 10);
				fm.thema = this.deriveThemaFromPath(file.path);
				fm.status = STATUS_PENDING_INITIAL;
				fm.concluido = false;
				fm.origem = file.path;
			});
		});
		await this.movePendingToCategoryFolder(file);
		this.context?.bus.emit("templates:note-pending", { path: file.path }, "templates");
		this.context?.log("Nota criada e marcada como Pendente", { path: file.path });
	}

	/**
	 * Devolve a nota ao lugar de origem quando ela deixa de estar pendente.
	 *
	 * Regras (conforme definido no design):
	 *   - `status` removido  → vira `completo` e a nota volta para `origem`.
	 *   - `status: completo` → volta para `origem`.
	 *   - `status: pendente` → não faz nada.
	 *
	 * O `movingFiles` evita reentrância: mover a nota dispara outro evento de
	 * modify, que entraria aqui de novo no meio da operação anterior.
	 */
	private async handleNoteModified(file: TFile): Promise<void> {
		if (this.movingFiles.has(file.path)) return;

		const cache = this.context!.app.metadataCache.getFileCache(file);
		const fm = cache?.frontmatter;
		if (!fm) return;

		const origem = typeof fm.origem === "string" ? fm.origem : undefined;
		if (!origem) return;

		if (fm.concluido === false) {
			const status = Array.isArray(fm.status) ? fm.status : [fm.status];
			const alreadyIncomplete = status.length === 1 && String(status[0]).trim().toLowerCase() === "incompleto";
			if (!alreadyIncomplete) {
				await this.context!.app.fileManager.processFrontMatter(file, (frontmatter) => {
					frontmatter.status = STATUS_PENDING_INITIAL;
				});
			}
			return;
		}

		// A conclusão é a fonte de verdade: quando concluido é true, a nota deve
		// ser normalizada para completo e devolvida à origem.
		const effectiveStatus = fm.concluido === true ? STATUS_COMPLETE_NORMALIZED : fm.status;
		const action = decidePendingAction(effectiveStatus, origem, file.path);
		if (!action.rewriteStatus && !action.move) return; // nada a fazer

		// Captura o caminho ANTES de qualquer operação que o mude — o TFile é
		// mutado in-place pelo Obsidian no rename (mesma armadilha da v0.4.0,
		// ver tests/AwaitingPathBug.test.ts). Usar file.path depois do rename
			// faria o finally abaixo apagar a chave ERRADA e vazar a marca de
			// reentrância — travando qualquer operação futura com a nota.
		const pathBefore = file.path;
		this.movingFiles.add(pathBefore);
		try {
			if (action.rewriteStatus) {
				await this.context!.app.fileManager.processFrontMatter(file, (frontmatter) => {
					frontmatter.status = STATUS_COMPLETE_NORMALIZED;
					frontmatter.concluido = true;
				});
			}

			if (action.move) {
				const targetFolder = origem.substring(0, origem.lastIndexOf("/"));
				await ensureVaultFolder(this.context!.app, targetFolder);

				const finalPath = await uniqueVaultPath(this.context!.app, origem);
				await this.context!.fileWriteQueueRun(file.path, () =>
					this.context!.app.fileManager.renameFile(file, finalPath)
				);

				await this.context!.app.fileManager.processFrontMatter(file, (frontmatter) => {
					delete frontmatter.origem;
				});

				this.context?.bus.emit("templates:note-restored", { path: finalPath }, "templates");
				new Notice(`Nota completada e devolvida para ${finalPath}`);
			}
		} finally {
			this.movingFiles.delete(pathBefore);
		}
	}

	private buildTemplateContent(rule: FolderTemplateRule): string {
		const settings = this.readSettings();
		let content = "";
		if (rule.extendsRuleId) {
			const parent = settings.rules.find((r) => r.id === rule.extendsRuleId);
			if (parent) content += this.buildTemplateContent(parent) + "\n";
		}
		content += rule.templateContent;
		return content;
	}

	/** Deriva o metadado "thema" a partir da hierarquia de pastas até a nota. */
	private deriveThemaFromPath(path: string): string[] {
		const parts = path.split("/");
		parts.pop(); // remove o nome do arquivo
		return parts;
	}

	/** Move a nota para CategoriaX/Pendente/, criando a pasta se necessário; cai para Pendente na raiz se não achar categoria. */
	private async movePendingToCategoryFolder(file: TFile): Promise<void> {
		const parts = file.path.split("/");
		const category = parts.length > 1 ? parts[0] : undefined;
		const pendingFolder = category ? `${category}/Pendente` : "Pendente";

		await ensureVaultFolder(this.context!.app, pendingFolder);
		const newPath = await uniqueVaultPath(this.context!.app, normalizePath(`${pendingFolder}/${file.name}`));

		// Mesma regra do handleNoteModified: capturar o caminho ANTES do rename,
		// porque o TFile.path muda in-place no meio desta operação.
		const pathBefore = file.path;
		this.movingFiles.add(pathBefore);
		try {
			await this.context!.fileWriteQueueRun(pathBefore, () =>
				this.context!.app.fileManager.renameFile(file, newPath)
			);
		} finally {
			this.movingFiles.delete(pathBefore);
		}
	}

	/** Lista todas as pastas do vault, para o seletor do formulário de regra. */
	listFolders(): string[] {
		const folders: string[] = [];
		for (const file of this.context!.app.vault.getAllLoadedFiles()) {
			if (file instanceof TFolder && file.path !== "/") folders.push(file.path);
		}
		return folders.sort();
	}

	async saveRule(rule: FolderTemplateRule): Promise<void> {
		const settings = this.readSettings();
		const existingIndex = settings.rules.findIndex((r) => r.id === rule.id);
		const versions = settings.ruleVersions[rule.id] ?? [];

		if (existingIndex >= 0) {
			versions.unshift({ content: settings.rules[existingIndex].templateContent, savedAt: Date.now() });
		}

		const nextRules = [...settings.rules];
		if (existingIndex >= 0) nextRules[existingIndex] = rule;
		else nextRules.push(rule);

		await this.context?.updateSettings({
			rules: nextRules,
			ruleVersions: {
				...settings.ruleVersions,
				[rule.id]: versions.slice(0, MAX_RULE_HISTORY),
			},
		});
	}
}

function stripFrontmatter(content: string): string {
	if (!content.startsWith("---")) return content;
	const end = content.indexOf("\n---", 3);
	if (end === -1) return content;
	return content.slice(end + 4);
}

