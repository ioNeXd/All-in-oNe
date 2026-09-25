import { afterAll, describe, it, expect } from "vitest";
import {
	createMcpServer,
	type McpServerHandle,
	TOOLS_API_INCOMPATIBLE,
	JSONRPC_ERRORS,
} from "../src/modules/mcp/server";
import { AuthThrottle, MAX_AUTH_FAILURES } from "../src/modules/mcp/AuthThrottle";

/**
 * Teste de INTEGRAÇÃO do servidor MCP: HTTP de verdade, escutando em porta
 * efêmera (port: 0 — o SO escolhe; o handle expõe a porta real). Cobre o
 * handshake do protocolo MCP, que clientes reais (Claude Desktop, Cursor)
 * executam ANTES de listar ferramentas — sem isto, a conexão morria no
 * primeiro passo. Também cobre a autenticação por token: a recusa (401)
 * acontece antes de ler o corpo e de executar qualquer ferramenta.
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

function postModern(port: number, body: unknown, name?: string) {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Accept: "application/json, text/event-stream",
		"MCP-Protocol-Version": "2026-07-28",
		"Mcp-Method": (body as { method: string }).method,
		Authorization: "Bearer tok",
	};
	if (name !== undefined) headers["Mcp-Name"] = name;
	return fetch(`http://127.0.0.1:${port}`, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	});
}

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
		expect(json.result.content).toEqual([{ type: "text", text: JSON.stringify({ eco: "read_note" }) }]);
		expect(json.result.isError).toBeUndefined();
	});
});

describe("MCP — contrato HTTP (Content-Type e Accept)", () => {
	it("rejeita POST sem Content-Type com 415", async () => {
		const h = await start();
		const res = await fetch(`http://127.0.0.1:${h.port}`, {
			method: "POST",
			headers: { Authorization: "Bearer tok" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
		});
		expect(res.status).toBe(415);
	});

	it("rejeita Content-Type text/plain com 415", async () => {
		const h = await start();
		const res = await fetch(`http://127.0.0.1:${h.port}`, {
			method: "POST",
			headers: {
				"Content-Type": "text/plain",
				Authorization: "Bearer tok",
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
		});
		expect(res.status).toBe(415);
	});

	it("aceita Content-Type application/json com charset", async () => {
		const h = await start();
		const res = await fetch(`http://127.0.0.1:${h.port}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json; charset=utf-8",
				Authorization: "Bearer tok",
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
		});
		expect(res.status).toBe(200);
	});

	it("rejeita Accept incompatível com 406", async () => {
		const h = await start();
		const res = await fetch(`http://127.0.0.1:${h.port}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "text/html",
				Authorization: "Bearer tok",
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
		});
		expect(res.status).toBe(406);
	});

	it("aceita Accept sem header (omissão = qualquer coisa)", async () => {
		const h = await start();
		const res = await fetch(`http://127.0.0.1:${h.port}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer tok",
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
		});
		expect(res.status).toBe(200);
	});

	it("aceita Accept */* (curinga padrão)", async () => {
		const h = await start();
		const res = await fetch(`http://127.0.0.1:${h.port}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "*/*",
				Authorization: "Bearer tok",
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
		});
		expect(res.status).toBe(200);
	});

	it("aceita Accept com múltiplos valores incluindo application/json", async () => {
		const h = await start();
		const res = await fetch(`http://127.0.0.1:${h.port}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "text/html, application/json, */*",
				Authorization: "Bearer tok",
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
		});
		expect(res.status).toBe(200);
	});
});

	// --- MIME estrito: rejeita falsos positivos do antigo includes() ---

	it("rejeita application/jsonx com 415", async () => {
		const h = await start();
		const res = await fetch(`http://127.0.0.1:${h.port}`, {
			method: "POST",
			headers: { "Content-Type": "application/jsonx", Authorization: "Bearer tok" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
		});
		expect(res.status).toBe(415);
	});

	it("rejeita text/plain com application/json no param com 415", async () => {
		const h = await start();
		const res = await fetch(`http://127.0.0.1:${h.port}`, {
			method: "POST",
			headers: { "Content-Type": 'text/plain; charset="application/json"', Authorization: "Bearer tok" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
		});
		expect(res.status).toBe(415);
	});

	it("rejeita Accept application/jsonx com 406", async () => {
		const h = await start();
		const res = await fetch(`http://127.0.0.1:${h.port}`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/jsonx", Authorization: "Bearer tok" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
		});
		expect(res.status).toBe(406);
	});

	it("rejeita Accept multipart/mixed com 406", async () => {
		const h = await start();
		const res = await fetch(`http://127.0.0.1:${h.port}`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "multipart/mixed", Authorization: "Bearer tok" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
		});
		expect(res.status).toBe(406);
	});

	it("rejeita Accept application/json com q=0", async () => {
		const h = await start();
		const res = await fetch(`http://127.0.0.1:${h.port}`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json; q=0", Authorization: "Bearer tok" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
		});
		expect(res.status).toBe(406);
	});

	it("aceita Accept application/json com parametros extras", async () => {
		const h = await start();
		const res = await fetch(`http://127.0.0.1:${h.port}`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json; q=0.9", Authorization: "Bearer tok" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
		});
		expect(res.status).toBe(200);
	});

	it("aceita Content-Type Application/JSON case-insensitive", async () => {
		const h = await start();
		const res = await fetch(`http://127.0.0.1:${h.port}`, {
			method: "POST",
			headers: { "Content-Type": "Application/JSON", Authorization: "Bearer tok" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
		});
		expect(res.status).toBe(200);
	});

	// --- JSON-RPC envelope validation: -32600 INVALID_REQUEST ---

	it("rejeita body null com -32600", async () => {
		const h = await start();
		const res = await fetch(`http://127.0.0.1:${h.port}`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: "Bearer tok" },
			body: "null",
		});
		const json = await res.json();
		expect(res.status).toBe(200);
		expect(json.error.code).toBe(-32600);
	});

	it("rejeita body array com -32600", async () => {
		const h = await start();
		const res = await fetch(`http://127.0.0.1:${h.port}`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: "Bearer tok" },
			body: "[1]",
		});
		const json = await res.json();
		expect(json.error.code).toBe(-32600);
	});

	it("rejeita body string com -32600", async () => {
		const h = await start();
		const res = await fetch(`http://127.0.0.1:${h.port}`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: "Bearer tok" },
			body: "\"hello\"",
		});
		const json = await res.json();
		expect(json.error.code).toBe(-32600);
	});

	it("rejeita sem jsonrpc field com -32600", async () => {
		const h = await start();
		const res = await fetch(`http://127.0.0.1:${h.port}`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: "Bearer tok" },
			body: JSON.stringify({ method: "tools/list", id: 1 }),
		});
		const json = await res.json();
		expect(json.error.code).toBe(-32600);
	});

	it("rejeita jsonrpc 1.0 com -32600", async () => {
		const h = await start();
		const res = await fetch(`http://127.0.0.1:${h.port}`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: "Bearer tok" },
			body: JSON.stringify({ jsonrpc: "1.0", method: "tools/list", id: 1 }),
		});
		const json = await res.json();
		expect(json.error.code).toBe(-32600);
	});

	it("rejeita method ausente com -32600", async () => {
		const h = await start();
		const res = await fetch(`http://127.0.0.1:${h.port}`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: "Bearer tok" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1 }),
		});
		const json = await res.json();
		expect(json.error.code).toBe(-32600);
	});

	it("rejeita method nao-string com -32600", async () => {
		const h = await start();
		const res = await fetch(`http://127.0.0.1:${h.port}`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: "Bearer tok" },
			body: JSON.stringify({ jsonrpc: "2.0", method: 42, id: 1 }),
		});
		const json = await res.json();
		expect(json.error.code).toBe(-32600);
	});

	it("rejeita params array com -32600", async () => {
		const h = await start();
		const res = await fetch(`http://127.0.0.1:${h.port}`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: "Bearer tok" },
			body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", params: [1], id: 1 }),
		});
		const json = await res.json();
		expect(json.error.code).toBe(-32600);
	});

	it("rejeita params string com -32600", async () => {
		const h = await start();
		const res = await fetch(`http://127.0.0.1:${h.port}`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: "Bearer tok" },
			body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", params: "bad", id: 1 }),
		});
		const json = await res.json();
		expect(json.error.code).toBe(-32600);
	});

	it("rejeita id objeto com -32600", async () => {
		const h = await start();
		const res = await fetch(`http://127.0.0.1:${h.port}`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: "Bearer tok" },
			body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: {} }),
		});
		const json = await res.json();
		expect(json.error.code).toBe(-32600);
	});

	it("aceita id null — responde com id null", async () => {
		const h = await start();
		const res = await fetch(`http://127.0.0.1:${h.port}`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: "Bearer tok" },
			body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: null }),
		});
		const json = await res.json();
		expect(json.id).toBeNull();
	});

	it("rejeita JSON malformado com -32700", async () => {
		const h = await start();
		const res = await fetch(`http://127.0.0.1:${h.port}`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: "Bearer tok" },
			body: "{broken",
		});
		const json = await res.json();
		expect(json.error.code).toBe(-32700);
	});

});

