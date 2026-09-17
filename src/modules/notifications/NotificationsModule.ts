import { Notice, Setting } from "obsidian";
import type { HubModule, ModuleContext, ModuleManifest } from "../../core/ModuleContract";

export type NotifiableTrigger =
	| "file:created"
	| "file:deleted"
	| "file:renamed"
	| "folder:created"
	| "folder:deleted"
	| "calendar:event-fired"
	| "calendar:note-created"
	| "autoupdate:available"
	| "templates:note-pending"
	| "templates:note-restored"
	| "core:safe-mode-entered";

/** Rótulos legíveis — a lista crua de nomes de evento não diz nada ao usuário. */
export const TRIGGER_LABELS: Record<NotifiableTrigger, string> = {
	"file:created": "Arquivo criado",
	"file:deleted": "Arquivo excluído",
	"file:renamed": "Arquivo movido ou renomeado",
	"folder:created": "Pasta criada",
	"folder:deleted": "Pasta excluída",
	"calendar:event-fired": "Evento do calendário chegou",
	"calendar:note-created": "Nota de calendário criada",
	"autoupdate:available": "Atualização disponível",
	"templates:note-pending": "Nota marcada como pendente",
	"templates:note-restored": "Nota completada e devolvida",
	"core:safe-mode-entered": "Módulo desligado por falha",
};

export interface NotificationRule {
	trigger: NotifiableTrigger;
	enabled: boolean;
	sound: boolean;
	priority: "low" | "normal" | "high";
}

export interface StoredNotification {
	id: string;
	trigger: NotifiableTrigger;
	message: string;
	timestamp: number;
	read: boolean;
}

export interface NotificationsModuleSettings {
	rules: NotificationRule[];
	history: StoredNotification[];
	doNotDisturb: { enabled: boolean; startHour: number; endHour: number };
}

const DEFAULT_RULES: NotificationRule[] = [
	{ trigger: "calendar:event-fired", enabled: true, sound: true, priority: "high" },
	{ trigger: "calendar:note-created", enabled: false, sound: false, priority: "low" },
	{ trigger: "autoupdate:available", enabled: true, sound: false, priority: "normal" },
	{ trigger: "templates:note-pending", enabled: true, sound: true, priority: "normal" },
	{ trigger: "templates:note-restored", enabled: true, sound: true, priority: "normal" },
	// BUG CORRIGIDO: estes três vinham desligados por padrão (enabled: false)
	// — por isso criar/renomear/excluir uma nota fora de uma pasta com
	// template nunca disparava pop-up nem som. O módulo já escutava esses
	// eventos "globalmente" (qualquer módulo que emitisse já seria pego),
	// só faltava a REGRA vir ligada de fábrica.
	{ trigger: "file:created", enabled: true, sound: true, priority: "low" },
	{ trigger: "file:deleted", enabled: true, sound: true, priority: "low" },
	{ trigger: "file:renamed", enabled: true, sound: true, priority: "low" },
	{ trigger: "folder:created", enabled: true, sound: false, priority: "low" },
	{ trigger: "folder:deleted", enabled: true, sound: false, priority: "low" },
	{ trigger: "core:safe-mode-entered", enabled: true, sound: true, priority: "high" },
];

export const NOTIFICATIONS_DEFAULTS: NotificationsModuleSettings = {
	rules: DEFAULT_RULES,
	history: [],
	doNotDisturb: { enabled: false, startHour: 22, endHour: 8 },
};

const MAX_HISTORY = 100;

/**
 * MÓDULO DE NOTIFICAÇÕES
 * ------------------------
 * Escuta eventos de OUTROS módulos via bus (nunca importa esses módulos
 * diretamente) e decide, com base nas regras configuradas pelo usuário, se
 * deve mostrar um pop-up com som. Isso é o exemplo mais direto do padrão de
 * "módulos conversando entre si" definido na arquitetura: qualquer módulo
 * futuro que emitir um evento no bus pode virar uma notificação só de
 * adicionar uma linha em DEFAULT_RULES — sem este módulo precisar conhecer
 * o módulo novo.
 */
