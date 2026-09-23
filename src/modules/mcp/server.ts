import * as http from "http";
import { negotiateToolsApiVersion } from "./ToolsApiVersion";
import { TOOL_DEFINITIONS } from "./ToolSchemas";
import { AuthThrottle, identityOf } from "./AuthThrottle";

/**
 * TRANSPORTE: HTTP POST (subconjunto do Streamable HTTP)
 * ------------------------------------------------------
 * Implementação stateless, POST-only: recebe JSON-RPC via POST e responde
 * com JSON. GET/SSE, headers MCP (Mcp-Method, Mcp-Name) e notificações
 * server-initiated NÃO são implementados.
 *
 * O spec MCP Streamable HTTP (2025-06-18) permite estado puro POST-only
 * quando o servidor não suporta notificações server-initiated. Este plugin
 * declara listChanged: false no handshake — SSE não é necessário.
 *
 * Limitações:
 *   - Sem GET para stream (notificações server-initiated).
 *   - Sem headers Mcp-Method / Mcp-Name (requisitos 2026).
 *   - Sem validação de Accept ou Content-Type (o spec exige).
 *
 * Funciona com Claude Desktop, Cursor e Claude Code. Se o objetivo for
 * servidor MCP genérico, estenda o roteamento em handleRequest mantendo o
 * mesmo formato JSON-RPC.
 * resposta JSON-RPC.
 */

export interface McpServerOptions {
	port: number;
	getToken: () => string;
	/** Identidade devolvida no handshake initialize (JSON-RPC serverInfo). */
	serverInfo: { name: string; version: string };
	/** Versão da API de ferramentas que este servidor suporta (negociada no initialize). */
	getToolsApiVersion: () => string;
	handleToolCall: (
		toolName: string,
		args: Record<string, unknown>
	) => Promise<{ ok: boolean; result?: unknown; error?: string }>;
	/**
	 * Throttle de autenticação (opcional — instância própria por default).
	 * Injetável para teste determinístico; reset() roda no stop().
	 */
	authThrottle?: AuthThrottle;
}

export interface McpServerHandle {
	stop: () => Promise<void>;
	/** Porta efetivamente em escuta (útil com porta 0/efêmera em testes). */
	port: number;
}

/** Versão mais recente do protocolo MCP que este servidor entende. */
const LATEST_PROTOCOL_VERSION = "2025-06-18";

/** Erro enviado ao cliente quando a negociação de versão da API rejeita o pedido. */
export const TOOLS_API_INCOMPATIBLE = "TOOLS_API_INCOMPATIBLE";

/**
 * Códigos de erro JSON-RPC 2.0 padronizados — clientes sérios (incluindo os
 * SDKs MCP) dispatcham por NÚMERO, não por mensagem. Erros de protocolo na
 * camada do servidor os usam; o payload `error.data` preserva o detalhe.
 * (Erro de EXECUÇÃO de tool é diferente: permanece dentro do result do
 * `tools/call`, como manda o spec do MCP — não passa por aqui.)
 */
export const JSONRPC_ERRORS = {
	/** Requisição não pôde ser interpretada como JSON. */
	PARSE_ERROR: -32700,
	/** JSON inválido como protocolo (ex.: não é um objeto). */
	INVALID_REQUEST: -32600,
	/** Método inexistente no servidor. */
	METHOD_NOT_FOUND: -32601,
	/** Argumentos malformados para um método existente. */
	INVALID_PARAMS: -32602,
	/** Falha interna (o 500 da camada HTTP). */
	INTERNAL_ERROR: -32603,
} as const;

// As definições (name + description + inputSchema JSON Schema) vivem em
// ToolSchemas.ts, puro e testado — clientes em modo estrito (Claude Desktop,
// Cursor) exigem o schema para montar os argumentos corretamente.

