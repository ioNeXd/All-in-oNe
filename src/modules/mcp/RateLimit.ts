/**
 * RATE LIMIT DO MCP — PURO, SEM RELÓGIO E SEM I/O
 * ------------------------------------------------
 * O contador vivia embutido no McpModule e tinha um vício de produto: a
 * cota era consumida NO GATE, antes de permissão/execução — então um cliente
 * agressivo que errava path repetidamente (ou ficava em dry-run) esgotava o
 * limite e bloqueava as ações legítimas de quem segue as regras.
 *
 * Política definida (decisão consciente, não acidente):
 *   - a cota marca INTENÇÃO de executar: é consumida quando a chamada
 *     passa por autenticação, permissões e validação, e vai executar
 *     (ou simular) de fato;
 *   - chamadas negadas ANTES disso (readOnly, pasta bloqueada, ferramenta
 *     desconhecida, rate limit excedido) NÃO consomem cota;
 *   - falha DE EXECUÇÃO (nota não encontrada, trecho ausente etc.) consome —
 *     chegar lá significa que a chamada era legítima.
 *
 * Janela deslizante de 60s, como antes. O relógio é injetado (padrão dos
 * demais módulos puros: regra testável sem mock de Date.now).
 *
 * OPERAÇÃO ATÔMICA (reserve/release):
 *   O padrão antigo wouldAllow() + tryConsume() tinha janela de corrida
 *   entre a pré-checagem e o consumo. O padrão atual:
 *     1. reserve() — checa E consome num passo (retorna null se cheio)
 *     2. passa por validações (readOnly, pasta, etc.)
 *     3. se validação falha → release() devolve o slot
 *     4. se tudo OK → slot já consumido, segue para execução
 */

export const RATE_LIMIT_WINDOW_MS = 60_000;

export interface RateLimiter {
	/** Quantos eventos a mais cabem na janela (0 = bloqueado). */
	remaining(now: number): number;
	/** Registra UM evento e devolve false se a janela já estiver cheia. */
	tryConsume(now: number): boolean;
	/** Devolve um slot previamente consumido (cancelamento pós-reserva). */
	release(ts: number): void;
	/** Eventos válidos na janela (para diagnóstico/painel). */
	count(now: number): number;
}

export function createRateLimiter(limit: number): RateLimiter {
	let timestamps: number[] = [];

	const prune = (now: number): number[] => {
		const windowStart = now - RATE_LIMIT_WINDOW_MS;
		timestamps = timestamps.filter((t) => t > windowStart);
		return timestamps;
	};

	return {
		remaining: (now) => Math.max(0, limit - prune(now).length),
		count: (now) => prune(now).length,
		tryConsume: (now) => {
			if (prune(now).length >= limit) return false;
			timestamps.push(now);
			return true;
		},
		release: (ts: number) => {
			// Remove o timestamp EXATO — cada reservation carrega
			// o seu, nunca remove slot alheio.
			const idx = timestamps.indexOf(ts);
			if (idx !== -1) timestamps.splice(idx, 1);
		},
	};
}

/**
 * Pré-checagem SEM consumir: "caberia esta chamada na cota agora?".
 * Mantida para diagnóstico/painel — NÃO usar no hot path (use reserve).
 */
export function wouldAllow(limiter: RateLimiter, now: number): boolean {
	return limiter.remaining(now) > 0;
}

/**
 * Reserva ATÔMICA: checa E consome num passo só.
 * Se a validação posterior falhar, chame release() para devolver o slot.
 * Elimina a janela de corrida entre wouldAllow() + tryConsume().
 */
export interface Reservation {
	/** Libera o slot reservado (chamado quando validação pós-reserva falha). */
	release(): void;
}

/**
 * Tenta reservar um slot. Se a janela estiver cheia, retorna null.
 * O chamador DEVE chamar release() se decidir não usar o slot.
 */
export function reserve(limiter: RateLimiter, now: number): Reservation | null {
	if (!limiter.tryConsume(now)) return null;
	return { release: () => limiter.release(now) };
}