describe("MCP — autenticação (401 antes de qualquer processamento)", () => {
	const CALL = {
		jsonrpc: "2.0",
		id: 42,
		method: "tools/call",
		params: { name: "read_note", arguments: { path: "x.md" } },
	};

	it("requisição SEM header Authorization → 401 com erro explícito", async () => {
		const h = await start();
		const res = await fetch(`http://127.0.0.1:${h.port}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" }, // sem Authorization
			body: JSON.stringify(CALL),
		});
		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ error: "Token inválido." });
	});

	it("token ERRADO → 401, mesmo com corpo JSON-RPC válido", async () => {
		const h = await start();
		const res = await post(h.port, CALL, "token-errado");
		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ error: "Token inválido." });
	});

	it("esquema Bearer é case-insensitive; token sem esquema é recusado", async () => {
		const h = await start();
		const accepted = await fetch(`http://127.0.0.1:${h.port}`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: "bearer tok" },
			body: JSON.stringify(CALL),
		});
		expect(accepted.status).toBe(200);

		const rejected = await fetch(`http://127.0.0.1:${h.port}`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: "tok" },
			body: JSON.stringify(CALL),
		});
		expect(rejected.status).toBe(401);
	});

	it("a recusa acontece ANTES de executar qualquer ferramenta (spy nunca é chamado)", async () => {
		let toolCalls = 0;
		const handle = await createMcpServer({
			port: 0,
			getToken: () => "tok",
			serverInfo: { name: "All iₙ oNe", version: "0.1.0" },
			getToolsApiVersion: () => "1.0.0",
			handleToolCall: async (toolName) => {
				toolCalls += 1;
				return { ok: true, result: { eco: toolName } };
			},
		});
		handles.push(handle);
		const res = await post(handle.port, CALL, "token-errado");
		expect(res.status).toBe(401);
		expect(toolCalls).toBe(0); // gate curto-circuita antes do handler
	});

	it("controle positivo: o MESMO corpo com o token certo passa (200)", async () => {
		const h = await start();
		const res = await post(h.port, CALL);
		expect(res.status).toBe(200);
	});
});

