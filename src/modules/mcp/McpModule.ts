import type { TFile, TFolder } from "obsidian";
import { TFile as TFileClass, normalizePath, Setting, Notice } from "obsidian";
import type {
	ConfigValidationIssue,
	HubModule,
	ModuleContext,
	ModuleManifest,
} from "../../core/ModuleContract";
import type { HubSettings } from "../../core/types";
import { obfuscate, deobfuscate } from "../../core/secureStore";
import { createMcpServer, McpServerHandle } from "./server";
import { pathMatchesFolder as pathMatches, collectWriteTargets } from "./WriteRules";
import { cryptoRandomId } from "../../core/types";

export interface McpModuleSettings {
	enabled: boolean;
	port: number;
	/** Token ofuscado — nunca guardado em texto puro (ver secureStore.ts). */
	tokenObfuscated: string;
	readOnly: boolean;
	/** Pastas onde escrita é permitida mesmo com readOnly=false global. Vazio = tudo liberado. */
	writeAllowlist: string[];
	writeBlocklist: string[];
	rateLimitPerMinute: number;
	dryRunDefault: boolean;
	toolsApiVersion: string;
}

export const MCP_DEFAULTS: McpModuleSettings = {
	enabled: true,
	// 27123 é a porta padrão do plugin "Local REST API" (muito comum no
	// Obsidian) — usar o mesmo valor aqui causaria EADDRINUSE sempre que
	// esse outro plugin estiver instalado. 27931 é um valor bem menos
	// provável de colidir; ainda assim, totalmente reconfigurável abaixo.
	port: 27931,
	tokenObfuscated: "",
	readOnly: false,
	writeAllowlist: [],
	writeBlocklist: [],
	rateLimitPerMinute: 120,
	dryRunDefault: false,
	toolsApiVersion: "1.0.0",
};

/**
 * MÓDULO MCP
 * ----------
 * Servidor MCP embutido no plugin, vivo apenas enquanto o Obsidian está
 * aberto (ver decisão de arquitetura: o modo "Obsidian fechado" fica de fora
 * deste plugin, é responsabilidade do projeto de gateway MCP separado do
 * usuário). Transporte: Streamable HTTP (não o HTTP+SSE legado).
 *
 * Este arquivo cobre a estrutura do módulo e as ferramentas de leitura/
 * escrita de notas mais usadas. As demais ferramentas descritas na fase de
 * planejamento (backlinks, Dataview, anexos, split/combine) seguem o mesmo
 * padrão de `registerTool` e podem ser adicionadas incrementalmente sem
 * tocar no núcleo — é exatamente o que o contrato de módulo foi desenhado
 * para permitir.
 */
export class McpModule implements HubModule {
	readonly manifest: ModuleManifest = {
		id: "mcp",
		displayName: "Servidor MCP",
		description:
			"Expõe o vault para clientes MCP (Claude Desktop, Cursor, etc.) enquanto o Obsidian estiver aberto.",
		icon: "server",
		version: "0.1.0",
		contractVersion: "2.0.0",
		desktopOnly: true,
		emits: ["mcp:action", "mcp:server-started", "mcp:server-stopped"],
		listensTo: [],
		settingsSchema: [
			{ key: "port", label: "Porta", type: "number", default: MCP_DEFAULTS.port },
			{ key: "readOnly", label: "Somente leitura (global)", type: "boolean", default: MCP_DEFAULTS.readOnly },
			{
				key: "rateLimitPerMinute",
				label: "Limite de ações por minuto",
				type: "number",
				default: MCP_DEFAULTS.rateLimitPerMinute,
			},
			{
				key: "dryRunDefault",
				label: "Modo dry-run por padrão",
				type: "boolean",
				default: MCP_DEFAULTS.dryRunDefault,
			},
		],
	};

	private context?: ModuleContext;
	private server?: McpServerHandle;
	private actionTimestamps: number[] = [];
	private lastServerError?: string;
	/** Escopo temporário: libera escrita até este timestamp, mesmo com readOnly ligado. */
	private temporaryWriteUntil = 0;

