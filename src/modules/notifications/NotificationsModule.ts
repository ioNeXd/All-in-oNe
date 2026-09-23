import { Notice, Setting } from "obsidian";
import type { HubModule, ModuleContext, ModuleManifest } from "../../core/ModuleContract";
import { randomId } from "../../core/types";
import { WriteBehindQueue } from "../../core/WriteBehind";
import { AudioUnlocker } from "../../core/AudioUnlock";
import {
	buildFilterOptions,
	countByTrigger,
	filterNotifications,
	groupNotificationsByDay,
	type NotificationListFilter,
} from "./NotificationList";

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
	/**
	 * Preferência de filtro da central (persistida na fatia). "all" para
	 * config antiga que não tinha o campo — o spread dos defaults cobre
	 * sem migração (não há transformação de dados antigos, só um default).
	 */
	viewFilter: NotificationListFilter;
	/** Agrupar a central por dia (cabeçalhos Hoje/Ontem/data) — também persistida. */
	groupByDay: boolean;
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
	viewFilter: "all",
	groupByDay: true,
};

const MAX_HISTORY = 100;

/**
 * Janela de coalescência das gravações (write-behind), igual ao Histórico:
 * notificações de eventos de vault são frequentes em vault ativo — persistir
 * o settings inteiro a cada uma dava dezenas de escritas de disco por
 * minuto. Entradas novas acumulam em memória e um único save as leva ao
 * disco após a janela (pior caso de queda: ~2s de notificações não lidas
 * não persistidas).
 */