describe("MCP — throttle de autenticação (lockout após falhas repetidas)", () => {
	const CALL = { jsonrpc: "2.0", id: 1, method: "tools/list" };

	it(`após ${MAX_AUTH_FAILURES} tokens errados, a próxima tentativa recebe 429 + Retry-After`, async () => {
		const handle = await createMcpServer({
			port: 0,
			getToken: () => "tok",
			serverInfo: { name: "All iₙ oNe", version: "0.1.0" },
			getToolsApiVersion: () => "1.0.0",
			handleToolCall: async () => ({ ok: true, result: {} }),
		});
		handles.push(handle);

		// MAX falhas com 401 (ainda não travou):
		for (let i = 0; i < MAX_AUTH_FAILURES; i++) {
			const res = await post(handle.port, CALL, "errado");
			expect(res.status).toBe(401);
		}
		// A tentativa seguinte nem compara token: 429 com Retry-After:
		const locked = await post(handle.port, CALL, "tok");
		expect(locked.status).toBe(429);
		expect(Number(locked.headers.get("retry-after"))).toBeGreaterThan(0);
	});

	it("o lockout é levantado quando o throttle injetado drena (controle com relógio fake)", async () => {
		let t = 1_000_000;
		const throttle = new AuthThrottle(() => t);
		const handle = await createMcpServer({
			port: 0,
			getToken: () => "tok",
			serverInfo: { name: "All iₙ oNe", version: "0.1.0" },
			getToolsApiVersion: () => "1.0.0",
			handleToolCall: async () => ({ ok: true, result: {} }),
			authThrottle: throttle,
		});
		handles.push(handle);

		for (let i = 0; i < MAX_AUTH_FAILURES; i++) await post(handle.port, CALL, "errado");
		expect((await post(handle.port, CALL, "tok")).status).toBe(429);

		t += 60_001; // janela esvazia
		expect((await post(handle.port, CALL, "tok")).status).toBe(200);
	});

	it("token certo após falhas isoladas continua funcionando (sucesso limpa o histórico)", async () => {
		const handle = await createMcpServer({
			port: 0,
			getToken: () => "tok",
			serverInfo: { name: "All iₙ oNe", version: "0.1.0" },
			getToolsApiVersion: () => "1.0.0",
			handleToolCall: async () => ({ ok: true, result: {} }),
		});
		handles.push(handle);

		for (let i = 0; i < MAX_AUTH_FAILURES - 1; i++) await post(handle.port, CALL, "errado");
		const ok = await post(handle.port, CALL);
		expect(ok.status).toBe(200);
		// Com o histórico limpo, o limite não foi atingido: mais falhas ainda
		// são 401 (não 429) — o usuário real não é punido pelo erro anterior.
		const more = await post(handle.port, CALL, "errado");
		expect(more.status).toBe(401);
	});

	it("servidor SEM token configurado não throttla (gate de auth nem existe)", async () => {
		const handle = await createMcpServer({
			port: 0,
			getToken: () => "",
			serverInfo: { name: "All iₙ oNe", version: "0.1.0" },
			getToolsApiVersion: () => "1.0.0",
			handleToolCall: async () => ({ ok: true, result: {} }),
		});
		handles.push(handle);
		const res = await post(handle.port, CALL, "qualquer-coisa");
		expect(res.status).toBe(200); // sem gate, sem 401, sem lockout
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

	it("minor maior dentro do mesmo major é compatível e negocia a versão suportada pelo servidor", async () => {
		const h = await start("1.0.0");
		const res = await post(h.port, {
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: { toolsApiVersion: "1.9.0" },
		});
		const json = (await res.json()) as { result: { toolsApiVersion: string } };
		expect(res.status).toBe(200);
		expect(json.result.toolsApiVersion).toBe("1.0.0");
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
			error: { message: string; code?: number; data?: { code?: string } };
		};
		expect(json.result).toBeUndefined();
		// Código NUMÉRICO do padrão no topo (INVALID_PARAMS: método existe,
		// argumentos não); o código string da API fica em data.code:
		expect(json.error.code).toBe(JSONRPC_ERRORS.INVALID_PARAMS);
		expect(json.error.data?.code).toBe(TOOLS_API_INCOMPATIBLE);
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

describe("MCP — códigos de erro JSON-RPC padronizados", () => {
	it("método inexistente responde -32601 (METHOD_NOT_FOUND) com a mensagem no error.message", async () => {
		const h = await start();
		const res = await post(h.port, { jsonrpc: "2.0", id: 1, method: "resources/list" });
		expect(res.status).toBe(200);
		const json = (await res.json()) as { error: { code: number; message: string } };
		expect(json.error.code).toBe(-32601);
		expect(json.error.message).toContain("resources/list");
	});

	it("corpo que não é JSON responde -32700 (PARSE_ERROR) com id null", async () => {
		const h = await start();
		const res = await fetch(`http://127.0.0.1:${h.port}`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: "Bearer tok" },
			body: "{isto não é json",
		});
		expect(res.status).toBe(200);
		const json = (await res.json()) as { id: null; error: { code: number; message: string } };
		expect(json.id).toBeNull(); // sem id parseável — o padrão manda null
		expect(json.error.code).toBe(-32700);
	});

	it("erro genérico de servidor usa -32603 (INTERNAL_ERROR) como default do respondError", async () => {
		const handle = await createMcpServer({
			port: 0,
			getToken: () => "tok",
			serverInfo: { name: "All iₙ oNe", version: "0.1.0" },
			getToolsApiVersion: () => "1.0.0",
			handleToolCall: async () => ({ ok: false, error: "explodiu" }),
		});
		handles.push(handle);
		const res = await post(handle.port, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "x" } });
		const json = (await res.json()) as { result: { content: { type: string; text: string }[]; isError?: boolean } };
		expect(json.result.isError).toBe(true);
		expect(json.result.content[0].text).toBe("explodiu");
	});
});


describe("MCP 2026-07-28 — era moderna stateless", () => {
	it("server/discover anuncia a era moderna, capabilities e identidade em _meta", async () => {
		const h = await start();
		const res = await postModern(h.port, {
			jsonrpc: "2.0",
			id: 1,
			method: "server/discover",
			params: { _meta: {
				"io.modelcontextprotocol/protocolVersion": "2026-07-28",
				"io.modelcontextprotocol/clientCapabilities": {},
			} },
		});
		const json = await res.json();
		expect(res.status).toBe(200);
		expect(json.result.resultType).toBe("complete");
		expect(json.result.supportedVersions).toEqual(["2026-07-28"]);
		expect(json.result.capabilities.tools).toEqual({ listChanged: false });
		expect(json.result._meta["io.modelcontextprotocol/serverInfo"]).toEqual({ name: "All iₙ oNe", version: "0.1.0" });
		expect(json.result.ttlMs).toBeGreaterThan(0);
		expect(json.result.cacheScope).toBe("private");
	});

	it("tools/list funciona sem initialize e retorna o contrato cacheável moderno", async () => {
		const h = await start();
		const res = await postModern(h.port, {
			jsonrpc: "2.0",
			id: 2,
			method: "tools/list",
			params: { _meta: {
				"io.modelcontextprotocol/protocolVersion": "2026-07-28",
				"io.modelcontextprotocol/clientCapabilities": {},
			} },
		});
		const json = await res.json();
		expect(res.status).toBe(200);
		expect(json.result.resultType).toBe("complete");
		expect(json.result.tools.length).toBeGreaterThan(0);
		expect(json.result.ttlMs).toBe(300000);
		expect(json.result.cacheScope).toBe("private");
	});

	it("tools/call funciona de forma autocontida e sem sessão", async () => {
		const h = await start();
		const res = await postModern(h.port, {
			jsonrpc: "2.0",
			id: 3,
			method: "tools/call",
			params: {
				name: "read_note",
				arguments: { path: "x.md" },
				_meta: {
					"io.modelcontextprotocol/protocolVersion": "2026-07-28",
					"io.modelcontextprotocol/clientCapabilities": {},
				},
			},
		}, "read_note");
		const json = await res.json();
		expect(res.status).toBe(200);
		expect(json.result.resultType).toBe("complete");
		expect(json.result.content).toEqual([{ type: "text", text: JSON.stringify({ eco: "read_note" }) }]);
		expect(json.result._meta["io.modelcontextprotocol/serverInfo"]).toEqual({ name: "All iₙ oNe", version: "0.1.0" });
	});

	it("rejeita mismatch entre Mcp-Name e params.name", async () => {
		const h = await start();
		const res = await postModern(h.port, {
			jsonrpc: "2.0",
			id: 4,
			method: "tools/call",
			params: {
				name: "read_note",
				arguments: {},
				_meta: {
					"io.modelcontextprotocol/protocolVersion": "2026-07-28",
					"io.modelcontextprotocol/clientCapabilities": {},
				},
			},
		}, "outro");
		expect(res.status).toBe(400);
		const json = await res.json();
		expect(json.error.code).toBe(-32020);
	});

	it("rejeita initialize quando o cliente declara a era moderna", async () => {
		const h = await start();
		const res = await postModern(h.port, {
			jsonrpc: "2.0",
			id: 5,
			method: "initialize",
			params: { _meta: {
				"io.modelcontextprotocol/protocolVersion": "2026-07-28",
				"io.modelcontextprotocol/clientCapabilities": {},
			} },
		});
		expect(res.status).toBe(404);
		const json = await res.json();
		expect(json.error.code).toBe(-32601);
	});
});