	onRegister(context: ModuleContext): void {
		this.context = context;
	}

	async onEnable(): Promise<void> {
		const context = this.context!;
		const settings = this.readSettings();

		if (!settings.tokenObfuscated) {
			const token = cryptoRandomId() + cryptoRandomId();
			await context.updateSettings({ tokenObfuscated: obfuscate(token) });
		}

		try {
			this.server = await createMcpServer({
				port: settings.port,
				getToken: () => deobfuscate(this.readSettings().tokenObfuscated),
				handleToolCall: (toolName, args) => this.handleToolCall(toolName, args),
			});
		} catch (err) {
			this.lastServerError = this.describeServerError(err, settings.port);
			throw new Error(this.lastServerError);
		}

		this.lastServerError = undefined;
		await context.bus.emit("mcp:server-started", { port: settings.port }, "mcp");

		context.registerCommand("mcp-restart-server", "MCP: Reiniciar servidor", () => {
			void this.restart();
		});
	}

	private describeServerError(err: unknown, port: number): string {
		const code = (err as NodeJS.ErrnoException)?.code;
		if (code === "EADDRINUSE") {
			return `A porta ${port} já está em uso por outro programa (talvez o plugin "Local REST API" ou outra instância do Obsidian aberta com este vault). Mude a porta abaixo e tente novamente.`;
		}
		if (code === "EACCES") {
			return `Sem permissão para abrir a porta ${port}. Tente uma porta acima de 1024.`;
		}
		return err instanceof Error ? err.message : String(err);
	}

	async onDisable(): Promise<void> {
		await this.server?.stop();
		this.server = undefined;
		await this.context?.bus.emit("mcp:server-stopped", {}, "mcp");
	}

	validateSettings(settings: HubSettings): ConfigValidationIssue[] {
		const mcp = (settings.modules.mcp ?? {}) as Partial<McpModuleSettings>;
		const issues: ConfigValidationIssue[] = [];
		if (mcp.port && (mcp.port < 1024 || mcp.port > 65535)) {
			issues.push({ field: "port", level: "error", message: "A porta deve estar entre 1024 e 65535." });
		}
		return issues;
	}

	getHealthStatus() {
		const running = !!this.server;
		if (!running && this.lastServerError) {
			return { ok: false, summary: this.lastServerError };
		}
		return {
			ok: running,
			summary: running ? `Rodando na porta ${this.readSettings().port}` : "Parado",
		};
	}

