import { describe, it, expect, vi } from "vitest";
import { CommandBridge } from "../src/core/CommandBridge";
import type { ModuleId } from "../src/core/ModuleContract";

/**
 * Testes da PONTE DE COMANDOS contra o código real (extraída do main.ts —
 * antes era lógica inline impossível de testar). Ela é a fronteira entre o
 * ciclo de vida dos módulos e o Command Palette do Obsidian: os dois furos
 * que ela fecha (comando vivo com módulo desligado; duplicação a cada
 * liga/desliga) moram exatamente aqui.
 */

interface FakeCommand {
	id: string;
	name: string;
	checkCallback: (checking: boolean) => boolean;
}

function makeBridge(enabled: ModuleId[] = ["mcp"]) {
	const commands: FakeCommand[] = [];
	const enabledSet = new Set<ModuleId>(enabled);
	const bridge = new CommandBridge(
		(cmd) => {
			commands.push(cmd);
			return cmd.id;
		},
		(id) => enabledSet.has(id)
	);
	return {
		bridge,
		commands,
		setEnabled: (id: ModuleId, on: boolean) =>
			on ? enabledSet.add(id) : enabledSet.delete(id),
	};
}

describe("CommandBridge — registro único", () => {
	it("primeiro registro cria o comando no Obsidian", () => {
		const { bridge, commands } = makeBridge();
		bridge.registerCommand("mcp", "restart", "MCP: Reiniciar servidor", () => {});

		expect(commands).toHaveLength(1);
		expect(commands[0].id).toBe(JSON.stringify(["mcp", "restart"]));
		expect(commands[0].name).toBe("MCP: Reiniciar servidor");
		expect(bridge.size).toBe(1);
	});

	it("religar o módulo (re-registro do mesmo comando) NÃO duplica a entrada no plugin", () => {
		const { bridge, commands } = makeBridge();
		bridge.registerCommand("mcp", "restart", "MCP: Reiniciar servidor", () => {});
		bridge.registerCommand("mcp", "restart", "MCP: Reiniciar servidor", () => {}); // 2º onEnable
		bridge.registerCommand("mcp", "restart", "MCP: Reiniciar servidor", () => {}); // 3º onEnable

		expect(commands).toHaveLength(1); // addCommand rodou UMA vez
		expect(bridge.size).toBe(1);
	});

	it("comandos DIFERENTES do mesmo módulo e de módulos distintos convivem", () => {
		const { bridge, commands } = makeBridge();
		bridge.registerCommand("mcp", "restart", "MCP: Reiniciar", () => {});
		bridge.registerCommand("mcp", "test", "MCP: Testar", () => {});
		bridge.registerCommand("calendar", "today", "Calendário: Hoje", () => {});

		expect(commands.map((c) => c.id)).toEqual([
			JSON.stringify(["mcp", "restart"]),
			JSON.stringify(["mcp", "test"]),
			JSON.stringify(["calendar", "today"]),
		]);
	});
});

describe("CommandBridge — checkCallback (ciclo de vida)", () => {
	it("com módulo LIGADO: check retorna true e o callback roda", () => {
		const { bridge, commands } = makeBridge(["mcp"]);
		const action = vi.fn();
		bridge.registerCommand("mcp", "restart", "MCP: Reiniciar", action);

		expect(commands[0].checkCallback(true)).toBe(true); // modo "checking"
		expect(action).not.toHaveBeenCalled(); // checking não executa

		expect(commands[0].checkCallback(false)).toBe(true); // execução real
		expect(action).toHaveBeenCalledTimes(1);
	});

	it("com módulo DESLIGADO: check retorna false e o callback NUNCA roda", () => {
		const { bridge, commands, setEnabled } = makeBridge(["mcp"]);
		const action = vi.fn();
		bridge.registerCommand("mcp", "restart", "MCP: Reiniciar", action);

		setEnabled("mcp", false); // usuário desligou o módulo pelo Lobby

		// É a regressão da Rodada 12: sem o checkCallback, invocar o comando
		// com o módulo desligado reabria o servidor FORA do ciclo de vida.
		expect(commands[0].checkCallback(true)).toBe(false);
		expect(commands[0].checkCallback(false)).toBe(false);
		expect(action).not.toHaveBeenCalled();
	});

	it("desligar e religar o módulo: comando volta a funcionar, sem novo registro", () => {
		const { bridge, commands, setEnabled } = makeBridge(["mcp"]);
		const action = vi.fn();
		bridge.registerCommand("mcp", "restart", "MCP: Reiniciar", action);

		setEnabled("mcp", false);
		expect(commands[0].checkCallback(false)).toBe(false);

		setEnabled("mcp", true); // religar não chama registerCommand de novo nos testes,
		// mas o checkCallback consulta o estado ATUAL do núcleo:
		expect(commands[0].checkCallback(false)).toBe(true);
		expect(action).toHaveBeenCalledTimes(1);
		expect(commands).toHaveLength(1); // e nunca houve duplicação
	});
});

describe("CommandBridge — callback sempre o MAIS RECENTE", () => {
	it("re-registro atualiza o callback executado (o closure vivo, não o da 1ª ativação)", () => {
		const { bridge, commands } = makeBridge(["mcp"]);
		const first = vi.fn();
		const second = vi.fn();

		bridge.registerCommand("mcp", "restart", "MCP: Reiniciar", first);
		bridge.registerCommand("mcp", "restart", "MCP: Reiniciar", second); // 2º onEnable

		commands[0].checkCallback(false); // executa

		expect(first).not.toHaveBeenCalled(); // callback velho NUNCA roda
		expect(second).toHaveBeenCalledTimes(1);
	});
});

describe("CommandBridge — chave sem colisão (JSON.stringify)", () => {
	it("moduleId='a', cmdId='b-c' ≠ moduleId='a-b', cmdId='c'", () => {
		const { bridge } = makeBridge(["a", "a-b"]);
		bridge.registerCommand("a", "b-c", "Cmd A", () => {});
		bridge.registerCommand("a-b", "c", "Cmd B", () => {});

		expect(bridge.size).toBe(2); // duas entradas distintas
		expect(bridge.has("a", "b-c")).toBe(true);
		expect(bridge.has("a-b", "c")).toBe(true);
		expect(bridge.has("a", "c")).toBe(false); // não há colisão
	});
});
