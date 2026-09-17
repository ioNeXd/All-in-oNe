import * as http from "http";

/**
 * TRANSPORTE: STREAMABLE HTTP
 * ----------------------------
 * Implementação mínima e direta do transporte atual do MCP: um único
 * endpoint POST que recebe mensagens JSON-RPC e responde com JSON (ou, para
 * chamadas que precisam de progresso incremental, um stream SSE escopado
 * àquela requisição). O antigo transporte HTTP+SSE (dois endpoints, GET
 * separado para o stream) está deprecated e não é implementado aqui de
 * propósito.
 *
 * Isto é deliberadamente uma implementação enxuta do protocolo — o
 * suficiente para os clientes MCP atuais (Claude Desktop, Cursor, Claude
 * Code) conseguirem listar e chamar as ferramentas. Ao adicionar suporte a
 * mais recursos do protocolo (resources, prompts), estenda o roteamento em
 * `handleRequest` mantendo o mesmo formato de resposta JSON-RPC.
 */

export interface McpServerOptions {
	port: number;
	getToken: () => string;
	handleToolCall: (
		toolName: string,
		args: Record<string, unknown>
	) => Promise<{ ok: boolean; result?: unknown; error?: string }>;
}

export interface McpServerHandle {
	stop: () => Promise<void>;
}

const TOOL_DEFINITIONS = [
	{ name: "read_note", description: "Lê o conteúdo de uma nota." },
	{ name: "create_note", description: "Cria uma nova nota." },
	{ name: "append_note", description: "Adiciona conteúdo ao final de uma nota." },
	{ name: "edit_note", description: "Substitui o conteúdo de uma nota." },
	{ name: "delete_note", description: "Move uma nota para a lixeira." },
	{ name: "list_folder", description: "Lista arquivos e pastas de um caminho." },
	{ name: "search_vault", description: "Busca texto no vault inteiro." },
	{ name: "get_note_metadata", description: "Retorna frontmatter e tags de uma nota." },
	{ name: "describe_vault", description: "Visão geral do vault (contagens)." },
	{ name: "rename_note", description: "Renomeia ou move uma nota." },
	{ name: "patch_note", description: "Substitui um trecho exato dentro de uma nota." },
	{ name: "get_links", description: "Links e embeds que saem de uma nota." },
	{ name: "get_backlinks", description: "Notas que apontam para uma nota." },
	{ name: "list_tags", description: "Todas as tags existentes no vault." },
	{ name: "search_by_tag", description: "Notas que possuem uma tag." },
	{ name: "list_attachments", description: "Lista os arquivos não-markdown do vault." },
	{ name: "get_attachment", description: "Lê um anexo (retorna base64)." },
	{ name: "split_note", description: "Divide uma nota em várias, quebrando nos headings." },
	{ name: "combine_notes", description: "Junta várias notas em uma só." },
	{ name: "dataview_query", description: "Executa uma query Dataview (exige o plugin Dataview)." },
	{ name: "get_active_file", description: "Qual nota está aberta agora no Obsidian." },
];

export async function createMcpServer(options: McpServerOptions): Promise<McpServerHandle> {
	const server = http.createServer((req, res) => {
		// Última linha de defesa: uma exceção assíncrona num handler NUNCA pode
		// derrubar o processo do Obsidian (e com ele o vault do usuário) — nem
		// deixar a conexão aberta para sempre. Loga e responde 500.
		handleRequest(req, res, options).catch((err) => {
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

	return {
		stop: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
			}),
	};
}

async function handleRequest(
	req: http.IncomingMessage,
	res: http.ServerResponse,
	options: McpServerOptions
): Promise<void> {
	if (req.method !== "POST") {
		res.writeHead(405).end("Method Not Allowed");
		return;
	}

	const authHeader = req.headers["authorization"] ?? "";
	const expectedToken = options.getToken();
	if (expectedToken && authHeader !== `Bearer ${expectedToken}`) {
		res.writeHead(401).end(JSON.stringify({ error: "Token inválido." }));
		return;
	}

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
		res.writeHead(400).end(JSON.stringify({ error: "JSON inválido." }));
		return;
	}

	res.setHeader("Content-Type", "application/json");

	switch (message.method) {
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
			respondError(res, message.id, `Método não suportado: ${message.method}`);
	}
}

function respond(res: http.ServerResponse, id: unknown, result: unknown): void {
	res.writeHead(200).end(JSON.stringify({ jsonrpc: "2.0", id, result }));
}

function respondError(res: http.ServerResponse, id: unknown, error: string): void {
	res.writeHead(200).end(JSON.stringify({ jsonrpc: "2.0", id, error: { message: error } }));
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