	renderSettingsPanel(container: HTMLElement): void {
		const settings = this.readSettings();
		const running = !!this.server;

		if (this.lastServerError) {
			container.createEl("p", { text: `⚠️ ${this.lastServerError}`, cls: "ione-hub-lobby__warning" });
		}

		// Rascunho local: nada é salvo até clicar em "Aplicar mudanças". Antes,
		// cada tecla digitada salvava direto — o que fazia um campo de porta
		// meio digitado ("8") virar configuração válida, e um campo vazio
		// virar 0 sem nenhum aviso.
		const draft = {
			port: settings.port,
			readOnly: settings.readOnly,
			dryRunDefault: settings.dryRunDefault,
			rateLimitPerMinute: settings.rateLimitPerMinute,
			writeAllowlist: settings.writeAllowlist.join("\n"),
			writeBlocklist: settings.writeBlocklist.join("\n"),
		};

		new Setting(container)
			.setName("Porta")
			.setDesc("Entre 1024 e 65535. Precisa estar livre — evite a porta de outros plugins.")
			.addText((text) =>
				text.setValue(String(settings.port)).onChange((v) => (draft.port = Number(v)))
			);

		new Setting(container)
			.setName("Somente leitura (global)")
			.setDesc("Bloqueia toda ferramenta de escrita, independentemente das listas abaixo.")
			.addToggle((toggle) => toggle.setValue(settings.readOnly).onChange((v) => (draft.readOnly = v)));

		new Setting(container)
			.setName("Modo dry-run por padrão")
			.setDesc("Ferramentas de escrita apenas simulam o resultado, sem aplicar de verdade.")
			.addToggle((toggle) =>
				toggle.setValue(settings.dryRunDefault).onChange((v) => (draft.dryRunDefault = v))
			);

		new Setting(container)
			.setName("Limite de ações por minuto")
			.addText((text) =>
				text
					.setValue(String(settings.rateLimitPerMinute))
					.onChange((v) => (draft.rateLimitPerMinute = Number(v)))
			);

		new Setting(container)
			.setName("Pastas onde a escrita é permitida")
			.setDesc("Uma por linha. Vazio = todas liberadas (respeitando a lista de bloqueio).")
			.addTextArea((area) =>
				area.setValue(draft.writeAllowlist).onChange((v) => (draft.writeAllowlist = v))
			);

		new Setting(container)
			.setName("Pastas bloqueadas para escrita")
			.setDesc("Uma por linha. Tem prioridade sobre a lista de permissão.")
			.addTextArea((area) =>
				area.setValue(draft.writeBlocklist).onChange((v) => (draft.writeBlocklist = v))
			);

		new Setting(container).addButton((btn) =>
			btn
				.setButtonText("Aplicar mudanças")
				.setCta()
				.onClick(async () => {
					const errors = validateMcpDraft(draft);
					if (errors.length > 0) {
						new Notice(errors.join("\n"), 8000);
						return;
					}

					const portChanged = draft.port !== settings.port;
					await this.context?.updateSettings({
						port: draft.port,
						readOnly: draft.readOnly,
						dryRunDefault: draft.dryRunDefault,
						rateLimitPerMinute: draft.rateLimitPerMinute,
						writeAllowlist: splitLines(draft.writeAllowlist),
						writeBlocklist: splitLines(draft.writeBlocklist),
					});

					if (portChanged && this.server) {
						try {
							await this.restart();
							new Notice(`Configurações salvas. Servidor reiniciado na porta ${draft.port}.`);
						} catch (err) {
							new Notice(`Configurações salvas, mas o servidor falhou: ${describe(err)}`, 8000);
						}
					} else {
						new Notice("Configurações salvas.");
					}
					this.refreshPanel(container);
				})
		);

		// ---- Token ----
		container.createEl("h3", { text: "Autenticação" });
		const token = deobfuscate(settings.tokenObfuscated);
		new Setting(container)
			.setName("Token")
			.setDesc("Os clientes MCP precisam enviar este token. Regenerar invalida o anterior.")
			.addButton((btn) =>
				btn.setButtonText("Copiar token").onClick(async () => {
					await navigator.clipboard.writeText(token);
					new Notice("Token copiado.");
				})
			)
			.addButton((btn) =>
				btn.setButtonText("Regenerar").onClick(async () => {
					const fresh = cryptoRandomId() + cryptoRandomId();
					await this.context?.updateSettings({ tokenObfuscated: obfuscate(fresh) });
					new Notice("Token regenerado. Atualize seus clientes MCP.");
					this.refreshPanel(container);
				})
			);

		// Comando pronto para testar o servidor, já com a porta e token reais.
		container.createEl("h3", { text: "Testar o servidor" });
		const cmd = container.createEl("pre", { cls: "ione-hub-code" });
		cmd.setText(buildTestCommand(settings.port, token));
		new Setting(container).addButton((btn) =>
			btn.setButtonText("Copiar comando de teste").onClick(async () => {
				await navigator.clipboard.writeText(buildTestCommand(settings.port, token));
				new Notice("Comando copiado. Cole no PowerShell.");
			})
		);

		// ---- Liberação temporária ----
		const grantActive = Date.now() < this.temporaryWriteUntil;
		new Setting(container)
			.setName("Liberar escrita temporariamente")
			.setDesc(
				grantActive
					? `Liberada até ${new Date(this.temporaryWriteUntil).toLocaleTimeString("pt-BR")}.`
					: "Permite escrita por tempo curto mesmo com o modo somente-leitura ligado."
			)
			.addButton((btn) =>
				btn.setButtonText("15 minutos").onClick(() => {
					this.temporaryWriteUntil = Date.now() + 15 * 60_000;
					new Notice("Escrita liberada por 15 minutos.");
					this.refreshPanel(container);
				})
			)
			.addButton((btn) =>
				btn
					.setButtonText("Revogar")
					.setDisabled(!grantActive)
					.onClick(() => {
						this.temporaryWriteUntil = 0;
						new Notice("Liberação revogada.");
						this.refreshPanel(container);
					})
			);

		// ---- Estado do servidor ----
		new Setting(container)
			.setName("Servidor")
			.setDesc(
				running
					? `Rodando na porta ${settings.port}.`
					: "Parado. Ligue o módulo na barra lateral para iniciar o servidor."
			)
			.addButton((btn) =>
				btn
					.setButtonText("Reiniciar servidor")
					// Reiniciar um servidor que nem está no ar não faz sentido —
					// antes o botão ficava ativo e "reiniciava" com o módulo desligado.
					.setDisabled(!running)
					.onClick(async () => {
						try {
							await this.restart();
							new Notice("Servidor MCP reiniciado.");
						} catch (err) {
							new Notice(`Falha ao reiniciar: ${describe(err)}`, 8000);
						}
						this.refreshPanel(container);
					})
			);
	}