export class NotificationsModule implements HubModule {
	readonly manifest: ModuleManifest = {
		id: "notifications",
		displayName: "Notificações",
		description: "Pop-up com som para eventos do plugin, configurável por tipo de evento.",
		icon: "bell",
		version: "0.1.0",
		contractVersion: "2.0.0",
		desktopOnly: false,
		emits: [],
		listensTo: [
			"file:created",
			"file:deleted",
			"calendar:event-fired",
			"autoupdate:available",
			"templates:note-pending",
			"templates:note-restored",
			"core:safe-mode-entered",
		],
		settingsSchema: [],
	};

	private context?: ModuleContext;
	private unsubscribers: (() => void)[] = [];
	private audioCtx?: AudioContext;

	onRegister(context: ModuleContext): void {
		this.context = context;
	}

	onEnable(): void {
		const context = this.context!;

		// Escuta TODOS os gatilhos conhecidos — não só os que já têm regra
		// salva. Antes, um gatilho ativado depois do onEnable nunca passava a
		// ser escutado até reiniciar o módulo, o que fazia parecer que
		// notificação "não funcionava".
		for (const trigger of Object.keys(TRIGGER_LABELS) as NotifiableTrigger[]) {
			const unsub = context.bus.on(trigger, "notifications", (event) =>
				this.handleEvent(trigger, event.payload as Record<string, unknown>)
			);
			this.unsubscribers.push(unsub);
		}

		context.registerCommand("notifications-test", "Notificações: disparar teste", () => {
			this.showPopup("🔔 Notificação de teste do All iₙ oNe", "normal");
			void this.playSound("normal");
		});
	}

	renderSettingsPanel(container: HTMLElement): void {
		const settings = this.readSettings();

		new Setting(container)
			.setName("Testar notificação")
			.setDesc("Dispara um pop-up com som agora, para conferir que está tudo funcionando.")
			.addButton((btn) =>
				btn.setButtonText("Disparar teste").onClick(() => {
					this.showPopup("🔔 Notificação de teste do All iₙ oNe", "normal");
					void this.playSound("normal");
				})
			);

		container.createEl("h3", { text: "Regras por tipo de evento" });
		container.createEl("p", {
			cls: "ione-hub-lobby__description",
			text: "💬 = mostrar o pop-up na tela  ·  🔊 = tocar som junto com o pop-up.",
		});
		for (const rule of settings.rules) {
			const row = new Setting(container)
				.setName(TRIGGER_LABELS[rule.trigger] ?? rule.trigger)
				.setDesc(rule.trigger);
			row.controlEl.createSpan({ text: "💬", cls: "ione-hub-toggle-emoji" });
			row.addToggle((toggle) =>
				toggle
					.setValue(rule.enabled)
					.setTooltip("Mostrar pop-up na tela")
					.onChange(async (value) => {
						await this.updateRule(rule.trigger, { enabled: value });
					})
			);
			row.controlEl.createSpan({ text: "🔊", cls: "ione-hub-toggle-emoji" });
			row.addToggle((toggle) =>
				toggle
					.setValue(rule.sound)
					.setTooltip("Tocar som junto")
					.onChange(async (value) => {
						await this.updateRule(rule.trigger, { sound: value });
					})
			);
		}

		container.createEl("h3", { text: "Não perturbe" });
		new Setting(container)
			.setName("Ativar horário de silêncio")
			.addToggle((toggle) =>
				toggle.setValue(settings.doNotDisturb.enabled).onChange(async (value) => {
					await this.context?.updateSettings({
						doNotDisturb: { ...settings.doNotDisturb, enabled: value },
					});
				})
			);
		new Setting(container)
			.setName("Início (hora, 0-23)")
			.addText((text) =>
				text.setValue(String(settings.doNotDisturb.startHour)).onChange(async (v) => {
					const n = Number(v);
					if (!Number.isFinite(n)) return;
					await this.context?.updateSettings({
						doNotDisturb: { ...settings.doNotDisturb, startHour: n },
					});
				})
			);
		new Setting(container)
			.setName("Fim (hora, 0-23)")
			.addText((text) =>
				text.setValue(String(settings.doNotDisturb.endHour)).onChange(async (v) => {
					const n = Number(v);
					if (!Number.isFinite(n)) return;
					await this.context?.updateSettings({
						doNotDisturb: { ...settings.doNotDisturb, endHour: n },
					});
				})
			);

		// ---- Central de notificações (histórico persistente) ----
		container.createEl("h3", { text: "Central de notificações" });

		const unread = settings.history.filter((h) => !h.read).length;
		new Setting(container)
			.setName(`${settings.history.length} notificação(ões) guardada(s), ${unread} não lida(s)`)
			.addButton((btn) =>
				btn.setButtonText("Marcar tudo como lido").onClick(async () => {
					await this.markAllRead();
					container.empty();
					this.renderSettingsPanel(container);
				})
			)
			.addButton((btn) =>
				btn.setButtonText("Limpar histórico").onClick(async () => {
					await this.context?.updateSettings({ history: [] });
					container.empty();
					this.renderSettingsPanel(container);
				})
			);

		if (settings.history.length === 0) {
			container.createEl("p", {
				text: "Nenhuma notificação ainda.",
				cls: "ione-hub-lobby__description",
			});
		} else {
			const list = container.createDiv({ cls: "ione-hub-notification-list" });
			for (const entry of settings.history.slice(0, 50)) {
				const row = list.createDiv({ cls: "ione-hub-notification-list__row" });
				if (!entry.read) row.addClass("is-unread");
				row.createSpan({
					text: new Date(entry.timestamp).toLocaleString("pt-BR"),
					cls: "ione-hub-lobby__history-time",
				});
				row.createSpan({ text: ` ${entry.message}` });
			}
		}
	}