export async function createMcpServer(options: McpServerOptions): Promise<McpServerHandle> {
	const authThrottle = options.authThrottle ?? new AuthThrottle();
	const server = http.createServer((req, res) => {
		// Última linha de defesa: uma exceção assíncrona num handler NUNCA pode
		// derrubar o processo do Obsidian (e com ele o vault do usuário) — nem
		// deixar a conexão aberta para sempre. Loga e responde 500.
		handleRequest(req, res, options, authThrottle).catch((err) => {
			console.error("[All iₙ oNe] Erro não tratado no servidor MCP:", err);
			if (!res.headersSent) {
				res.writeHead(500).end(JSON.stringify({ error: "Erro interno do servidor MCP." }));
			} else {
				res.end();
			}
		});
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port, "127.0.0.1", () => resolve());
	});

	const address = server.address();
	const port = typeof address === "object" && address !== null ? address.port : options.port;

	return {
		port,
		stop: () =>
			new Promise<void>((resolve) => {
				authThrottle.reset(); // teardown: estado de lockout morre com o servidor
				server.close(() => resolve());
				// Conexões keep-alive de clientes ainda abertas segurariam o
				// close() até o timeout do socket — o desligamento do módulo
				// (e o restart de porta) não pode esperar por elas.
				server.closeAllConnections();
			}),
	};
}

async function handleRequest(
	req: http.IncomingMessage,
	res: http.ServerResponse,
	options: McpServerOptions,
	authThrottle: AuthThrottle
): Promise<void> {
	if (req.method !== "POST") {
		res.writeHead(405).end("Method Not Allowed");
		return;
	}

	const authHeader = req.headers["authorization"] ?? "";
	const expectedToken = options.getToken();
	const hasAuthGate = !!expectedToken;
	const identity = identityOf(req);
	// Sem identidade (socket patológico) o throttle é PULADO para esta
	// requisição — não há como punir uma chave comum sem punir todo mundo.
	const throttled = hasAuthGate && identity !== undefined;

	if (throttled) {
		const decision = authThrottle.check(identity!);
		if (!decision.allowed) {
			// 429 + Retry-After: o cliente honesto (e o atacante) descobrem
			// QUANDO voltar — e a comparação de token nem acontece.
			res
				.writeHead(429, { "Retry-After": String(decision.retryAfterSeconds ?? 60) })
				.end(JSON.stringify({ error: "Muitas falhas de autenticação. Tente novamente mais tarde." }));
			return;
		}
	}

	if (hasAuthGate && authHeader !== `Bearer ${expectedToken}`) {
		if (throttled) authThrottle.recordFailure(identity!);
		res.writeHead(401).end(JSON.stringify({ error: "Token inválido." }));
		return;
	}
	if (throttled) authThrottle.recordSuccess(identity!);

	// Limite de tamanho aplicado NO STREAMING: um corpo maior que MAX_BODY_BYTES
	// derruba a conexão no meio, em vez de acumular tudo na memória antes de
	// decidir (o check pós-readBody protegia o JSON.parse, mas o body inteiro
	// já teria sido acumulado).
	let body: string;
	try {
		body = await readBody(req, MAX_BODY_BYTES);
	} catch (err) {
		const tooLarge = (err as NodeJS.ErrnoException & { tooLarge?: boolean })?.tooLarge === true;
		if (tooLarge) {
			res.writeHead(413).end(JSON.stringify({ error: "Corpo da requisição grande demais." }));
		} else {
			res.writeHead(400).end(JSON.stringify({ error: "Falha ao ler a requisição." }));
		}
		return;
	}

	let message: { method?: string; id?: unknown; params?: Record<string, unknown> };
	try {
		message = JSON.parse(body);
	} catch {
		res.writeHead(200).end(
			JSON.stringify({
				jsonrpc: "2.0",
				id: null, // sem id parseável — o padrão manda null
				error: { code: JSONRPC_ERRORS.PARSE_ERROR, message: "JSON inválido." },
			})
		);
		return;
	}

	// Notificação JSON-RPC (requisição SEM id — ex.: notifications/initialized,
	// que clientes reais mandam logo após o initialize): por definição não tem
	// resposta. O Streamable HTTP usa 202 Accepted sem corpo — responder com
	// um erro aqui confundiria o cliente no meio do handshake.
	if (message.id === undefined) {
		res.writeHead(202).end();
		return;
	}

	res.setHeader("Content-Type", "application/json");

	switch (message.method) {
		case "initialize": {
			// Handshake MCP: clientes reais enviam isto ANTES de tools/list — sem
			// responder, a conexão morre no primeiro passo. A versão do PROTOCOLO
			// pedida é ecoada (nosso conjunto tools/* é estável entre versões do
			// protocolo); sem pedido, a mais recente que este servidor fala.
			// Em paralelo, a versão da API DE FERRAMENTAS é negociada: cliente
			// pedindo major além do suportado é rejeitado aqui, no handshake,
			// com erro claro — nunca no meio de uma chamada de ferramenta.
			const requested = message.params?.protocolVersion;
			const requestedToolsApi =
				typeof message.params?.toolsApiVersion === "string"
					? (message.params.toolsApiVersion as string)
					: undefined;
			const negotiation = negotiateToolsApiVersion(requestedToolsApi, options.getToolsApiVersion());
			if (!negotiation.compatible) {
				respondError(res, message.id, negotiation.reason ?? "Versão da API de ferramentas incompatível.", {
					code: TOOLS_API_INCOMPATIBLE,
					// Método EXISTE; os argumentos é que são inaceitáveis:
					jsonRpcCode: JSONRPC_ERRORS.INVALID_PARAMS,
				});
				return;
			}
			respond(res, message.id, {
				protocolVersion: typeof requested === "string" && requested ? requested : LATEST_PROTOCOL_VERSION,
				capabilities: { tools: { listChanged: false } },
				serverInfo: options.serverInfo,
				toolsApiVersion: negotiation.version,
			});
			return;
		}
		case "tools/list": {
			respond(res, message.id, { tools: TOOL_DEFINITIONS });
			return;
		}
		case "tools/call": {
			const toolName = String(message.params?.name ?? "");
			const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
			const result = await options.handleToolCall(toolName, args);
			if (result.ok) {
				respond(res, message.id, { content: result.result });
			} else {
				respondError(res, message.id, result.error ?? "Erro desconhecido.");
			}
			return;
		}
		default:
			respondError(res, message.id, `Método não suportado: ${message.method}`, {
				jsonRpcCode: JSONRPC_ERRORS.METHOD_NOT_FOUND,
			});
	}
}

