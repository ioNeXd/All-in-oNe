/**
 * EVENT BUS
 * ---------
 * Canal central de comunicação entre módulos. Nenhum módulo importa outro
 * módulo diretamente — eles só emitem (`emit`) e escutam (`on`) eventos por
 * aqui. Isso é o que permite, por exemplo, que o módulo de Notificações
 * reaja a um evento emitido pelo módulo de Templates sem que Templates saiba
 * que Notificações existe.
 *
 * GARANTIAS DE ROBUSTEZ (requisitos técnicos definidos na fase de design):
 *   - Isolamento de falhas: se um handler lançar uma exceção, ela é
 *     capturada e logada, mas NUNCA impede os outros handlers do mesmo
 *     evento de rodar, nem derruba o bus inteiro.
 *   - Debounce/throttle: eventos de alta frequência (ex.: um vault grande
 *     gerando muitos `vault:modify` em sequência) podem ser emitidos com
 *     throttle para não sobrecarregar listeners caros (Histórico, Notificações).
 *   - Histórico embutido: mantém um buffer circular dos últimos N eventos,
 *     usado pela "Central de Eventos" (debug) e pela aba de Histórico do Lobby.
 */

export type HubEventName = string;

export interface HubEvent<T = unknown> {
	name: HubEventName;
	payload: T;
	timestamp: number;
	source: string; // moduleId de quem emitiu, ou "core"
}

type Handler<T = unknown> = (event: HubEvent<T>) => void | Promise<void>;

interface Subscription {
	handler: Handler;
	moduleId: string;
}

const DEFAULT_HISTORY_LIMIT = 500;

export class EventBus {
	private subscriptions = new Map<HubEventName, Subscription[]>();
	private history: HubEvent[] = [];
	private historyLimit = DEFAULT_HISTORY_LIMIT;
	private throttleWindows = new Map<HubEventName, number>(); // ms
	private lastEmitAt = new Map<string, number>(); // chave: eventName+source

	/** Escuta um evento. Retorna uma função para cancelar a escuta (cleanup). */
	on<T = unknown>(eventName: HubEventName, moduleId: string, handler: Handler<T>): () => void {
		const list = this.subscriptions.get(eventName) ?? [];
		const subscription: Subscription = { handler: handler as Handler, moduleId };
		list.push(subscription);
		this.subscriptions.set(eventName, list);

		return () => {
			const current = this.subscriptions.get(eventName);
			if (!current) return;
			this.subscriptions.set(
				eventName,
				current.filter((s) => s !== subscription)
			);
		};
	}

	/** Remove todas as inscrições de um módulo específico — chamado em onDisable. */
	offAll(moduleId: string): void {
		for (const [eventName, list] of this.subscriptions.entries()) {
			this.subscriptions.set(
				eventName,
				list.filter((s) => s.moduleId !== moduleId)
			);
		}
	}

	/**
	 * Define uma janela de throttle (ms) para um evento específico. Emissões
	 * do mesmo evento dentro dessa janela são descartadas. Usado para eventos
	 * de alta frequência como escrita de arquivo em vaults grandes.
	 */
	setThrottle(eventName: HubEventName, windowMs: number): void {
		this.throttleWindows.set(eventName, windowMs);
	}

	async emit<T = unknown>(eventName: HubEventName, payload: T, source: string): Promise<void> {
		const throttleKey = `${eventName}:${source}`;
		const windowMs = this.throttleWindows.get(eventName);
		if (windowMs) {
			const last = this.lastEmitAt.get(throttleKey) ?? 0;
			const now = Date.now();
			if (now - last < windowMs) {
				return; // descartado por throttle
			}
			this.lastEmitAt.set(throttleKey, now);
		}

		const event: HubEvent<T> = {
			name: eventName,
			payload,
			timestamp: Date.now(),
			source,
		};

		this.pushHistory(event as HubEvent);

		const list = this.subscriptions.get(eventName);
		if (!list || list.length === 0) return;

		// Cada handler roda isolado — uma exceção em um não afeta os outros.
		for (const { handler, moduleId } of [...list]) {
			try {
				await handler(event);
			} catch (err) {
				console.error(
					`[All iₙ oNe] Módulo "${moduleId}" falhou ao tratar o evento "${eventName}":`,
					err
				);
				// Emite um evento de erro próprio, para que o módulo de
				// Notificações/Histórico (se estiverem escutando) possam
				// avisar o usuário sem que isso vire um loop recursivo.
				if (eventName !== "core:module-error") {
					void this.emit(
						"core:module-error",
						{ moduleId, eventName, error: String(err) },
						"core"
					);
				}
			}
		}
	}

	private pushHistory(event: HubEvent): void {
		this.history.push(event);
		if (this.history.length > this.historyLimit) {
			this.history.shift();
		}
	}

	getHistory(filter?: { eventName?: string; source?: string }): HubEvent[] {
		if (!filter) return [...this.history];
		return this.history.filter(
			(e) =>
				(!filter.eventName || e.name === filter.eventName) &&
				(!filter.source || e.source === filter.source)
		);
	}

	clearHistory(): void {
		this.history = [];
	}

	getHistoryLimit(): number {
		return this.historyLimit;
	}

	setHistoryLimit(limit: number): void {
		this.historyLimit = Math.max(10, Math.floor(limit));
		if (this.history.length > this.historyLimit) {
			this.history = this.history.slice(-this.historyLimit);
		}
	}
}
