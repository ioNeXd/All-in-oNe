import { describe, it, expect } from "vitest";
import {
	createRateLimiter,
	wouldAllow,
	RATE_LIMIT_WINDOW_MS,
} from "../src/modules/mcp/RateLimit";

/**
 * Rate limiter do MCP — puro, relógio injetado. Política: consumo só na
 * execução real (a decisão de QUANDO consumir é do McpModule; aqui testamos
 * o mecanismo da janela).
 */

describe("createRateLimiter — janela deslizante", () => {
	it("aceita até o limite e bloqueia a partir dele", () => {
		const limiter = createRateLimiter(3);
		expect(limiter.tryConsume(0)).toBe(true);
		expect(limiter.tryConsume(1000)).toBe(true);
		expect(limiter.tryConsume(2000)).toBe(true);
		expect(limiter.tryConsume(3000)).toBe(false);
		expect(limiter.count(3000)).toBe(3);
	});

	it("eventos saem da janela após 60s (sliding, não fixed)", () => {
		const limiter = createRateLimiter(2);
		expect(limiter.tryConsume(0)).toBe(true);
		expect(limiter.tryConsume(RATE_LIMIT_WINDOW_MS / 2)).toBe(true);
		// Ainda dentro da janela dos dois: bloqueia.
		expect(limiter.tryConsume(RATE_LIMIT_WINDOW_MS - 1)).toBe(false);
		// O primeiro (t=0) já saiu da janela (t > now-60s falha para t=0):
		expect(limiter.tryConsume(RATE_LIMIT_WINDOW_MS + 1)).toBe(true);
		expect(limiter.count(RATE_LIMIT_WINDOW_MS + 1)).toBe(2);
	});

	it("remaining reflete o espaço disponível na janela", () => {
		const limiter = createRateLimiter(5);
		expect(limiter.remaining(0)).toBe(5);
		limiter.tryConsume(0);
		limiter.tryConsume(1);
		expect(limiter.remaining(2)).toBe(3);
	});

	it("remaining nunca fica negativo mesmo com limit baixo", () => {
		const limiter = createRateLimiter(1);
		limiter.tryConsume(0);
		limiter.tryConsume(1);
		expect(limiter.remaining(2)).toBe(0);
	});

	it("relógio injetado: nada de Date.now interno", () => {
		// Duas instâncias no mesmo instante virtual comportam igual — a regra
		// não depende do relógio real.
		const a = createRateLimiter(1);
		const b = createRateLimiter(1);
		a.tryConsume(42_000);
		b.tryConsume(42_000);
		expect(a.remaining(42_001)).toBe(b.remaining(42_001));
		expect(a.remaining(42_001)).toBe(0);
	});
});

describe("wouldAllow — pré-checagem sem consumir", () => {
	it("true quando há espaço e NÃO registra evento", () => {
		const limiter = createRateLimiter(2);
		expect(wouldAllow(limiter, 0)).toBe(true);
		expect(limiter.count(0)).toBe(0); // nada consumido
	});

	it("false quando a janela está cheia (o gate pode negar cedo)", () => {
		const limiter = createRateLimiter(1);
		limiter.tryConsume(0);
		expect(wouldAllow(limiter, 1)).toBe(false);
	});
});
