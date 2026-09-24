import type { App } from "obsidian";
import { describe, it, expect, vi } from "vitest";
import { HubCore } from "../src/core/HubCore";
import { makeTestModule } from "./helpers";
import { createDefaultSettings } from "../src/core/types";

/**
 * Isolamento do onRegister: se um módulo lança no onRegister, ele fica
 * registrado mas não habilitado; o erro é emitido no bus; os demais
 * módulos são registrados e habilitados normalmente.
 */

function makeCore(enabledModules: string[] = []) {
	let stored = createDefaultSettings();
	stored.enabledModules = enabledModules as any;
	const core = new HubCore(
		{} as App,
		async () => stored,
		async (data) => { stored = data; }
	);
	return { core };
}

describe("HubCore — onRegister: falha não impede módulos subsequentes", () => {
	it("módulo A falha no onRegister; módulo B é registrado e habilitado", async () => {
		const { core } = makeCore(["mcp", "history"]);
		await core.init();

		// Módulo A: onRegister lança
		const moduleA = makeTestModule({
			id: "mcp",
			onRegister: () => { throw new Error("A explodiu no onRegister"); },
			onEnable: vi.fn(),
		});

		// Módulo B: onRegister e onEnable normais
		const onEnableB = vi.fn();
		const moduleB = makeTestModule({
			id: "history",
			onEnable: onEnableB,
		});

		// Registrar ambos
		await core.registerModule(moduleA);
		await core.registerModule(moduleB);

		// B foi registrado e habilitado
		expect(onEnableB).toHaveBeenCalledTimes(1);
		expect(core.isModuleEnabled("history")).toBe(true);

		// A ficou registrado mas NÃO habilitado
		expect(core.isModuleEnabled("mcp")).toBe(false);
	});

	it("erro de onRegister em A é emitido no bus como core:module-error", async () => {
		const { core } = makeCore(["mcp"]);
		await core.init();

		const errors: unknown[] = [];
		core.bus.on("core:module-error", "test", (e) => errors.push(e.payload));

		await core.registerModule(
			makeTestModule({
				id: "mcp",
				onRegister: () => { throw new Error("falha"); },
			})
		);

		expect(errors).toHaveLength(1);
		const payload = errors[0] as { moduleId: string; eventName: string; error: string };
		expect(payload.moduleId).toBe("mcp");
		expect(payload.eventName).toBe("onRegister");
		expect(payload.error).toContain("falha");
	});

	it("após onRegister falhar, lastEnableError registra a mensagem", async () => {
		const { core } = makeCore(["mcp"]);
		await core.init();

		await core.registerModule(
			makeTestModule({
				id: "mcp",
				onRegister: () => { throw new Error("boom"); },
			})
		);

		expect(core.getLastEnableError("mcp")).toContain("boom");
	});
});