	private refreshPanel(container: HTMLElement): void {
		container.empty();
		this.renderSettingsPanel(container);
	}

	private readSettings(): McpModuleSettings {
		return { ...MCP_DEFAULTS, ...this.context?.getSettings<McpModuleSettings>() };
	}

	private async restart(): Promise<void> {
		await this.server?.stop();
		this.server = undefined;
		const settings = this.readSettings();
		try {
			this.server = await createMcpServer({
				port: settings.port,
				getToken: () => deobfuscate(this.readSettings().tokenObfuscated),
				handleToolCall: (toolName, args) => this.handleToolCall(toolName, args),
			});
			this.lastServerError = undefined;
		} catch (err) {
			this.lastServerError = this.describeServerError(err, settings.port);
			throw new Error(this.lastServerError);
		}
	}

	/** Ponto único por onde toda ferramenta MCP passa — aplica rate limit, dry-run e permissões. */
	private async handleToolCall(
		toolName: string,
		args: Record<string, unknown>
	): Promise<{ ok: boolean; result?: unknown; error?: string }> {
		if (!this.withinRateLimit()) {
			return { ok: false, error: "Limite de ações por minuto excedido." };
		}

		const settings = this.readSettings();
		const isWrite = WRITE_TOOLS.has(toolName);
		const dryRun = (args.dryRun as boolean | undefined) ?? settings.dryRunDefault;

		const temporaryGrant = Date.now() < this.temporaryWriteUntil;
		if (isWrite && settings.readOnly && !temporaryGrant) {
			return {
				ok: false,
				error:
					"Servidor MCP está em modo somente-leitura. " +
					"Libere a escrita temporariamente no painel do módulo, se for intencional.",
			};
		}

		if (isWrite) {
			// Checa TODOS os caminhos que a ferramenta pode tocar — rename_note
			// escreve em args.newPath, combine_notes em args.targetPath. Antes só
			// args.path era checado, então era possível "mover" uma nota para
			// dentro de uma pasta bloqueada.
			const targets = collectWriteTargets(args);
			const denied = targets.find((t) => !this.isWriteAllowed(t, settings));
			if (denied !== undefined) {
				return { ok: false, error: `Escrita não permitida no caminho "${denied}".` };
			}
		}

		if (dryRun) {
			return { ok: true, result: { simulated: true, toolName, args } };
		}

		try {
			const result = await this.executeTool(toolName, args);
			this.context?.bus.emit(
				"mcp:action",
				{ toolName, path: args.path, isWrite },
				"mcp"
			);
			this.context?.log(`Ferramenta MCP executada: ${toolName}`, { path: args.path as string });
			return { ok: true, result };
		} catch (err) {
			return { ok: false, error: String(err) };
		}
	}