function respond(res: http.ServerResponse, id: unknown, result: unknown): void {
	res.writeHead(200).end(JSON.stringify({ jsonrpc: "2.0", id, result }));
}

function respondError(
	res: http.ServerResponse,
	id: unknown,
	error: string,
	opts?: { code?: string; jsonRpcCode?: number }
): void {
	res.writeHead(200).end(
		JSON.stringify({
			jsonrpc: "2.0",
			id,
			error: {
				// Código NUMÉRICO do padrão (default: server error genérico) —
				// clientes dispatcham por número. `code` string (ex.:
				// TOOLS_API_INCOMPATIBLE) e a mensagem seguem em `data`.
				code: opts?.jsonRpcCode ?? JSONRPC_ERRORS.INTERNAL_ERROR,
				message: error,
				...(opts?.code ? { data: { code: opts.code } } : {}),
			},
		})
	);
}

function readBody(req: http.IncomingMessage, maxBytes: number): Promise<string> {
	return new Promise((resolve, reject) => {
		let data = "";
		let bytes = 0;
		let settled = false;
		req.on("data", (chunk) => {
			if (settled) return;
			bytes += chunk.length;
			if (bytes > maxBytes) {
				settled = true;
				const err = new Error("Corpo da requisição grande demais.") as NodeJS.ErrnoException & {
					tooLarge?: boolean;
				};
				err.tooLarge = true;
				req.destroy(); // para de acumular memória já
				reject(err);
				return;
			}
			data += chunk;
		});
		req.on("end", () => {
			if (!settled) {
				settled = true;
				resolve(data);
			}
		});
		req.on("error", (err) => {
			if (!settled) {
				settled = true;
				reject(err);
			}
		});
	});
}

/** 10 MB — nenhuma ferramenta atual precisa de mais que isso num POST. */
const MAX_BODY_BYTES = 10 * 1024 * 1024;