const FLUSH_INTERVAL_MS = 2000;

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
		version: "0.2.0",
		contractVersion: "2.0.0",
		desktopOnly: false,
		emits: [],
		// Espelha os gatilhos de TRIGGER_LABELS — o onEnable escuta todos eles,
		// então este manifesto tem que listar todos (é "documentação viva").
		listensTo: Object.keys(TRIGGER_LABELS) as string[],
		settingsSchema: [],
	};

	private context?: ModuleContext;
	private unsubscribers: (() => void)[] = [];
	/**
	 * Notificações ainda não persistidas (write-behind, ver FLUSH_INTERVAL_MS).
	 * Fila com confirm: itens saem só quando o save persiste — um record
	 * durante o save em voo vai no drain seguinte, sem janela de perda
	 * (ver core/WriteBehind.ts).
	 */
	private pendingNotifications = new WriteBehindQueue<StoredNotification>();
	private flushTimer?: ReturnType<typeof setTimeout>;
	/** Protetor de corrida clear/reset × flush pendente (ver flushNow). */
	private flushGeneration = 0;
	/**
	 * Desbloqueio de áudio: o contexto nasce suspenso até um GESTO do usuário
	 * (core/AudioUnlock.ts). Arma os ouvintes no onEnable; o som só toca após
	 * o primeiro clique/tecla na janela — antes disso o popup sai sem som.
	 */
	private readonly audioUnlocker = new AudioUnlocker();

	onRegister(context: ModuleContext): void {
		this.context = context;
	}

	onEnable(): void {
		const context = this.context!;
		this.audioUnlocker.arm();

		// Escuta TODOS os gatilhos conhecidos — não só os que já têm regra
		// salva. Antes, um gatilho ativado depois do onEnable nunca passava a
		// ser escutado até reiniciar o módulo, o que fazia parecer que
		// notificação "não funcionava".
		for (const trigger of Object.keys(TRIGGER_LABELS) as NotifiableTrigger[]) {
			const unsub = context.bus.on(trigger, "notifications", (event) => {
				// O bus coalesce rajadas (ver EventBus): em vez de perder eventos
				// dentro da janela de throttle, eles chegam agrupados como
				// { coalesced: [...] }. Notifica CADA item — o popup/som é
				// separado (sem rajada de sons) e o histórico fica completo.
				const raw = event.payload as
					| { coalesced?: Record<string, unknown>[] }
					| Record<string, unknown>;
				if (
					raw &&
					typeof raw === "object" &&
					Array.isArray((raw as { coalesced?: unknown }).coalesced)
				) {
					const items = (raw as { coalesced: Record<string, unknown>[] }).coalesced;
					for (let i = 0; i < items.length; i++) {
						this.handleEvent(trigger, items[i], i === 0);
					}
					return;
				}
				this.handleEvent(trigger, raw as Record<string, unknown>);
			});
			this.unsubscribers.push(unsub);
		}

		context.registerCommand("notifications-test", "Notificações: disparar teste", () => {
			this.showPopup("🔔 Notificação de teste do All iₙ oNe", "normal");
			// Comando da Paleta É um gesto: destrava (e o primeiro teste já tem som).
			void this.audioUnlocker.unlock().then(() => this.playSound("normal"));
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
					// O clique no botão É o gesto exigido pela política de autoplay:
					void this.audioUnlocker.unlock().then(() => this.playSound("normal"));
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
					// Invalida o flush em voo (mesma lógica do onResetData): sem
					// isto, o save pendente ressuscitaria o que acabou de ser limpo.
					this.flushGeneration++;
					if (this.flushTimer) clearTimeout(this.flushTimer);
					this.flushTimer = undefined;
					this.pendingNotifications.clear();
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
			// ---- Filtro + agrupamento (regras puras em NotificationList.ts) ----
			const knownTriggers = Object.keys(TRIGGER_LABELS) as NotifiableTrigger[];
			const filtered = filterNotifications(settings.history, settings.viewFilter, knownTriggers);

			new Setting(container)
				.setName("Filtrar por tipo de evento")
				.setDesc(
					settings.groupByDay
						? "Agrupado por dia. A preferência fica salva."
						: "Lista cronológica simples. A preferência fica salva."
				)
				.addDropdown((dd) => {
					for (const option of buildFilterOptions(
						countByTrigger(settings.history),
						knownTriggers,
						TRIGGER_LABELS,
						settings.viewFilter
					)) {
						dd.addOption(option.value, option.label);
					}
					dd.setValue(settings.viewFilter);
					dd.onChange(async (value) => {
						await this.context?.updateSettings({ viewFilter: value as NotificationListFilter });
						container.empty();
						this.renderSettingsPanel(container);
					});
				})
				.addToggle((toggle) =>
					toggle.setValue(settings.groupByDay).setTooltip("Agrupar por dia").onChange(async (value) => {
						await this.context?.updateSettings({ groupByDay: value });
						container.empty();
						this.renderSettingsPanel(container);
					})
				);

			if (filtered.length === 0) {
				container.createEl("p", {
					text: "Nenhuma notificação desse tipo.",
					cls: "ione-hub-lobby__description",
				});
			} else if (settings.groupByDay) {
				const list = container.createDiv({ cls: "ione-hub-notification-list" });
				for (const group of groupNotificationsByDay(filtered, new Date())) {
					list.createEl("h4", { text: group.label, cls: "ione-hub-notification-list__day" });
					for (const entry of group.items) this.renderNotificationRow(list, entry);
				}
			} else {
				const list = container.createDiv({ cls: "ione-hub-notification-list" });
				for (const entry of filtered.slice(0, 50)) this.renderNotificationRow(list, entry);
			}
		}
	}

	/** Linha da central — extraída para filtro/agrupamento renderizarem igual. */
	private renderNotificationRow(list: HTMLElement, entry: StoredNotification): void {
		const row = list.createDiv({ cls: "ione-hub-notification-list__row" });
		if (!entry.read) row.addClass("is-unread");
		row.createSpan({
			text: new Date(entry.timestamp).toLocaleString("pt-BR", {
				hour: "2-digit",
				minute: "2-digit",
			}),
			cls: "ione-hub-lobby__history-time",
		});
		row.createSpan({ text: ` ${entry.message}` });
	}

	private async updateRule(trigger: NotifiableTrigger, patch: Partial<NotificationRule>): Promise<void> {
		const settings = this.readSettings();
		const rules = settings.rules.map((r) => (r.trigger === trigger ? { ...r, ...patch } : r));
		await this.context?.updateSettings({ rules });
	}

	onDisable(): void {
		this.unsubscribers.forEach((u) => u());
		this.unsubscribers = [];
		// Ouvintes de gesto morrem com o módulo; o contexto destravado
		// sobrevive — religar não re-trava o som.
		this.audioUnlocker.disarm();
		void this.flushNow(); // não perde o que já foi notificado na sessão
	}

	/**
	 * Reset nível "data"/"all": limpa o histórico de notificações (dado
	 * gerado). Regras e não-perturbe ficam intactos — são configuração.
	 */
	onResetData(): Promise<void> {
		// Cancela o flush pendente e invalida o que estiver em voo: sem isto,
		// o save atrasado ressuscitaria as notificações recém-limpas.
		this.flushGeneration++;
		if (this.flushTimer) clearTimeout(this.flushTimer);
		this.flushTimer = undefined;
		this.pendingNotifications.clear();
		return (this.context?.updateSettings({ history: [] }) ?? Promise.resolve([])).then(() => void 0);
	}

	private readSettings(): NotificationsModuleSettings {
		const settings = { ...NOTIFICATIONS_DEFAULTS, ...this.context?.getSettings<NotificationsModuleSettings>() };
		// As pendentes do write-behind fazem parte do estado lógico — leitura
		// (painel, contagem de não lidas) inclui o que ainda não chegou ao disco.
		const pending = this.pendingNotifications.pendingSnapshot();
		if (pending.length > 0) {
			const persisted = settings.history.filter(
				(h) => !pending.some((p) => p.id === h.id)
			);
			settings.history = [...pending, ...persisted].slice(0, MAX_HISTORY);
		}
		return settings;
	}

	private handleEvent(
		trigger: NotifiableTrigger,
		payload: Record<string, unknown>,
		allowFeedback = true
	): void {
		const settings = this.readSettings();
		const rule = settings.rules.find((r) => r.trigger === trigger);
		if (!rule || !rule.enabled) return;
		if (this.isWithinDoNotDisturb(settings)) return;

		const message = this.formatMessage(trigger, payload);
		// Numa rajada coalescida, popup/som só no PRIMEIRO item — notificar 200
		// vezes viraria rajada de sons; o histórico registra todos.
		if (allowFeedback) {
			this.showPopup(message, rule.priority);
			if (rule.sound) void this.playSound(rule.priority);
		}
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
	 * Toca um bipe curto. O contexto vem do AudioUnlocker compartilhado: só
	 * toca se já houve gesto do usuário (política de autoplay do Chromium) —
	 * disparo automático antes do primeiro clique sai SEM som (o popup segue;
	 * é a política do navegador, e fingir o contrário era o bug do som mudo).
	 */
	private async playSound(priority: "low" | "normal" | "high"): Promise<void> {
		const audioCtx = this.audioUnlocker.getRunningContext();
		if (!audioCtx) return;
		try {
			// Nós tipados localmente (OscillatorNode/GainNode reais): o unlocker
			// abstrai só o ciclo de vida do contexto, não a síntese.
			const ctx = audioCtx as unknown as AudioContext;
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

	private appendHistory(trigger: NotifiableTrigger, message: string): void {
		const entry: StoredNotification = {
			// randomId (mesmo gerador do núcleo): duas notificações no mesmo
			// milissegundo colidiam com `notif-${Date.now()}` e uma sobrescrevia
			// a outra no "marcar como lida" por id.
			id: `notif-${randomId()}`,
			trigger,
			message,
			timestamp: Date.now(),
			read: false,
		};

		// Write-behind: a leitura (painel) SEMPRE inclui as pendentes — o
		// usuário vê na hora; só o DISCO é que é coalescido. A fila aplica o
		// teto internamente ao confirmar (o flush grava no máximo MAX_HISTORY).
		this.pendingNotifications.enqueue(entry);
		if (!this.flushTimer) {
			this.flushTimer = setTimeout(() => void this.flushNow(), FLUSH_INTERVAL_MS);
		}
	}

	/**
	 * Drena as notificações pendentes num único save (batedor: reset invalida
	 * a geração). O lote sai da fila SÓ no confirm — save falhado é re-tentado
	 * no próximo flush, sem a janela de perda do padrão anterior.
	 */
	private async flushNow(): Promise<void> {
		this.flushTimer = undefined;
		if (this.pendingNotifications.size === 0) return;
		const generation = this.flushGeneration;
		const drain = this.pendingNotifications.takeBatch(MAX_HISTORY);
		if (drain.batch.length === 0) return;

		try {
			const settings = this.readSettings();
			// readSettings JÁ inclui o lote em voo (pendingSnapshot, dedupe por
			// id contra o disco) — merged parte dele, sem reprefixar o batch.
			const merged = settings.history.slice(0, MAX_HISTORY);
			await this.context?.updateSettings({ history: merged });
			if (generation !== this.flushGeneration) {
				// Reset/limpeza aconteceu enquanto o save estava em voo: a fatia
				// limpa no disco acabou de ser sobrescrita — desfaz.
				await this.context?.updateSettings({ history: [] });
			}
			drain.confirm();
		} catch {
			// Save falhou: SEM confirm — o lote segue pendente para o próximo
			// flush re-tentar (a notificação não se perde na variável local).
		}
	}

	async markAllRead(): Promise<void> {
		const settings = this.readSettings();
		const readAll = settings.history.map((h) => ({ ...h, read: true }));
		// As pendentes viram "lidas" também na memória, para o flush não as
		// ressuscitar como não lidas no disco depois. A fila é reconstruída a
		// partir do snapshot (lidas), mantendo quem está em voo em voo — os
		// ids pendentes continuam os mesmos.
		const pendingIds = new Set(
			this.pendingNotifications.pendingSnapshot().map((p) => p.id)
		);
		this.pendingNotifications.clear();
		for (const notification of readAll.filter((h) => pendingIds.has(h.id)).reverse()) {
			this.pendingNotifications.enqueue(notification);
		}
		await this.context?.updateSettings({ history: readAll });
	}
}
