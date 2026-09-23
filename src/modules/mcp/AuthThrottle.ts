/**
 * THROTTLE DE AUTENTICAÇÃO DO MCP — REGRAS PURAS
 * -----------------------------------------------------------
 * O check do Bearer no server.ts responde 401 e nada mais: um brute force
 * LOCAL do token não é freado (o rate limit de ações do McpModule conta só
 * tools/call AUTENTICADAS — auth falha nem chega lá). Com o servidor preso
 * a 127.0.0.1 o risco é baixo, mas o custo do freio é zero e o token, embora
 * agora gerado por CSPRNG (#17), vale proteger na borda.
 *
 * Política:
 *  - Falha de auth registra um evento por IDENTIDADE (IP) numa janela
 *    deslizante. Acima de MAX_FAILURES dentro da janela → LOCKOUT: toda
 *    tentativa é recusada DE ANTES (nem tenta comparar token) até a janela
 *    esvaziar; a resposta carrega Retry-After em segundos.
 *  - SUCESSO de auth limpa o histórico da identidade: o usuário real que
 *    errou o token uma vez não carrega punição permanente.
 *  - Relógio injetado (Date.now como default) — determinístico em teste.
 *  - Identidade é o IP remoto (raw socket; em 127.0.0.1 sempre o mesmo, que
 *    é exatamente o caso a frear). Sem IP (socket sem endereço), usa uma
 *    chave única — falha anônima não contamina os demais.
 */

/** Falhas consecutivas toleradas dentro da janela antes do lockout. */
export const MAX_AUTH_FAILURES = 5;

/** Janela deslizante de falhas — o lockout dura o que restar da janela. */
export const AUTH_WINDOW_MS = 60_000;

export interface AuthDecision {
	/** false = recusar ANTES de comparar o token (401/429 na borda). */
	allowed: boolean;
	/** Só no lockout: segundos restantes para o Retry-After (arredondado p/ cima). */
	retryAfterSeconds?: number;
}

interface IdentityState {
	/** Epoch ms das falhas ainda dentro da janela. */
	failures: number[];
}

export class AuthThrottle {
	private states = new Map<string, IdentityState>();

	constructor(
		private readonly now: () => number = () => Date.now(),
		private readonly maxFailures: number = MAX_AUTH_FAILURES,
		private readonly windowMs: number = AUTH_WINDOW_MS
	) {}

	/**
	 * Consulta ANTES da verificação de token: em lockout, a tentativa é
	 * recusada sem sequer comparar o Bearer (e SEM registrar falha nova —
	 * recusas de lockout não esticam a janela).
	 */
	check(identity: string): AuthDecision {
		const state = this.states.get(identity);
		if (!state) return { allowed: true };
		this.prune(state);
		if (state.failures.length >= this.maxFailures) {
			// Fim do lockout = expiração da falha mais antiga da janela.
			const oldest = state.failures[0];
			const retryAfterSeconds = Math.max(1, Math.ceil((oldest + this.windowMs - this.now()) / 1000));
			return { allowed: false, retryAfterSeconds };
		}
		return { allowed: true };
	}

	/** Registra uma falha de auth (token inválido/ausente com token esperado). */
	recordFailure(identity: string): void {
		let state = this.states.get(identity);
		if (!state) {
			state = { failures: [] };
			this.states.set(identity, state);
		}
		this.prune(state);
		state.failures.push(this.now());
	}

	/** Sucesso de auth: histórico da identidade some (erros humanos se apagam). */
	recordSuccess(identity: string): void {
		this.states.delete(identity);
	}

	/** Teardown (server close / disable do módulo): limpa todo o estado. */
	reset(): void {
		this.states.clear();
	}

	private prune(state: IdentityState): void {
		const cutoff = this.now() - this.windowMs;
		state.failures = state.failures.filter((t) => t > cutoff);
	}
}

/**
 * Extrai a identidade do request para o throttle. O servidor escuta em
 * 127.0.0.1 — o IP remoto é o único identificador barato e sempre presente
 * (proxying não se aplica: não há rede externa na escuta). Sem endereço
 * remoto (caso patológico do socket), devolve undefined — o chamador decide
 * (aqui: pular o throttle em vez de punir todo mundo por uma chave comum).
 */
export function identityOf(req: { socket?: { remoteAddress?: string } }): string | undefined {
	return req.socket?.remoteAddress || undefined;
}
