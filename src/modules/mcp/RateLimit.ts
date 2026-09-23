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
 */

export const RATE_LIMIT_WINDOW_MS = 60_000;

export interface RateLimiter {
	/** Quantos eventos a mais cabem na janela (0 = bloqueado). */
	remaining(now: number): number;
	/** Registra UM evento e devolve false se a janela já estiver cheia. */
	tryConsume(now: number): boolean;
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
	};
}

/**
 * Pré-checagem SEM consumir: "caberia esta chamada na cota agora?".
 * Serve para negar cedo (com o erro certo) quando a janela já está cheia,
 * sem penalizar a fila por uma chamada que nem passaria nas permissões.
 */
export function wouldAllow(limiter: RateLimiter, now: number): boolean {
	return limiter.remaining(now) > 0;
}
