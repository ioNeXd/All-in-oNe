import { Setting, Notice } from "obsidian";
import type { HubModule, ModuleContext, ModuleManifest } from "../../core/ModuleContract";
import { cryptoRandomId } from "../../core/types";

/**
 * Janela de coalescência das gravações (write-behind). O Histórico recebe
 * eventos a cada arquivo tocado no vault — persistir o settings inteiro em
 * CADA evento significava dezenas de escritas de disco por minuto em vault
 * ativo. As entradas novas acumulam em memória e um único save leva tudo ao
 * disco após a janela fechar. Dado volátil por natureza: o pior caso de uma
 * queda do Obsidian dentro da janela é perder os últimos ~2s de registro.
 */
const FLUSH_INTERVAL_MS = 2000;

export interface HistoryEntryRecord {
	id: string;
	event: string;
	origin: string;
	path?: string;
	message: string;
	timestamp: number;
}

export interface HistoryModuleSettings {
	entries: HistoryEntryRecord[];
	maxEntries: number;
	/** Eventos que NÃO devem ser registrados (reduz ruído em vaults ativos). */
	mutedEvents: string[];
}

export const HISTORY_DEFAULTS: HistoryModuleSettings = {
	entries: [],
	maxEntries: 500,
	mutedEvents: ["file:modified"],
};

/** Eventos que o Histórico acompanha. Módulos novos entram só adicionando aqui. */
const TRACKED_EVENTS = [
	"file:created",
	"file:modified",
	"file:deleted",
	"file:renamed",
	"folder:created",
	"folder:deleted",
	"mcp:action",
	"mcp:server-started",
	"mcp:server-stopped",
	"templates:note-pending",
	"templates:note-restored",
	"calendar:note-created",
	"calendar:note-opened",
	"calendar:event-fired",
	"styles:applied",
	"autoupdate:available",
	"autoupdate:applied",
	"core:module-error",
	"core:safe-mode-entered",
];

/**
 * MÓDULO DE HISTÓRICO
 * --------------------
 * Antes o histórico vivia dentro do núcleo (HubCore), o que misturava
 * orquestração com uma funcionalidade de produto. Agora é um módulo como
 * qualquer outro: pode ser desligado, tem configuração própria e persiste
 * entre sessões (o do núcleo se perdia ao fechar o Obsidian).
 *
 * Ele escuta o barramento e registra o que acontece no vault e nos demais
 * módulos — sem nenhum deles precisar saber que o Histórico existe.
 */
export class HistoryModule implements HubModule {
	readonly manifest: ModuleManifest = {
		id: "history",
		displayName: "Histórico",
		description:
			"Registra criação, alteração e exclusão de arquivos e pastas, além das ações dos outros módulos.",
		icon: "history",
		version: "0.1.0",
		contractVersion: "2.0.0",
		desktopOnly: false,
		emits: [],
		listensTo: TRACKED_EVENTS,
		settingsSchema: [
			{
				key: "maxEntries",
				label: "Máximo de entradas guardadas",
				type: "number",
				default: HISTORY_DEFAULTS.maxEntries,
			},
		],
	};

	private context?: ModuleContext;
	private unsubscribers: (() => void)[] = [];
	private filter = "";
	/** Entradas ainda não persistidas (dreno no flush). */
	private pendingEntries: HistoryEntryRecord[] = [];
	private flushTimer?: ReturnType<typeof setTimeout>;
	/** Protetor de corrida clear/reset × flush pendente (ver clearEntries). */
	private flushGeneration = 0;

	onRegister(context: ModuleContext): void {
		this.context = context;
	}