	private async updateRule(trigger: NotifiableTrigger, patch: Partial<NotificationRule>): Promise<void> {
		const settings = this.readSettings();
		const rules = settings.rules.map((r) => (r.trigger === trigger ? { ...r, ...patch } : r));
		await this.context?.updateSettings({ rules });
	}

	onDisable(): void {
		this.unsubscribers.forEach((u) => u());
		this.unsubscribers = [];
	}

	private readSettings(): NotificationsModuleSettings {
		return { ...NOTIFICATIONS_DEFAULTS, ...this.context?.getSettings<NotificationsModuleSettings>() };
	}

	private handleEvent(trigger: NotifiableTrigger, payload: Record<string, unknown>): void {
		const settings = this.readSettings();
		const rule = settings.rules.find((r) => r.trigger === trigger);
		if (!rule || !rule.enabled) return;
		if (this.isWithinDoNotDisturb(settings)) return;

		const message = this.formatMessage(trigger, payload);
		this.showPopup(message, rule.priority);
		if (rule.sound) void this.playSound(rule.priority);
		void this.appendHistory(trigger, message);
	}

	private isWithinDoNotDisturb(settings: NotificationsModuleSettings): boolean {
		if (!settings.doNotDisturb.enabled) return false;
		const hour = new Date().getHours();
		const { startHour, endHour } = settings.doNotDisturb;
		if (startHour < endHour) return hour >= startHour && hour < endHour;
		return hour >= startHour || hour < endHour; // cruza a meia-noite
	}

