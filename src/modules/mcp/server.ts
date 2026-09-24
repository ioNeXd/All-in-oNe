import * as http from "http";
import * as crypto from "crypto";
import { negotiateToolsApiVersion } from "./ToolsApiVersion";
import { TOOL_DEFINITIONS } from "./ToolSchemas";
import { AuthThrottle, identityOf } from "./AuthThrottle";

/**
 * TRANSPORTE: HTTP POST (subconjunto deliberado do Streamable HTTP)
 * ---------------------------------------------------------------
 * Implementação stateless, POST-only: recebe JSON-RPC via POST e responde
 * com JSON. GET/SSE, headers MCP (Mcp-Method, Mcp-Name) e notificações
 * server-initiated NÃO são implementados — e não precisam ser.
 *
 * ERA / COMPATIBILIDADE:
 *   Este servidor implementa duas eras MCP no mesmo endpoint: a era legada
 *   via initialize (2025-03-26, 2025-06-18 e 2025-11-25) e a era moderna
 *   2026-07-28 via server/discover, envelope _meta e headers MCP por requisição.
 *
 * DECISÃO DE DESIGN: este servidor é deliberadamente um transport subset.
 * O spec MCP Streamable HTTP (2025-06-18) permite estado puro POST-only
 * quando o servidor não suporta notificações server-initiated. Este plugin
 * declara listChanged: false no handshake → SSE não é necessário.
 *
 * Contrato implementado:
 *   ✔ POST / com JSON-RPC 2.0 (initialize, tools/list, tools/call)
 *   ✔ Notificações JSON-RPC (sem id) retornam 202 Accepted
 *   ✔ Negociação de versão do protocolo MCP nas duas eras
 *   ✔ Negociação de versão da API de ferramentas (toolsApiVersion)
 *   ✔ Validação de argumentos contra inputSchema (required + type)
 *   ✔ Autenticação Bearer + throttling + rate limiting
 *   ✔ Validação de Content-Type (415) e Accept (406)
 *
 * O que NÃO faz (e por quê):
 *   ✘ GET/SSE — notificações server-initiated; sem elas, GET é inútil
 *   ✘ GET/SSE/subscriptions/listen — não implementados porque este plugin
 *     não anuncia notificações server-initiated
 *   ✘ resources/prompts/Tasks/MRTR — fora do escopo atual; somente Tools é anunciado
 *
 * Clientes suportados e testados:
 *   • Claude Desktop (macOS/Windows)
 *   • Cursor
 *   • Claude Code
 *   • Qualquer cliente JSON-RPC 2.0 sobre HTTP POST que aceite o
 *     handshake MCP — clientes SSE-only NÃO funcionam
 *
 * Para extensão (se necessário no futuro):
 *   A separação McpServer → McpTransport → HTTP adapter é o caminho
 *   natural. O roteamento em handleRequest já está isolado — adicionar
 *   GET/SSE exigiria apenas um novo case no switch + um transport layer.
 *   Não foi feito ainda porque YAGNI: nenhum cliente do plugin precisa.
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

/** Versões do protocolo MCP que este servidor implementa de fato. */
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-03-26", "2025-06-18", "2025-11-25", "2026-07-28"] as const;
const LATEST_PROTOCOL_VERSION = "2025-11-25";
const MODERN_PROTOCOL_VERSION = "2026-07-28";
const MODERN_TTL_MS = 5 * 60 * 1000;
const SERVER_INFO_META_KEY = "io.modelcontextprotocol/serverInfo";
const CLIENT_PROTOCOL_META_KEY = "io.modelcontextprotocol/protocolVersion";
const CLIENT_CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities";
const CLIENT_INFO_META_KEY = "io.modelcontextprotocol/clientInfo";
const PROTOCOL_VERSION_INCOMPATIBLE = "PROTOCOL_VERSION_INCOMPATIBLE";

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

	// Contrato HTTP: aceita SOMENTE application/json no POST.
	// Rejeita ausência (navegador, health-check), text/*, multipart, etc.
	// Parsing MIME: extrai media type (antes de ';') e compara exata —
	// rejeita 'application/jsonx', 'fooapplication/json', etc.
	const contentType = (req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
	if (contentType !== "application/json") {
		res.writeHead(415).end(JSON.stringify({ error: "Content-Type deve ser application/json." }));
		return;
	}

	// Accept: o servidor só produz application/json (JSON-RPC 2.0).
	// Se o cliente declara Accept sem application/json, rejeita com 406.
	// Se o cliente não envia Accept, aceita (omissão = aceita qualquer coisa).
	// Cada media type na lista é parseado: wildcard (*/*) aceita qualquer coisa;
	// application/json aceita o tipo exato; qualquer outra coisa rejeita.
	const accept = req.headers["accept"] ?? "";
	if (accept) {
		const hasJsonOrWildcard = accept.split(",").some((part) => {
			const mime = part.split(";")[0].trim().toLowerCase();
			return mime === "application/json" || mime === "*/*";
		});
		if (!hasJsonOrWildcard) {
			res.writeHead(406).end(JSON.stringify({ error: "Servidor produz apenas application/json." }));
			return;
		}
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

	if (hasAuthGate) {
		// Extração do token recebido e comparação em tempo constante.
		// Validação do prefixo Bearer ANTES — rejeita qualquer formato diferente
		// (bearer, token-only, schema desconhecido) sem comparar o segredo.
		const BEARER_PREFIX = "Bearer ";
		if (!authHeader.startsWith(BEARER_PREFIX)) {
			if (throttled) authThrottle.recordFailure(identity!);
			res.writeHead(401).end(JSON.stringify({ error: "Token inválido." }));
			return;
		}
		const receivedToken = authHeader.slice(BEARER_PREFIX.length);
		const expectedBuf = Buffer.from(expectedToken, "utf8");
		const receivedBuf = Buffer.from(receivedToken, "utf8");
		// Tamanho diferente → inválido, mas comparação em tempo constante
		// precisa de buffers do mesmo tamanho. Usa um buffer do tamanho
		// do esperado (preenchido com zeros) para ambos.
		const maxLen = Math.max(expectedBuf.length, receivedBuf.length);
		const a = Buffer.alloc(maxLen);
		const b = Buffer.alloc(maxLen);
		expectedBuf.copy(a);
		receivedBuf.copy(b);
		const match = crypto.timingSafeEqual(a, b) && expectedBuf.length === receivedBuf.length;
		if (!match) {
			if (throttled) authThrottle.recordFailure(identity!);
			res.writeHead(401).end(JSON.stringify({ error: "Token inválido." }));
			return;
		}
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

	// Validação completa do envelope JSON-RPC 2.0.
	// Rejeita null, arrays, primitivos, jsonrpc errado, method ausente/
	// não-string, params não-objeto, id não-primitivo.
	// Tudo → -32600 INVALID_REQUEST com id null (id inválido = não dá pra
	// associar a resposta ao request).
	const isObj = message !== null && typeof message === "object" && !Array.isArray(message);
	if (
		!isObj ||
		(message as Record<string, unknown>).jsonrpc !== "2.0" ||
		typeof message.method !== "string" ||
		(message.params !== undefined &&
			(typeof message.params !== "object" || message.params === null || Array.isArray(message.params)))
	) {
		res.writeHead(200).end(
			JSON.stringify({
				jsonrpc: "2.0",
				id: null,
				error: { code: JSONRPC_ERRORS.INVALID_REQUEST, message: "Requisição JSON-RPC inválida." },
			})
		);
		return;
	}

	// id válido: string, number ou null. Objeto/array/boolean → inválido.
	if (
		message.id !== undefined &&
		(message.id === null ||
			(typeof message.id !== "string" && typeof message.id !== "number"))
	) {
		res.writeHead(200).end(
			JSON.stringify({
				jsonrpc: "2.0",
				id: null,
				error: { code: JSONRPC_ERRORS.INVALID_REQUEST, message: "id inválido." },
			})
		);
		return;
	}

	// Notificações não têm resposta. Na era moderna ainda validamos o envelope
	// antes de aceitar a notificação, pois cada requisição é autocontida.
	if (message.id === undefined) {
		if (req.headers["mcp-protocol-version"] === MODERN_PROTOCOL_VERSION) {
			const modernError = validateModernRequest(req, message);
			if (modernError) {
				res.writeHead(400).end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32020, message: modernError } }));
				return;
			}
		}
		res.writeHead(202).end();
		return;
	}

	res.setHeader("Content-Type", "application/json");

	if (req.headers["mcp-protocol-version"] === MODERN_PROTOCOL_VERSION) {
		const modernError = validateModernRequest(req, message);
		if (modernError) {
			respondError(res, message.id, modernError, { code: "HEADER_MISMATCH", jsonRpcCode: -32020, httpStatus: 400 });
			return;
		}

		switch (message.method) {
			case "server/discover":
				respondModern(res, message.id, {
					resultType: "complete",
					supportedVersions: [MODERN_PROTOCOL_VERSION],
					capabilities: { tools: { listChanged: false } },
					ttlMs: 60 * 60 * 1000,
					cacheScope: "private",
				}, options.serverInfo);
				return;
			case "tools/list":
				respondModern(res, message.id, {
					resultType: "complete",
					tools: TOOL_DEFINITIONS,
					ttlMs: MODERN_TTL_MS,
					cacheScope: "private",
				}, options.serverInfo);
				return;
			case "tools/call": {
				const toolName = String(message.params?.name ?? "");
				const rawArgs = message.params?.arguments;
				if (rawArgs !== undefined && rawArgs !== null && (typeof rawArgs !== "object" || Array.isArray(rawArgs))) {
					respondError(res, message.id, "O campo 'arguments' deve ser um objeto.", {
						code: "INVALID_PARAMS",
						httpStatus: 400,
						jsonRpcCode: JSONRPC_ERRORS.INVALID_PARAMS,
					});
					return;
				}
				const args = (rawArgs ?? {}) as Record<string, unknown>;
				const def = TOOL_DEFINITIONS.find((d) => d.name === toolName);
				if (!def) {
					respondError(res, message.id, `Ferramenta desconhecida: ${toolName}`, {
						jsonRpcCode: JSONRPC_ERRORS.INVALID_PARAMS,
						httpStatus: 400,
					});
					return;
				}
				if (def) {
					const validationError = validateToolArgs(args, def.inputSchema);
					if (validationError) {
						respondError(res, message.id, validationError, {
							code: "INVALID_PARAMS",
							jsonRpcCode: JSONRPC_ERRORS.INVALID_PARAMS,
						});
						return;
					}
				}
				const result = await options.handleToolCall(toolName, args);
				respondModern(res, message.id, toToolResult(result.ok ? result.result : (result.error ?? "Erro desconhecido."), !result.ok), options.serverInfo);
				return;
			}
			default:
				respondError(res, message.id, `Método não suportado na era MCP 2026-07-28: ${message.method}`, {
					jsonRpcCode: JSONRPC_ERRORS.METHOD_NOT_FOUND,
					httpStatus: 404,
				});
		}
		return;
	}

	if (req.headers["mcp-protocol-version"] && !(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(req.headers["mcp-protocol-version"]!)) {
		respondError(res, message.id, "Versão do protocolo não suportada.", {
			code: "UNSUPPORTED_PROTOCOL_VERSION",
			httpStatus: 400,
			jsonRpcCode: -32022,
		});
		return;
	}

	switch (message.method) {
		case "initialize": {
			// Handshake MCP: clientes reais enviam isto ANTES de tools/list — sem
			// responder, a conexão morre no primeiro passo. Versão do protocolo:
			// só aceita versões que o servidor implementa; rejeita com erro claro
			// se o cliente pedir uma versão desconhecida.
			const requested = message.params?.protocolVersion;
			const requestedToolsApi =
				typeof message.params?.toolsApiVersion === "string"
					? (message.params.toolsApiVersion as string)
					: undefined;

			// Negociação de versão do protocolo: sem pedido, usa a mais recente.
			// Com pedido, aceita só o que implementamos — rejeita versão desconhecida.
			const protocolVersion =
				typeof requested !== "string" || !requested
					? LATEST_PROTOCOL_VERSION
					: (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
						? requested
						: undefined;
			if (!protocolVersion) {
				respondError(
					res,
					message.id,
					`Versão do protocolo incompatível: ${String(requested ?? "(nenhuma)")}. ` +
						`Suportadas: ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")}.`,
					{
						code: PROTOCOL_VERSION_INCOMPATIBLE,
						jsonRpcCode: JSONRPC_ERRORS.INVALID_PARAMS,
					}
				);
				return;
			}

			// Negociação de versão da API de ferramentas.
			const negotiation = negotiateToolsApiVersion(requestedToolsApi, options.getToolsApiVersion());
			if (!negotiation.compatible) {
				respondError(res, message.id, negotiation.reason ?? "Versão da API de ferramentas incompatível.", {
					code: TOOLS_API_INCOMPATIBLE,
					jsonRpcCode: JSONRPC_ERRORS.INVALID_PARAMS,
				});
				return;
			}
			respond(res, message.id, {
				protocolVersion,
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
			// Fix 12: validate arguments is a proper object (not null, array, string, etc.)
			const rawArgs = message.params?.arguments;
			if (rawArgs === null || rawArgs === undefined) {
				// arguments ausente: permite (ferramentas sem args obrigatórios)
			} else if (typeof rawArgs !== "object" || Array.isArray(rawArgs)) {
				respondError(res, message.id, "O campo 'arguments' deve ser um objeto.", {
					code: "INVALID_PARAMS",
					jsonRpcCode: JSONRPC_ERRORS.INVALID_PARAMS,
				});
				return;
			}
			const args = (rawArgs ?? {}) as Record<string, unknown>;

			// Validação de argumentos contra inputSchema (required + type).
			// Ferramentas desconhecidas passam direto — o executor já rejeita.
			const def = TOOL_DEFINITIONS.find((d) => d.name === toolName);
			if (def) {
				const validationError = validateToolArgs(args, def.inputSchema);
				if (validationError) {
					respondError(res, message.id, validationError, {
						code: "INVALID_PARAMS",
						jsonRpcCode: JSONRPC_ERRORS.INVALID_PARAMS,
					});
					return;
			}
			}
			const result = await options.handleToolCall(toolName, args);
			if (result.ok) {
				respond(res, message.id, toToolResult(result.result, false));
			} else {
				respond(res, message.id, toToolResult(result.error ?? "Erro desconhecido.", true));
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

function validateModernRequest(req: http.IncomingMessage, message: { method?: string; params?: Record<string, unknown> }): string | null {
	if (req.headers["mcp-protocol-version"] !== MODERN_PROTOCOL_VERSION) return "MCP-Protocol-Version inválido.";
	if (req.headers["mcp-method"] !== message.method) return "Mcp-Method deve corresponder ao método JSON-RPC.";
	const meta = message.params?._meta;
	if (meta === null || typeof meta !== "object" || Array.isArray(meta)) return "params._meta é obrigatório na era MCP 2026-07-28.";
	const m = meta as Record<string, unknown>;
	if (m[CLIENT_PROTOCOL_META_KEY] !== MODERN_PROTOCOL_VERSION) return "A versão em params._meta não corresponde a 2026-07-28.";
	const caps = m[CLIENT_CAPABILITIES_META_KEY];
	if (caps === null || typeof caps !== "object" || Array.isArray(caps)) return "clientCapabilities deve ser um objeto.";
	const info = m[CLIENT_INFO_META_KEY];
	if (info !== undefined && (info === null || typeof info !== "object" || Array.isArray(info) ||
		typeof (info as Record<string, unknown>).name !== "string" ||
		typeof (info as Record<string, unknown>).version !== "string")) return "clientInfo inválido.";
	if (message.method === "tools/call") {
		const name = message.params?.name;
		if (typeof name !== "string" || req.headers["mcp-name"] !== name) return "Mcp-Name deve corresponder a params.name.";
	} else if (req.headers["mcp-name"] !== undefined) {
		return "Mcp-Name não é permitido neste método.";
	}
	const accept = req.headers["accept"] ?? "";
	const parts = accept.split(",").map((p) => p.split(";")[0].trim().toLowerCase());
	if (!parts.includes("application/json") || !parts.includes("text/event-stream")) {
		return "Accept deve incluir application/json e text/event-stream.";
	}
	return null;
}

function respondModern(res: http.ServerResponse, id: unknown, result: Record<string, unknown>, serverInfo: { name: string; version: string }): void {
	res.writeHead(200).end(JSON.stringify({
		jsonrpc: "2.0",
		id,
		result: {
			resultType: "complete",
			...result,
			_meta: { ...(result._meta as Record<string, unknown> | undefined), [SERVER_INFO_META_KEY]: serverInfo },
		},
	}));
}

function respondError(
	res: http.ServerResponse,
	id: unknown,
	error: string,
	opts?: { code?: string; jsonRpcCode?: number; httpStatus?: number }
): void {
	res.writeHead(opts?.httpStatus ?? 200).end(
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
		const chunks: Buffer[] = [];
		let bytes = 0;
		let settled = false;
		const onData = (chunk: Buffer | string) => {
			if (settled) return;
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			bytes += buffer.length;
			if (bytes > maxBytes) {
				settled = true;
				const err = new Error("Corpo da requisição grande demais.") as NodeJS.ErrnoException & { tooLarge?: boolean };
				err.tooLarge = true;
				req.removeListener("data", onData);
				req.removeListener("end", onEnd);
				req.resume();
				reject(err);
				return;
			}
			chunks.push(buffer);
		};
		const onEnd = () => {
			if (settled) return;
			settled = true;
			resolve(Buffer.concat(chunks).toString("utf8"));
		};
		req.on("data", onData);
		req.on("end", onEnd);
		req.on("error", (err) => {
			if (!settled) {
				settled = true;
				reject(err);
			}
		});
	});
}

/** Converte o resultado interno para o CallToolResult definido pelo MCP. */
function toToolResult(value: unknown, isError: boolean): {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
} {
	let text: string;
	if (typeof value === "string") text = value;
	else {
		try { text = JSON.stringify(value) ?? String(value); }
		catch { text = String(value); }
	}
	return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

/** 10 MB — nenhuma ferramenta atual precisa de mais que isso num POST. */
const MAX_BODY_BYTES = 10 * 1024 * 1024;

/**
 * Validação leve de argumentos contra inputSchema.
 * Cobertura: required + type (string/number/boolean/array/object).
 * `object` rejeita arrays acidentalmente (`typeof [] === "object`).
 * `number` rejeita NaN e Infinity.
 * Sem dependência nova — JSON.parse/stringify já existe no path.
 */
function validateToolArgs(
	args: Record<string, unknown>,
	schema: { properties: Record<string, unknown>; required?: string[] }
): string | null {
	// Campos obrigatórios ausentes.
	if (schema.required) {
		for (const field of schema.required) {
			if (!(field in args) || args[field] === undefined || args[field] === null) {
				return `Campo obrigatório ausente: "${field}".`;
		}
	}
	}

	// Tipo por campo (se declarado no schema).
	for (const [field, prop] of Object.entries(schema.properties)) {
		const val = args[field];
		if (val === undefined || val === null) continue;
		const expected = (prop as { type?: string }).type;
		if (!expected) continue; // any: não valida
		if (!matchesType(val, expected)) {
			return `Campo "${field}" deve ser ${expected}, recebeu ${typeLabel(val)}.`;
		}
	}

	return null;
}

/** Checagem de tipo JSON Schema — object rejeita arrays, number rejeita NaN. */
function matchesType(value: unknown, expected: string): boolean {
	switch (expected) {
		case "string":
			return typeof value === "string";
		case "number":
			return typeof value === "number" && Number.isFinite(value);
		case "boolean":
			return typeof value === "boolean";
		case "object":
			return typeof value === "object" && value !== null && !Array.isArray(value);
		case "array":
			return Array.isArray(value);
		default:
			return true; // tipo desconhecido: não bloqueia
	}
}

function typeLabel(value: unknown): string {
	if (Array.isArray(value)) return "array";
	return typeof value;
}