	onEnable(): void {
		for (const eventName of TRACKED_EVENTS) {
			const unsub = this.context!.bus.on(eventName, "history", (event) => {
				// O bus coalesce rajadas (ver EventBus): uma emissão dentro da
				// janela de throttle vira { coalesced: [...] } no fim dela. O
				// Histórico quer CADA ocorrência — expande e registra uma a uma.
				const payload = event.payload as
					| { coalesced?: Record<string, unknown>[] }
					| Record<string, unknown>;
				if (
					payload &&
					typeof payload === "object" &&
					Array.isArray((payload as { coalesced?: unknown }).coalesced)
				) {
					for (const item of (payload as { coalesced: Record<string, unknown>[] }).coalesced) {
						this.record(eventName, event.source, item);
					}
					return;
				}
				this.record(eventName, event.source, payload as Record<string, unknown>);
			});
			this.unsubscribers.push(unsub);
		}
	}

	onDisable(): void {
		this.unsubscribers.forEach((u) => u());
		this.unsubscribers = [];
		void this.flushNow(); // não perde o que já foi registrado na sessão
	}

	/**
	 * Reset nível "data"/"all": limpa APENAS os dados gerados (as entradas).
	 * Preferências do usuário (maxEntries, mutedEvents) ficam intactas — são
	 * configuração, não dado. No nível "config" este hook não é chamado.
	 */
	onResetData(): Promise<void> {
		// Cancela o flush pendente e invalida o que estiver em voo: sem isto,
		// o save atrasado ressuscitaria as entradas recém-limpas.
		this.flushGeneration++;
		if (this.flushTimer) clearTimeout(this.flushTimer);
		this.flushTimer = undefined;
		this.pendingEntries = [];
		return (this.context?.updateSettings({ entries: [] }) ?? Promise.resolve([])).then(() => void 0);
	}

	getHealthStatus() {
		return { ok: true, summary: `${this.readSettings().entries.length} entrada(s) registrada(s)` };
	}

	private readSettings(): HistoryModuleSettings {
		const settings = { ...HISTORY_DEFAULTS, ...this.context?.getSettings<HistoryModuleSettings>() };
		// As pendentes do write-behind fazem parte do estado lógico — leitura
		// (painel, contagem do diagnóstico) inclui o que ainda não chegou ao
		// disco, sem esperar a janela de flush. Mesmo contrato do
		// NotificationsModule.readSettings: pendentes primeiro, dedupe por id
		// contra o que já está persistido, teto de maxEntries.
		if (this.pendingEntries.length > 0) {
			const persisted = settings.entries.filter(
				(e) => !this.pendingEntries.some((p) => p.id === e.id)
			);
			settings.entries = [...this.pendingEntries, ...persisted].slice(0, settings.maxEntries);
		}
		return settings;
	}

	private record(
		eventName: string,
		origin: string,
		payload: Record<string, unknown>
	): void {
		const settings = this.readSettings();
		if (settings.mutedEvents.includes(eventName)) return;

		const entry: HistoryEntryRecord = {
			// cryptoRandomId (mesmo gerador do núcleo): duas entradas no mesmo
			// milissegundo não colidem — o id é chave do dedupe contra pendentes
			// e do "Limpar histórico" em voo.
			id: `h-${cryptoRandomId()}`,
			event: eventName,
			origin,
			path: typeof payload?.path === "string" ? payload.path : undefined,
			message: describeEvent(eventName, payload),
			timestamp: Date.now(),
		};

		// Write-behind: acumula em memória e agenda o dreno. A leitura da
		// lista (record/painel) SEMPRE inclui as pendentes — o usuário vê na
		// hora; só o DISCO é que é coalescido.
		this.pendingEntries = [entry, ...this.pendingEntries];
		if (!this.flushTimer) {
			this.flushTimer = setTimeout(() => void this.flushNow(), FLUSH_INTERVAL_MS);
		}
	}

	/** Drena as entradas pendentes num único save (batedor: reset invalida a geração). */
	private async flushNow(): Promise<void> {
		this.flushTimer = undefined;
		if (this.pendingEntries.length === 0) return;
		const generation = this.flushGeneration;
		const batch = this.pendingEntries;
		this.pendingEntries = [];

		const settings = this.readSettings();
		const merged = [...batch, ...settings.entries].slice(0, settings.maxEntries);
		await this.context?.updateSettings({ entries: merged });
		if (generation !== this.flushGeneration) {
			// Reset aconteceu enquanto o save estava em voo: a fatia limpa no
			// disco acabou de ser sobrescrita — desfaz.
			await this.context?.updateSettings({ entries: [] });
		}
	}

