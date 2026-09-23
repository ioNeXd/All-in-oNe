import { describe, it, expect } from "vitest";
import {
	AuthThrottle,
	identityOf,
	MAX_AUTH_FAILURES,
	AUTH_WINDOW_MS,
} from "../src/modules/mcp/AuthThrottle";

/**
 * Regras puras do throttle de autenticação do MCP: falhas por identidade em
 * janela deslizante, lockout ANTES da comparação de token, Retry-After e
 * limpeza no sucesso. Relógio injetado — nada de sleeps.
 */

describe("AuthThrottle — janela deslizante e lockout", () => {
	it("tenta sem histórico: permitido", () => {
		const throttle = new AuthThrottle();
		expect(throttle.check("127.0.0.1")).toEqual({ allowed: true });
	});

	it(`até ${MAX_AUTH_FAILURES - 1} falhas: a próxima tentativa AINDA acontece`, () => {
		const throttle = new AuthThrottle();
		for (let i = 0; i < MAX_AUTH_FAILURES - 1; i++) throttle.recordFailure("ip1");
		expect(throttle.check("ip1").allowed).toBe(true);
	});

	it(`após ${MAX_AUTH_FAILURES} falhas na janela, a PRÓXIMA tentativa é bloqueada com Retry-After`, () => {
		let t = 1_000_000;
		const throttle = new AuthThrottle(() => t);
		for (let i = 0; i < MAX_AUTH_FAILURES; i++) {
			throttle.recordFailure("ip1");
			t += 1_000; // 5 falhas espaçadas em 5s
		}
		const decision = throttle.check("ip1");
		expect(decision.allowed).toBe(false);
		expect(decision.retryAfterSeconds).toBeGreaterThan(0);
		expect(decision.retryAfterSeconds!).toBeLessThanOrEqual(AUTH_WINDOW_MS / 1000);
	});

	it("lockout recusa ANTES da comparação de token — e não estica a própria janela", () => {
		let t = 1_000_000;
		const throttle = new AuthThrottle(() => t);
		for (let i = 0; i < MAX_AUTH_FAILURES; i++) throttle.recordFailure("ip1");

		// Tentativas recusadas em lockout não registram falha nova:
		const before = throttle.check("ip1");
		t += 5_000; // avança 5s sob ataque
		const after = throttle.check("ip1");
		expect(before.allowed).toBe(false);
		expect(after.allowed).toBe(false);
		// Retry-After DIMINUI com o tempo (janela drena), não é reiniciada:
		expect(after.retryAfterSeconds!).toBeLessThan(before.retryAfterSeconds!);
	});

	it("janela drena: após AUTH_WINDOW_MS o acesso volta", () => {
		let t = 1_000_000;
		const throttle = new AuthThrottle(() => t);
		for (let i = 0; i < MAX_AUTH_FAILURES; i++) throttle.recordFailure("ip1");
		expect(throttle.check("ip1").allowed).toBe(false);

		t += AUTH_WINDOW_MS + 1;
		expect(throttle.check("ip1")).toEqual({ allowed: true });
	});

	it("sucesso de auth limpa o histórico — um erro humano não pune para sempre", () => {
		const throttle = new AuthThrottle();
		for (let i = 0; i < MAX_AUTH_FAILURES - 1; i++) throttle.recordFailure("ip1");
		// Sem sucesso, a falha seguinte atinge o limite → lockout:
		throttle.recordFailure("ip1");
		expect(throttle.check("ip1").allowed).toBe(false);
		// O token certo chegou: histórico some.
		throttle.recordSuccess("ip1");
		expect(throttle.check("ip1")).toEqual({ allowed: true });
		// Histórico zerado: MAX-1 falhas novas NÃO travam de novo.
		for (let i = 0; i < MAX_AUTH_FAILURES - 1; i++) throttle.recordFailure("ip1");
		expect(throttle.check("ip1").allowed).toBe(true);
	});

	it("identidades são independentes (um atacante não tranca o usuário)", () => {
		const throttle = new AuthThrottle();
		for (let i = 0; i < MAX_AUTH_FAILURES + 3; i++) throttle.recordFailure("atacante");
		expect(throttle.check("atacante").allowed).toBe(false);
		expect(throttle.check("usuario").allowed).toBe(true);
	});

	it("reset() limpa tudo (teardown do servidor)", () => {
		const throttle = new AuthThrottle();
		for (let i = 0; i < MAX_AUTH_FAILURES + 3; i++) throttle.recordFailure("ip1");
		throttle.reset();
		expect(throttle.check("ip1")).toEqual({ allowed: true });
	});

	it("falhas fora da janela não contam para o lockout", () => {
		let t = 1_000_000;
		const throttle = new AuthThrottle(() => t);
		for (let i = 0; i < MAX_AUTH_FAILURES; i++) {
			throttle.recordFailure("ip1");
			t += AUTH_WINDOW_MS + 1_000; // cada falha já expirou quando a próxima vem
		}
		expect(throttle.check("ip1").allowed).toBe(true);
	});
});

describe("identityOf — identidade do request", () => {
	it("usa o remoteAddress do socket", () => {
		expect(identityOf({ socket: { remoteAddress: "127.0.0.1" } })).toBe("127.0.0.1");
	});

	it("sem endereço remoto: undefined (o chamador decide pular o throttle)", () => {
		expect(identityOf({})).toBeUndefined();
		expect(identityOf({ socket: {} })).toBeUndefined();
	});
});
