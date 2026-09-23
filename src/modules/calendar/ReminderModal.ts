import { App, Modal, Setting, TFile } from "obsidian";
import type { CalendarEvent } from "./EventTypes";
import type { AudioUnlocker } from "../../core/AudioUnlock";

/**
 * JANELA DE LEMBRETE
 * -------------------
 * Abre no centro da tela quando um evento chega, com título, descrição e som.
 *
 * Sobre "mesmo com o app minimizado": um plugin roda dentro do processo do
 * Obsidian e não tem API oficial para trazer a janela à frente. O que dá para
 * fazer, e é o que está aqui, usa o Electron por baixo (`remote.getCurrentWindow`):
 *   - `flashFrame(true)` faz o ícone piscar na barra de tarefas do Windows;
 *   - `setAlwaysOnTop` + `show()` trazem a janela à frente quando permitido.
 * Se o Electron não estiver acessível (mobile, versões futuras), o lembrete
 * ainda aparece e toca som assim que a janela voltar ao foco — por isso o
 * código degrada em silêncio em vez de quebrar.
 */
export class ReminderModal extends Modal {
	constructor(
		app: App,
		private event: CalendarEvent,
		private onOpenNote: (path: string) => void | Promise<void>,
		private autoFocus: boolean = false
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("ione-hub-reminder");
		// Por padrão, NÃO força a janela pra frente — só pisca o ícone na
		// barra de tarefas. Forçar o foco espontaneamente atrapalha quem
		// está em outra janela (ex.: jogando). Quem quiser esse comportamento
		// liga "Trazer para frente automaticamente" nas configurações do módulo.
		flashTaskbarIcon();
		if (this.autoFocus) bringWindowToFront();

		this.contentEl.createEl("div", { cls: "ione-hub-reminder__badge", text: "⏰ Lembrete" });
		this.contentEl.createEl("h2", { text: this.event.title });

		if (this.event.description) {
			this.contentEl.createEl("p", {
				cls: "ione-hub-reminder__description",
				text: this.event.description,
			});
		}

		const when = this.event.time
			? `Hoje às ${this.event.time}`
			: `Hoje, ${String(this.event.day).padStart(2, "0")}/${String(this.event.month).padStart(2, "0")}`;
		this.contentEl.createEl("div", { cls: "ione-hub-reminder__when", text: when });

		const actions = new Setting(this.contentEl);
		if (this.event.noteRefId) {
			actions.addButton((btn) =>
				btn
					.setButtonText("Abrir nota")
					.setCta()
					.onClick(async () => {
						await this.onOpenNote(this.event.noteRefId!);
						this.close();
					})
			);
		}
		actions.addButton((btn) =>
			btn
				.setButtonText("Ok, entendi")
				.setCta()
				.onClick(() => this.close())
		);
	}

	onClose(): void {
		stopFlashing();
		this.contentEl.empty();
	}
}

/** Só pisca o ícone na barra de tarefas — comportamento padrão, não invasivo. */
export function flashTaskbarIcon(): void {
	const win = getElectronWindow();
	if (!win) return;
	try {
		if (!win.isFocused?.()) win.flashFrame?.(true);
	} catch {
		/* sem Electron disponível — sem problema, o lembrete ainda existe dentro do app */
	}
}

/** Traz a janela pra frente à força — só quando o usuário ligou essa opção. */
export function bringWindowToFront(): void {
	const win = getElectronWindow();
	if (!win) return;
	try {
		if (win.isMinimized?.()) win.restore?.();
		win.show?.();
		win.setAlwaysOnTop?.(true);
		window.setTimeout(() => win.setAlwaysOnTop?.(false), 1500);
	} catch {
		/* ignorado de propósito */
	}
}

export function stopFlashing(): void {
	try {
		getElectronWindow()?.flashFrame?.(false);
	} catch {
		/* ignorado de propósito */
	}
}

interface ElectronWindowLike {
	isFocused?: () => boolean;
	isMinimized?: () => boolean;
	restore?: () => void;
	show?: () => void;
	flashFrame?: (flag: boolean) => void;
	setAlwaysOnTop?: (flag: boolean) => void;
}

function getElectronWindow(): ElectronWindowLike | null {
	try {
		// O Obsidian desktop roda em Electron; no mobile isto simplesmente não existe.
		const electron = (window as unknown as { require?: (m: string) => unknown }).require?.("electron");
		const remote = (electron as { remote?: { getCurrentWindow?: () => ElectronWindowLike } })?.remote;
		return remote?.getCurrentWindow?.() ?? null;
	} catch {
		return null;
	}
}

/**
 * Som do lembrete: sequência de três notas, mais audível que um bipe só.
 * O contexto vem do AudioUnlocker COMPARTILHADO (core/AudioUnlock.ts) — o
 * lembrete dispara sozinho (relógio/evento), sem gesto na hora: sem o
 * destravamento por clique armado no onEnable do módulo, o contexto novo
 * nasceria suspenso e o `resume()` falharia em silêncio (popup mudo).
 * Sem gesto ainda → sem som (o popup segue; é a política do navegador).
 */
export async function playReminderChime(unlocker: AudioUnlocker): Promise<void> {
	const audioCtx = unlocker.getRunningContext();
	if (!audioCtx) return;
	try {
		const ctx = audioCtx as unknown as AudioContext;

		const notes = [659.25, 783.99, 1046.5]; // mi, sol, dó
		notes.forEach((frequency, index) => {
			const start = ctx.currentTime + index * 0.18;
			const osc = ctx.createOscillator();
			const gain = ctx.createGain();
			osc.type = "sine";
			osc.frequency.value = frequency;
			osc.connect(gain);
			gain.connect(ctx.destination);
			gain.gain.setValueAtTime(0.0001, start);
			gain.gain.exponentialRampToValueAtTime(0.25, start + 0.02);
			gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.35);
			osc.start(start);
			osc.stop(start + 0.4);
		});
		// SEM ctx.close(): o contexto é compartilhado (Notificações + Calendário)
		// — fechá-lo mataria o som do próximo módulo que tocar.
	} catch (err) {
		console.warn("[All iₙ oNe] Não foi possível tocar o som do lembrete:", err);
	}
}

export async function openNoteByPath(app: App, path: string): Promise<void> {
	const file = app.vault.getAbstractFileByPath(path);
	if (file instanceof TFile) {
		await app.workspace.getLeaf(false).openFile(file);
	}
}