	private withinRateLimit(): boolean {
		const now = Date.now();
		const windowStart = now - 60_000;
		this.actionTimestamps = this.actionTimestamps.filter((t) => t > windowStart);
		const limit = this.readSettings().rateLimitPerMinute;
		if (this.actionTimestamps.length >= limit) return false;
		this.actionTimestamps.push(now);
		return true;
	}

	private isWriteAllowed(path: string, settings: McpModuleSettings): boolean {
		const normalized = normalizePath(path);
		if (settings.writeBlocklist.some((p) => pathMatches(normalized, p))) {
			return false;
		}
		if (settings.writeAllowlist.length === 0) return true;
		return settings.writeAllowlist.some((p) => pathMatches(normalized, p));
	}

	/**
	 * Execução de fato das ferramentas. Toda ferramenta de ESCRITA passa pela
	 * fila de escrita do núcleo (FileWriteQueue) — é exatamente a corrida que
	 * ela existe para evitar (ex.: Templates movendo a nota no meio de um
	 * patch_note vindo de um cliente MCP).
	 */
	private async executeTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
		const app = this.context!.app;
		const vault = app.vault;
		const write = <T>(path: string, op: () => Promise<T>): Promise<T> =>
			WRITE_TOOLS.has(toolName)
				? this.context!.fileWriteQueueRun(path, op)
				: op();