	renderSettingsPanel(container: HTMLElement): void {
		const settings = this.readSettings();

		new Setting(container)
			.setName("Máximo de entradas guardadas")
			.setDesc("Entradas mais antigas são descartadas ao passar deste limite.")
			.addText((text) => {
				text.setValue(String(settings.maxEntries));
				text.inputEl.onblur = async () => {
					const n = Number(text.getValue());
					if (!Number.isFinite(n) || n < 10) {
						new Notice("Informe um número maior ou igual a 10.");
						text.setValue(String(settings.maxEntries));
						return;
					}
					await this.context?.updateSettings({ maxEntries: n });
				};
			});

		new Setting(container)
			.setName("Ignorar alterações de arquivo")
			.setDesc('Eventos "file:modified" são muito frequentes e poluem o histórico.')
			.addToggle((toggle) =>
				toggle.setValue(settings.mutedEvents.includes("file:modified")).onChange(async (value) => {
					const muted = value
						? [...new Set([...settings.mutedEvents, "file:modified"])]
						: settings.mutedEvents.filter((e) => e !== "file:modified");
					await this.context?.updateSettings({ mutedEvents: muted });
				})
			);

		new Setting(container)
			.setName(`${settings.entries.length} entrada(s)`)
			.addButton((btn) =>
				btn.setButtonText("Limpar histórico").onClick(async () => {
					// Invalida o flush em voo (mesma lógica do onResetData): sem
					// isto, o save pendente ressuscitaria o que acabou de ser limpo.
					this.flushGeneration++;
					if (this.flushTimer) clearTimeout(this.flushTimer);
					this.flushTimer = undefined;
					this.pendingEntries = [];
					await this.context?.updateSettings({ entries: [] });
					this.refresh(container);
				})
			);

		// ---- Filtro + lista ----
		container.createEl("h3", { text: "Registro de atividade" });
		const filterRow = container.createDiv({ cls: "ione-hub-lobby__quick-actions" });
		filterRow.createSpan({ text: "Mostrar apenas: " });
		const select = filterRow.createEl("select");
		select.createEl("option", { text: "Tudo", value: "" });
		for (const eventName of TRACKED_EVENTS) {
			select.createEl("option", { text: EVENT_LABELS[eventName] ?? eventName, value: eventName });
		}
		select.value = this.filter;
		select.onchange = () => {
			this.filter = select.value;
			this.refresh(container);
		};

		// Explica em português o que o filtro selecionado faz.
		container.createEl("p", {
			cls: "ione-hub-lobby__description",
			text: this.filter
				? `Mostrando apenas: ${EVENT_LABELS[this.filter] ?? this.filter}. ` +
					`${FILTER_HELP[this.filter] ?? ""}`
				: "Mostrando todos os tipos de atividade registrados pelo plugin. " +
					"Use o seletor acima para ver só um tipo (por exemplo, apenas exclusões de arquivo).",
		});

		const entries = this.filter
			? settings.entries.filter((e) => e.event === this.filter)
			: settings.entries;

		if (entries.length === 0) {
			container.createEl("p", {
				text: "Nada registrado ainda.",
				cls: "ione-hub-lobby__description",
			});
			return;
		}

		const list = container.createDiv({ cls: "ione-hub-lobby__history" });
		for (const entry of entries.slice(0, 200)) {
			const row = list.createDiv({ cls: "ione-hub-lobby__history-row" });
			row.createSpan({
				text: `[${new Date(entry.timestamp).toLocaleString("pt-BR")}] `,
				cls: "ione-hub-lobby__history-time",
			});
			row.createSpan({ text: entry.message });
		}
	}

