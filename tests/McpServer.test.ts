import { afterAll, describe, it, expect } from "vitest";
import {
	createMcpServer,
	type McpServerHandle,
	TOOLS_API_INCOMPATIBLE,
} from "../src/modules/mcp/server";

/**
 * Teste de INTEGRAÇÃO do servidor MCP: HTTP de verdade, escutando em porta
 * efêmera (port: 0 — o SO escolhe; o handle expõe a porta real). Cobre o
 * handshake do protocolo MCP, que clientes reais (Claude Desktop, Cursor)
 * executam ANTES de listar ferramentas — sem isto, a conexão morria no
 * primeiro passo.
 */

const handles: McpServerHandle[] = [];

async function start(toolsApiVersion = "1.0.0"): Promise<McpServerHandle> {
	const handle = await createMcpServer({
		port: 0, // efêmera: sem colisão entre execuções
		getToken: () => "tok",
		serverInfo: { name: "All iₙ oNe", version: "0.1.0" },
		getToolsApiVersion: () => toolsApiVersion,
		handleToolCall: async (toolName) => ({
			ok: true,
			result: { eco: toolName },
		}),
	});
	handles.push(handle);
	return handle;
}

function post(port: number, body: unknown, token = "tok") {
	return fetch(`http://127.0.0.1:${port}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${token}`,
		},
		body: JSON.stringify(body),
	});
}

afterAll(async () => {
	for (const h of handles) await h.stop();
});

describe("MCP — handshake do protocolo (initialize + notificações)", () => {
	it("initialize responde protocolVersion (ecoando a pedida), capabilities e serverInfo", async () => {
		const h = await start();
		const res = await post(h.port, {
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: { protocolVersion: "2025-03-26", clientInfo: { name: "teste" } },
		});
		expect(res.status).toBe(200);
		const json = (await res.json()) as {
			jsonrpc: string;
			id: number;
			result: { protocolVersion: string; capabilities: object; serverInfo: object };
		};
		expect(json.jsonrpc).toBe("2.0");
		expect(json.id).toBe(1);
		expect(json.result.protocolVersion).toBe("2025-03-26"); // ecoa a do cliente
		expect(json.result.capabilities).toHaveProperty("tools");
		expect(json.result.serverInfo).toEqual({ name: "All iₙ oNe", version: "0.1.0" });
	});

	it("initialize sem protocolVersion no pedido responde a versão mais recente suportada", async () => {
		const h = await start();
		const res = await post(h.port, { jsonrpc: "2.0", id: 2, method: "initialize" });
		const json = (await res.json()) as { result: { protocolVersion: string } };
		expect(res.status).toBe(200);
		expect(typeof json.result.protocolVersion).toBe("string");
		expect(json.result.protocolVersion.length).toBeGreaterThan(0);
	});

	it("notificação (sem id — notifications/initialized) responde 202 sem corpo", async () => {
		const h = await start();
		const res = await post(h.port, {
			jsonrpc: "2.0",
			method: "notifications/initialized",
		});
		expect(res.status).toBe(202);
		expect(await res.text()).toBe("");
	});

	it("o fluxo completo do cliente real funciona: initialize → initialized → tools/list", async () => {
		const h = await start();
		const init = await post(h.port, {
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: { protocolVersion: "2025-06-18" },
		});
		expect(init.status).toBe(200);

		const initialized = await post(h.port, {
			jsonrpc: "2.0",
			method: "notifications/initialized",
		});
		expect(initialized.status).toBe(202); // antes: respondError quebrava o handshake

		const list = await post(h.port, { jsonrpc: "2.0", id: 3, method: "tools/list" });
		expect(list.status).toBe(200);
		const json = (await list.json()) as { result: { tools: { name: string }[] } };
		expect(json.result.tools.length).toBeGreaterThan(0);
		expect(json.result.tools.some((t) => t.name === "read_note")).toBe(true);
	});

	it("requisições normais continuam com resposta JSON-RPC (regressão do caminho com id)", async () => {
		const h = await start();
		const res = await post(h.port, {
			jsonrpc: "2.0",
			id: 9,
			method: "tools/call",
			params: { name: "read_note", arguments: { path: "x.md" } },
		});
		expect(res.status).toBe(200);
		const json = (await res.json()) as { id: number; result: { content: unknown } };
		expect(json.id).toBe(9);
		expect(json.result.content).toEqual({ eco: "read_note" });
	});
});

describe("MCP — negociação da versão da API de ferramentas", () => {
	it("initialize devolve a toolsApiVersion do servidor mesmo sem o cliente pedir", async () => {
		const h = await start("1.2.3");
		const res = await post(h.port, { jsonrpc: "2.0", id: 1, method: "initialize" });
		const json = (await res.json()) as { result: { toolsApiVersion: string } };
		expect(res.status).toBe(200);
		expect(json.result.toolsApiVersion).toBe("1.2.3");
	});

	it("cliente compatível (mesma versão) completa o handshake e recebe a lista de ferramentas", async () => {
		const h = await start("1.0.0");
		const init = await post(h.port, {
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: { protocolVersion: "2025-06-18", toolsApiVersion: "1.0.0" },
		});
		const initJson = (await init.json()) as { result: { toolsApiVersion: string } };
		expect(init.status).toBe(200);
		expect(initJson.result.toolsApiVersion).toBe("1.0.0"); // ecoa a pedida

		const list = await post(h.port, { jsonrpc: "2.0", id: 2, method: "tools/list" });
		const listJson = (await list.json()) as { result: { tools: { name: string }[] } };
		expect(listJson.result.tools.some((t) => t.name === "put_attachment")).toBe(true);
		expect(listJson.result.tools.some((t) => t.name === "delete_attachment")).toBe(true);
		expect(listJson.result.tools.some((t) => t.name === "get_server_info")).toBe(true);
	});

	it("minor maior dentro do mesmo major é aceito (1.9.0 contra servidor 1.0.0)", async () => {
		const h = await start("1.0.0");
		const res = await post(h.port, {
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: { toolsApiVersion: "1.9.0" },
		});
		const json = (await res.json()) as { result: { toolsApiVersion: string } };
		expect(res.status).toBe(200);
		expect(json.result.toolsApiVersion).toBe("1.9.0");
	});

	it("major incompatível (2.0.0 contra servidor 1.0.0) recebe erro claro com código dedicado", async () => {
		const h = await start("1.0.0");
		const res = await post(h.port, {
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: { protocolVersion: "2025-06-18", toolsApiVersion: "2.0.0" },
		});
		expect(res.status).toBe(200);
		const json = (await res.json()) as {
			result?: unknown;
			error: { message: string; code?: string };
		};
		expect(json.result).toBeUndefined();
		expect(json.error.code).toBe(TOOLS_API_INCOMPATIBLE);
		expect(json.error.message).toContain("2.0.0");
		expect(json.error.message).toContain("1.0.0");
	});

	it("versão em formato inválido também é rejeitada no handshake", async () => {
		const h = await start();
		const res = await post(h.port, {
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: { toolsApiVersion: "banana" },
		});
		const json = (await res.json()) as { error: { message: string } };
		expect(json.error.message).toContain("banana");
	});

	it("servidor com API 2.x aceita cliente 1.x (major menor ou igual passa)", async () => {
		const h = await start("2.0.0");
		const res = await post(h.port, {
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: { toolsApiVersion: "1.0.0" },
		});
		const json = (await res.json()) as { result: { toolsApiVersion: string } };
		expect(res.status).toBe(200);
		expect(json.result.toolsApiVersion).toBe("1.0.0");
	});
});