		switch (toolName) {
			case "read_note": {
				const file = vault.getAbstractFileByPath(normalizePath(String(args.path)));
				if (!(file instanceof TFileClass)) throw new Error("Nota não encontrada.");
				return { content: await vault.read(file as TFile) };
			}
			case "create_note": {
				const path = normalizePath(String(args.path));
				await write(path, () => vault.create(path, String(args.content ?? "")));
				return { path };
			}
			case "append_note": {
				const path = normalizePath(String(args.path));
				const file = vault.getAbstractFileByPath(path);
				if (!(file instanceof TFileClass)) throw new Error("Nota não encontrada.");
				await write(path, () => vault.append(file as TFile, String(args.content ?? "")));
				return { path };
			}
			case "edit_note": {
				const path = normalizePath(String(args.path));
				const file = vault.getAbstractFileByPath(path);
				if (!(file instanceof TFileClass)) throw new Error("Nota não encontrada.");
				await write(path, () => vault.modify(file as TFile, String(args.content ?? "")));
				return { path };
			}
			case "delete_note": {
				const path = normalizePath(String(args.path));
				const file = vault.getAbstractFileByPath(path);
				if (!file) throw new Error("Nota não encontrada.");
				await write(path, () => vault.trash(file, true)); // vai para a lixeira, nunca exclusão direta (rede de segurança)
				return { path };
			}
			case "list_folder": {
				const path = normalizePath(String(args.path ?? "/"));
				const folder = vault.getAbstractFileByPath(path);
				const children = (folder as TFolder | null)?.children ?? vault.getRoot().children;
				return { items: children.map((c) => c.path) };
			}
			case "search_vault": {
				const query = String(args.query ?? "").toLowerCase();
				const matches: string[] = [];
				for (const file of vault.getMarkdownFiles()) {
					const content = await vault.cachedRead(file);
					if (content.toLowerCase().includes(query)) matches.push(file.path);
				}
				return { matches };
			}
			case "get_note_metadata": {
				const path = normalizePath(String(args.path));
				const file = vault.getAbstractFileByPath(path);
				if (!(file instanceof TFileClass)) throw new Error("Nota não encontrada.");
				const cache = app.metadataCache.getFileCache(file as TFile);
				return { frontmatter: cache?.frontmatter ?? {}, tags: cache?.tags ?? [] };
			}
			case "describe_vault": {
				return {
					noteCount: vault.getMarkdownFiles().length,
					folderCount: app.vault.getAllLoadedFiles().filter((f) => !(f instanceof TFileClass)).length,
				};
			}
			case "rename_note": {
				const path = normalizePath(String(args.path));
				const newPath = normalizePath(String(args.newPath));
				const file = vault.getAbstractFileByPath(path);
				if (!file) throw new Error("Nota não encontrada.");
				await write(path, () => app.fileManager.renameFile(file, newPath));
				return { from: path, to: newPath };
			}
			case "patch_note": {
				// Substitui um trecho exato dentro da nota, sem reescrever o arquivo todo.
				const path = normalizePath(String(args.path));
				const file = vault.getAbstractFileByPath(path);
				if (!(file instanceof TFileClass)) throw new Error("Nota não encontrada.");
				const search = String(args.search ?? "");
				const replace = String(args.replace ?? "");
				const content = await vault.read(file as TFile);
				if (!content.includes(search)) throw new Error("Trecho a substituir não encontrado.");
				// replace com string TRATA `$&`, `$1` etc. como padrões especiais;
				// um replace vindo de um cliente MCP precisaria escapar cada `$`
				// para funcionar. Função substitui literalmente.
				await write(path, () =>
					vault.modify(file as TFile, content.replace(search, () => replace))
				);
				return { path };
			}
			case "get_links": {
				const path = normalizePath(String(args.path));
				const file = vault.getAbstractFileByPath(path);
				if (!(file instanceof TFileClass)) throw new Error("Nota não encontrada.");
				const cache = app.metadataCache.getFileCache(file as TFile);
				return {
					links: (cache?.links ?? []).map((l) => l.link),
					embeds: (cache?.embeds ?? []).map((e) => e.link),
				};
			}
			case "get_backlinks": {
				const target = normalizePath(String(args.path));
				const backlinks: string[] = [];
				for (const file of vault.getMarkdownFiles()) {
					const cache = app.metadataCache.getFileCache(file);
					const links = [...(cache?.links ?? []), ...(cache?.embeds ?? [])];
					for (const link of links) {
						const resolved = app.metadataCache.getFirstLinkpathDest(link.link, file.path);
						if (resolved?.path === target) {
							backlinks.push(file.path);
							break;
						}
					}
				}
				return { backlinks };
			}
			case "list_tags": {
				const tags = new Set<string>();
				for (const file of vault.getMarkdownFiles()) {
					const cache = app.metadataCache.getFileCache(file);
					for (const tag of cache?.tags ?? []) tags.add(tag.tag);
					const fmTags = cache?.frontmatter?.tags;
					if (Array.isArray(fmTags)) fmTags.forEach((t) => tags.add(String(t)));
				}
				return { tags: [...tags].sort() };
			}
			case "search_by_tag": {
				const wanted = String(args.tag ?? "").replace(/^#/, "");
				const matches: string[] = [];
				for (const file of vault.getMarkdownFiles()) {
					const cache = app.metadataCache.getFileCache(file);
					const inline = (cache?.tags ?? []).some((t) => t.tag.replace(/^#/, "") === wanted);
					const fmTags = cache?.frontmatter?.tags;
					const inFm = Array.isArray(fmTags) && fmTags.map(String).includes(wanted);
					if (inline || inFm) matches.push(file.path);
				}
				return { matches };
			}
			case "list_attachments": {
				const attachments = vault
					.getFiles()
					.filter((f) => f.extension !== "md")
					.map((f) => f.path);
				return { attachments };
			}
			case "get_attachment": {
				const path = normalizePath(String(args.path));
				const file = vault.getAbstractFileByPath(path);
				if (!(file instanceof TFileClass)) throw new Error("Anexo não encontrado.");
				const buffer = await vault.readBinary(file as TFile);
				return {
					path,
					sizeBytes: buffer.byteLength,
					base64: Buffer.from(buffer).toString("base64"),
				};
			}
			case "split_note": {
				// Divide a nota em várias, quebrando nos headings do nível indicado.
				const path = normalizePath(String(args.path));
				const file = vault.getAbstractFileByPath(path);
				if (!(file instanceof TFileClass)) throw new Error("Nota não encontrada.");
				const level = Number(args.headingLevel ?? 2);
				const marker = "#".repeat(level) + " ";
				const content = await vault.read(file as TFile);
				const folder = path.substring(0, path.lastIndexOf("/"));
				const created: string[] = [];

				const sections = content.split(new RegExp(`^${"#".repeat(level)} `, "m")).slice(1);
				for (const section of sections) {
					const title = section.split("\n")[0].trim();
					if (!title) continue;
					const safeTitle = title.replace(/[\\/:*?"<>|]/g, "-");
					const newPath = normalizePath(`${folder}/${safeTitle}.md`);
					try {
						await write(newPath, () => vault.create(newPath, `${marker}${section}`));
					} catch {
						continue; // já existia (ou falhou) — não entra na lista de criadas
					}
					created.push(newPath);
				}
				return { created };
			}
			case "combine_notes": {
				const paths = (args.paths as string[] | undefined) ?? [];
				const target = normalizePath(String(args.targetPath));
				const parts: string[] = [];
				for (const raw of paths) {
					const file = vault.getAbstractFileByPath(normalizePath(raw));
					if (file instanceof TFileClass) parts.push(await vault.read(file as TFile));
				}
				await write(target, () => vault.create(target, parts.join("\n\n---\n\n")));
				return { target, combined: paths.length };
			}
			case "dataview_query": {
				// Só funciona se o plugin Dataview estiver instalado e habilitado.
				// @ts-expect-error — plugins de terceiros não estão na tipagem oficial
				const dataview = app.plugins?.plugins?.dataview?.api;
				if (!dataview) throw new Error("Plugin Dataview não está instalado ou habilitado.");
				const result = await dataview.query(String(args.query ?? ""));
				return { result };
			}
			case "get_active_file": {
				const active = app.workspace.getActiveFile();
				return { path: active?.path ?? null };
			}
			default:
				throw new Error(`Ferramenta desconhecida: ${toolName}`);
		}
	}
}

const WRITE_TOOLS = new Set([
	"create_note",
	"append_note",
	"edit_note",
	"delete_note",
	"rename_note",
	"patch_note",
	"split_note",
	"combine_notes",
]);

function splitLines(raw: string): string[] {
	return raw
		.split("\n")
		.map((v) => v.trim())
		.filter(Boolean);
}


function describe(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Validação do formulário, com mensagens que dizem o que fazer. */
function validateMcpDraft(draft: {
	port: number;
	rateLimitPerMinute: number;
}): string[] {
	const errors: string[] = [];
	if (!Number.isInteger(draft.port)) {
		errors.push("A porta precisa ser um número inteiro.");
	} else if (draft.port < 1024 || draft.port > 65535) {
		errors.push(`Porta ${draft.port} inválida: use um valor entre 1024 e 65535.`);
	}
	if (!Number.isFinite(draft.rateLimitPerMinute) || draft.rateLimitPerMinute < 1) {
		errors.push("O limite de ações por minuto precisa ser pelo menos 1.");
	}
	return errors;
}

/**
 * Comando de teste em PowerShell. `curl` no Windows é um alias de
 * Invoke-WebRequest, que NÃO aceita a sintaxe `-H "Header: valor"` do curl
 * real — por isso o comando abaixo usa a sintaxe nativa do PowerShell.
 */
function buildTestCommand(port: number, token: string): string {
	return (
		`Invoke-RestMethod -Uri "http://127.0.0.1:${port}" -Method Post \`\n` +
		`  -Headers @{ Authorization = "Bearer ${token}" } \`\n` +
		`  -ContentType "application/json" \`\n` +
		`  -Body '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | ConvertTo-Json -Depth 5`
	);
}