	private refresh(container: HTMLElement): void {
		container.empty();
		this.renderSettingsPanel(container);
	}
}

/** Nome curto e legível de cada evento, para o seletor de filtro. */
export const EVENT_LABELS: Record<string, string> = {
	"file:created": "Arquivo criado",
	"file:modified": "Arquivo alterado",
	"file:deleted": "Arquivo excluído",
	"file:renamed": "Arquivo movido ou renomeado",
	"folder:created": "Pasta criada",
	"folder:deleted": "Pasta excluída",
	"mcp:action": "Ação do servidor MCP",
	"mcp:server-started": "Servidor MCP iniciado",
	"mcp:server-stopped": "Servidor MCP parado",
	"templates:note-pending": "Nota marcada como pendente",
	"templates:note-restored": "Nota concluída",
	"calendar:note-created": "Nota de calendário criada",
	"calendar:note-opened": "Nota de calendário aberta",
	"calendar:event-fired": "Lembrete do calendário disparado",
	"styles:applied": "Estilo aplicado",
	"autoupdate:available": "Atualização disponível",
	"autoupdate:applied": "Atualização instalada",
	"core:module-error": "Erro em um módulo",
	"core:safe-mode-entered": "Módulo desligado por falha",
};

/** Frase de ajuda por filtro, para quem não conhece os termos técnicos. */
const FILTER_HELP: Record<string, string> = {
	"file:created": "Toda vez que uma nota ou arquivo novo aparece no vault.",
	"file:deleted": "Toda vez que um arquivo é mandado para a lixeira.",
	"file:renamed": "Inclui mover um arquivo de pasta, não só trocar o nome.",
	"mcp:action": "Cada ferramenta que uma IA externa executou no seu vault.",
	"templates:note-pending": "Notas que ficaram incompletas e foram para a pasta Pendente.",
	"templates:note-restored": "Notas que você terminou e voltaram para a pasta de origem.",
};

/** Texto legível para cada tipo de evento — o que o usuário realmente lê. */
function describeEvent(eventName: string, payload: Record<string, unknown>): string {
	const path = typeof payload?.path === "string" ? payload.path : "";
	switch (eventName) {
		case "file:created":
			return `Arquivo criado: ${path}`;
		case "file:modified":
			return `Arquivo alterado: ${path}`;
		case "file:deleted":
			return `Arquivo excluído: ${path}`;
		case "file:renamed":
			return `Arquivo movido/renomeado: ${payload.oldPath} → ${path}`;
		case "folder:created":
			return `Pasta criada: ${path}`;
		case "folder:deleted":
			return `Pasta excluída: ${path}`;
		case "mcp:action":
			return `MCP executou "${payload.toolName}"${path ? ` em ${path}` : ""}`;
		case "mcp:server-started":
			return `Servidor MCP iniciado na porta ${payload.port}`;
		case "mcp:server-stopped":
			return "Servidor MCP parado";
		case "templates:note-pending":
			return `Nota marcada como pendente: ${path}`;
		case "templates:note-restored":
			return `Nota completada e devolvida ao lugar: ${path}`;
		case "calendar:note-created":
			return `Nota de calendário criada: ${path}`;
		case "calendar:note-opened":
			return `Nota de calendário aberta: ${path}`;
		case "calendar:event-fired": {
			const event = payload.event as { title?: string } | undefined;
			return `Evento de calendário disparado: ${event?.title ?? "(sem título)"}`;
		}
		case "styles:applied":
			return "Estilo customizado aplicado";
		case "autoupdate:available":
			return `Atualização disponível: ${payload.version}`;
		case "autoupdate:applied":
			return `Atualização aplicada: ${payload.version}`;
		case "core:module-error":
			return `Erro no módulo "${payload.moduleId}": ${payload.error}`;
		case "core:safe-mode-entered":
			return `Módulo "${payload.moduleId}" desligado automaticamente após falhas`;
		default:
			return `${eventName} ${path}`.trim();
	}
}
