import { describe, it, expect, vi } from "vitest";
import { EventBus } from "../src/core/EventBus";

describe("EventBus", () => {
	it("entrega um evento para todos os inscritos", async () => {
		const bus = new EventBus();
		const received: unknown[] = [];
		bus.on("test:event", "mod-a", (e) => received.push(e.payload));
		bus.on("test:event", "mod-b", (e) => received.push(e.payload));

		await bus.emit("test:event", { value: 42 }, "mod-a");

		expect(received).toEqual([{ value: 42 }, { value: 42 }]);
	});

	it("isola falhas: um handler que lança erro não impede os outros de rodar", async () => {
		const bus = new EventBus();
		const calledOrder: string[] = [];

		bus.on("test:event", "mod-a", () => {
			calledOrder.push("a");
			throw new Error("boom");
		});
		bus.on("test:event", "mod-b", () => {
			calledOrder.push("b");
		});

		await bus.emit("test:event", {}, "mod-a");

		expect(calledOrder).toEqual(["a", "b"]);
	});

	it("offAll remove todas as inscrições de um módulo", async () => {
		const bus = new EventBus();
		const handler = vi.fn();
		bus.on("test:event", "mod-a", handler);
		bus.offAll("mod-a");

		await bus.emit("test:event", {}, "core");

		expect(handler).not.toHaveBeenCalled();
	});

	it("throttle descarta emissões repetidas dentro da janela", async () => {
		const bus = new EventBus();
		const handler = vi.fn();
		bus.on("vault:modify", "mod-a", handler);
		bus.setThrottle("vault:modify", 10_000);

		await bus.emit("vault:modify", {}, "mod-a");
		await bus.emit("vault:modify", {}, "mod-a");

		expect(handler).toHaveBeenCalledTimes(1);
	});

	it("mantém histórico consultável por nome e origem", async () => {
		const bus = new EventBus();
		await bus.emit("a", {}, "mod-a");
		await bus.emit("b", {}, "mod-b");

		expect(bus.getHistory({ eventName: "a" })).toHaveLength(1);
		expect(bus.getHistory({ source: "mod-b" })).toHaveLength(1);
		expect(bus.getHistory()).toHaveLength(2);
	});
});