	private formatMessage(trigger: NotifiableTrigger, payload: Record<string, unknown>): string {
		switch (trigger) {
			case "calendar:event-fired": {
				const event = payload.event as { title?: string } | undefined;
				return `📅 ${event?.title ?? "Evento de calendário"}`;
			}
			case "autoupdate:available":
				return `⬆️ Nova versão disponível: ${payload.version}`;
			case "templates:note-pending":
				return `📝 Nota criada pendente: ${payload.path}`;
			case "templates:note-restored":
				return `✅ Nota completada e restaurada: ${payload.path}`;
			case "core:safe-mode-entered":
				return `⚠️ Módulo "${payload.moduleId}" foi desligado automaticamente após falhas repetidas.`;
			case "file:created":
				return `📄 Arquivo criado: ${payload.path}`;
			case "file:deleted":
				return `🗑️ Arquivo excluído: ${payload.path}`;
			case "file:renamed":
				return `↪️ Movido: ${payload.oldPath} → ${payload.path}`;
			case "folder:created":
				return `📁 Pasta criada: ${payload.path}`;
			case "folder:deleted":
				return `🗑️ Pasta excluída: ${payload.path}`;
			case "calendar:note-created":
				return `📅 Nota de calendário criada: ${payload.path}`;
			default:
				return JSON.stringify(payload);
		}
	}

	/** Pop-up retangular — usa o Notice nativo do Obsidian como base, estilizado via CSS próprio do módulo. */
	private showPopup(message: string, priority: "low" | "normal" | "high"): void {
		const notice = new Notice("", priority === "high" ? 8000 : 4000);
		notice.noticeEl.addClass("ione-hub-notification");
		notice.noticeEl.addClass(`ione-hub-notification--${priority}`);
		notice.noticeEl.setText(message);
	}

	/**
	 * Toca um bipe curto. O AudioContext nasce suspenso até haver interação do
	 * usuário na janela (política de autoplay do Chromium, que o Obsidian usa)
	 * — por isso o `resume()` explícito: sem ele, o som simplesmente não saía.
	 */
	private async playSound(priority: "low" | "normal" | "high"): Promise<void> {
		try {
			this.audioCtx = this.audioCtx ?? new AudioContext();
			if (this.audioCtx.state === "suspended") {
				await this.audioCtx.resume();
			}

			const ctx = this.audioCtx;
			const now = ctx.currentTime;
			const oscillator = ctx.createOscillator();
			const gain = ctx.createGain();

			oscillator.type = "sine";
			oscillator.frequency.value = priority === "high" ? 880 : priority === "normal" ? 660 : 440;
			oscillator.connect(gain);
			gain.connect(ctx.destination);

			// Envelope curto evita o "clique" audível de ligar/desligar seco.
			gain.gain.setValueAtTime(0.0001, now);
			gain.gain.exponentialRampToValueAtTime(0.2, now + 0.01);
			gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.25);

			oscillator.start(now);
			oscillator.stop(now + 0.3);

			if (priority === "high") {
				// Dois bipes para eventos importantes.
				const second = ctx.createOscillator();
				const secondGain = ctx.createGain();
				second.type = "sine";
				second.frequency.value = 1046;
				second.connect(secondGain);
				secondGain.connect(ctx.destination);
				secondGain.gain.setValueAtTime(0.0001, now + 0.32);
				secondGain.gain.exponentialRampToValueAtTime(0.2, now + 0.33);
				secondGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.55);
				second.start(now + 0.32);
				second.stop(now + 0.6);
			}
		} catch (err) {
			console.warn("[All iₙ oNe] Não foi possível tocar o som da notificação:", err);
		}
	}

	private async appendHistory(trigger: NotifiableTrigger, message: string): Promise<void> {
		const settings = this.readSettings();
		const entry: StoredNotification = {
			id: `notif-${Date.now()}`,
			trigger,
			message,
			timestamp: Date.now(),
			read: false,
		};
		const history = [entry, ...settings.history].slice(0, MAX_HISTORY);
		await this.context?.updateSettings({ history });
	}

	async markAllRead(): Promise<void> {
		const settings = this.readSettings();
		await this.context?.updateSettings({
			history: settings.history.map((h) => ({ ...h, read: true })),
		});
	}
}
