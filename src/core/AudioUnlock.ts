/**
 * DESBLOQUEIO DE ÁUDIO (POLÍTICA DE AUTOPLAY DO CHROMIUM)
 * -----------------------------------------------------------
 * O AudioContext nasce "suspended" e o Chromium só permite que ele entre em
 * "running" após um GESTO do usuário na janela (clique, tecla). Notificação
 * e lembrete disparam SOZINHOS (evento no vault, relógio) — sem gesto na
 * hora — então o `resume()` no momento do disparo frequentemente falha em
 * silêncio: o popup aparece, o som não. Parece notificação quebrada.
 *
 * Estratégia (o mesmo remédio dos players web):
 *  - ARMAR ouvintes de gesto (pointerdown/keydown) logo no onEnable;
 *  - no PRIMEIRO gesto, criar/resumir o contexto — destravado para o resto
 *    da sessão (contexto permanece válido; criar um por disparo não destrava:
 *    o novo também nasce suspenso);
 *  - disparos ANTES do primeiro gesto tocam sem som (o popup segue) — não há
 *    como violar a política do navegador, e fingir o contrário é o bug.
 *
 * Determinístico e testável: DOM injetado por options; default é o `window`
 * real. Um único unlocker por plugin (compartilhado entre Notificações e
 * Calendário — dois contextos disputando o destravamento é corrida à toa).
 */

/**
 * A fatia do AudioContext que o código de som usa — os nós de síntese entram
 * como `unknown` porque cada chamador modela os seus (oscillator/gain aqui,
 * sequência de notas no chime). O estado/resume é o que importa para o
 * destravamento.
 */
export interface AudioContextLike {
	state: "suspended" | "running" | "closed" | string;
	readonly currentTime: number;
	readonly destination: unknown;
	createOscillator(): unknown;
	createGain(): unknown;
	resume(): Promise<void>;
}

export type AudioContextFactory = () => AudioContextLike;

export interface GestureSource {
	addEventListener(type: string, listener: () => void, options?: { once?: boolean }): void;
	removeEventListener(type: string, listener: () => void): void;
}

/** Gestos que o Chromium aceita como desbloqueio de áudio. */
const GESTURE_EVENTS = ["pointerdown", "keydown"] as const;

export class AudioUnlocker {
	private context?: AudioContextLike;
	private armed = false;
	private unlocked = false;
	private listeners = new Map<string, () => void>();

	constructor(
		private readonly create: AudioContextFactory = () => new AudioContext(),
		private readonly source?: GestureSource
	) {}

	/**
	 * Arma os ouvintes de gesto (idempotente). Chamado no onEnable — a janela
	 * do Obsidian quase sempre já recebe um clique antes do primeiro lembrete
	 * (o usuário clicou num painel, digitou…), então o destravamento acontece
	 * naturalmente cedo.
	 */
	arm(): void {
		if (this.armed || this.unlocked) return;
		// Saneamento: listeners residuais (arm duplicado ou sobra do once) são
		// removidos antes de re-registrar — nunca dois listeners do mesmo tipo.
		this.removeListeners();
		const target = this.source ?? (typeof window !== "undefined" ? window : undefined);
		if (!target) return;
		for (const type of GESTURE_EVENTS) {
			const listener = () => {
				// O PRIMEIRO gesto de qualquer tipo destrava; os irmãos (once do
				// outro tipo) seriam órfãos — remove na mão, sem depender do DOM.
				void this.unlock();
			};
			this.listeners.set(type, listener);
			target.addEventListener(type, listener, { once: true });
		}
		this.armed = true;
	}

	/**
	 * Força o destravamento AGORA — para o caminho com gesto garantido
	 * (botão "Testar notificação", comando da Paleta): o clique do usuário
	 * É o gesto que a política exige.
	 */
	async unlock(): Promise<boolean> {
		this.disarm();
		try {
			if (!this.context || this.context.state === "closed") {
				this.context = this.create();
			}
			if (this.context.state === "suspended") {
				await this.context.resume();
			}
			this.unlocked = this.context.state === "running";
			return this.unlocked;
		} catch {
			this.unlocked = false;
			return false;
		}
	}

	/** Houve gesto do usuário e o contexto está tocável? */
	isUnlocked(): boolean {
		return this.unlocked;
	}

	/**
	 * Contexto pronto para TOCAR, ou undefined. Um disparo automático antes
	 * do primeiro gesto recebe undefined — o chamador toca o popup sem som
	 * (e sem tentar resume() que não vai sair: a tentativa não falha ruidosa,
	 * mas também não conserta nada e atrasa o som do próximo disparo).
	 */
	getRunningContext(): AudioContextLike | undefined {
		return this.unlocked && this.context && this.context.state === "running"
			? this.context
			: undefined;
	}

	/**
	 * Desarma os ouvintes (onDisable). O contexto NÃO é fechado — destravado,
	 * ele sobrevive ao desligar/ligar do módulo (fechar e recriar devolveria
	 * o contexto ao estado suspenso, sem novo gesto).
	 */
	disarm(): void {
		if (!this.armed) return;
		this.removeListeners();
		this.armed = false;
	}

	private removeListeners(): void {
		const target = this.source ?? (typeof window !== "undefined" ? window : undefined);
		if (target) {
			for (const [type, listener] of this.listeners) {
				target.removeEventListener(type, listener);
			}
		}
		this.listeners.clear();
	}
}
