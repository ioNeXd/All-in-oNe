/**
 * DEFINIÇÃO DAS FERRAMENTAS MCP — PURO, SEM HTTP E SEM VAULT
 * -----------------------------------------------------------
 * `tools/list` devolvia só `name` + `description`. Clientes MCP em modo
 * estrito (Claude Desktop, Cursor) exigem `inputSchema` (JSON Schema) por
 * ferramenta: sem ele, montam argumentos errados ou rejeitam a tool. Os
 * schemas vivem aqui, ao lado das definições, e são testados contra os
 * argumentos que `McpModule.executeTool` de fato lê (uma divergência —
 * campo exigido no schema que o executor não usa, ou o contrário — quebra
 * o teste na hora).
 *
 * Convenção dos schemas (feita à mão de propósito, sem dependência nova):
 *   - `path` é o caminho DENTRO do vault ("Notas/ideia.md"), sempre string.
 *   - campos de escrita de conteúdo são `content` (string) ou `base64`.
 *   - `dryRun` existe em toda ferramenta de escrita (honrado em
 *     handleToolCall mesmo sem estar no schema — mas declarado para o
 *     cliente saber que existe).
 */

/** Tipo mínimo de JSON Schema que o servidor serializa em tools/list. */
export type JsonSchema = {
	type: "object";
	properties: Record<string, unknown>;
	required?: string[];
	additionalProperties?: boolean;
};

/** Envelope de uma ferramenta, como vai no resultado de tools/list. */
export interface ToolDefinition {
	name: string;
	description: string;
	inputSchema: JsonSchema;
}

/** Property de path — comum a quase todas as ferramentas. */
const pathProp = (description: string) => ({
	type: "string",
	description,
});

/** dryRun — aceito em toda ferramenta de escrita (ver handleToolCall). */
const dryRunProp = {
	type: "boolean",
	description: "Se true, simula a ação sem tocar no vault (responde o que faria).",
};

const STRING_ARRAY = {
	type: "array",
	items: { type: "string" },
};

export const TOOL_DEFINITIONS: ToolDefinition[] = [
	{
		name: "read_note",
		description: "Lê o conteúdo de uma nota.",
		inputSchema: {
			type: "object",
			properties: { path: pathProp("Caminho da nota dentro do vault (ex.: Notas/ideia.md).") },
			required: ["path"],
		},
	},
	{
		name: "create_note",
		description: "Cria uma nova nota.",
		inputSchema: {
			type: "object",
			properties: {
				path: pathProp("Caminho da nota nova (ex.: Notas/ideia.md). A pasta-pai NÃO é criada."),
				content: { type: "string", description: "Conteúdo inicial da nota (opcional)." },
				dryRun: dryRunProp,
			},
			required: ["path"],
		},
	},
	{
		name: "append_note",
		description: "Adiciona conteúdo ao final de uma nota.",
		inputSchema: {
			type: "object",
			properties: {
				path: pathProp("Caminho da nota existente."),
				content: { type: "string", description: "Texto a acrescentar ao final." },
				dryRun: dryRunProp,
			},
			required: ["path", "content"],
		},
	},
	{
		name: "edit_note",
		description: "Substitui o conteúdo de uma nota.",
		inputSchema: {
			type: "object",
			properties: {
				path: pathProp("Caminho da nota existente."),
				content: { type: "string", description: "Novo conteúdo COMPLETO da nota." },
				dryRun: dryRunProp,
			},
			required: ["path", "content"],
		},
	},
	{
		name: "delete_note",
		description: "Move uma nota para a lixeira.",
		inputSchema: {
			type: "object",
			properties: {
				path: pathProp("Caminho da nota a apagar."),
				dryRun: dryRunProp,
			},
			required: ["path"],
		},
	},
	{
		name: "list_folder",
		description: "Lista arquivos e pastas de um caminho.",
		inputSchema: {
			type: "object",
			properties: {
				path: pathProp("Pasta a listar; vazio ou \"/\" lista a raiz do vault."),
			},
			required: [],
		},
	},
	{
		name: "search_vault",
		description:
			"Busca texto no vault (path, tags, frontmatter e conteúdo, case-insensitive). " +
			"Retorna no máximo maxResults notas por chamada; `truncated: true` indica que há " +
			"mais resultados — refine o termo ou aumente maxResults (teto 500).",
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string", description: "Texto a procurar (case-insensitive)." },
				maxResults: {
					type: "number",
					description: "Teto de resultados (padrão 50, máximo 500). Notas além do teto não são avaliadas.",
				},
			},
			required: ["query"],
		},
	},
	{
		name: "get_note_metadata",
		description: "Retorna frontmatter e tags de uma nota.",
		inputSchema: {
			type: "object",
			properties: { path: pathProp("Caminho da nota.") },
			required: ["path"],
		},
	},
	{
		name: "describe_vault",
		description: "Visão geral do vault (contagens).",
		inputSchema: { type: "object", properties: {}, required: [] },
	},
	{
		name: "rename_note",
		description: "Renomeia ou move uma nota.",
		inputSchema: {
			type: "object",
			properties: {
				path: pathProp("Caminho atual da nota."),
				newPath: pathProp("Caminho novo (pasta e/ou nome diferentes)."),
				dryRun: dryRunProp,
			},
			required: ["path", "newPath"],
		},
	},
	{
		name: "patch_note",
		description: "Substitui um trecho exato dentro de uma nota.",
		inputSchema: {
			type: "object",
			properties: {
				path: pathProp("Caminho da nota."),
				search: { type: "string", description: "Trecho EXATO a substituir (tem de existir na nota)." },
				replace: { type: "string", description: "Texto que entra no lugar." },
				dryRun: dryRunProp,
			},
			required: ["path", "search", "replace"],
		},
	},
	{
		name: "get_links",
		description: "Links e embeds que saem de uma nota.",
		inputSchema: {
			type: "object",
			properties: { path: pathProp("Caminho da nota.") },
			required: ["path"],
		},
	},
	{
		name: "get_backlinks",
		description: "Notas que apontam para uma nota.",
		inputSchema: {
			type: "object",
			properties: { path: pathProp("Caminho da nota alvo.") },
			required: ["path"],
		},
	},
	{
		name: "list_tags",
		description: "Todas as tags existentes no vault.",
		inputSchema: { type: "object", properties: {}, required: [] },
	},
	{
		name: "search_by_tag",
		description: "Notas que possuem uma tag.",
		inputSchema: {
			type: "object",
			properties: {
				tag: { type: "string", description: "Tag procurada, com ou sem \"#\" na frente." },
			},
			required: ["tag"],
		},
	},
	{
		name: "list_attachments",
		description: "Lista os arquivos não-markdown do vault.",
		inputSchema: { type: "object", properties: {}, required: [] },
	},
	{
		name: "get_attachment",
		description: "Lê um anexo (retorna base64).",
		inputSchema: {
			type: "object",
			properties: { path: pathProp("Caminho do anexo (não-.md).") },
			required: ["path"],
		},
	},
	{
		name: "put_attachment",
		description: "Cria ou sobrescreve um anexo (conteúdo em base64).",
		inputSchema: {
			type: "object",
			properties: {
				path: pathProp("Caminho do anexo (não-.md); a pasta-pai é criada se faltar."),
				base64: { type: "string", description: "Conteúdo do anexo codificado em base64 (estrito: múltiplo de 4)." },
				dryRun: dryRunProp,
			},
			required: ["path", "base64"],
		},
	},
	{
		name: "delete_attachment",
		description: "Move um anexo para a lixeira.",
		inputSchema: {
			type: "object",
			properties: {
				path: pathProp("Caminho do anexo (não-.md) a apagar."),
				dryRun: dryRunProp,
			},
			required: ["path"],
		},
	},
	{
		name: "get_server_info",
		description: "Versão do plugin, da API de ferramentas e contagens do vault.",
		inputSchema: { type: "object", properties: {}, required: [] },
	},
	{
		name: "split_note",
		description:
			"Divide uma nota em várias, quebrando nos headings. Colisão de nome deriva " +
			"\"Título 2.md\"; a resposta lista `created` e `skipped` (com motivo).",
		inputSchema: {
			type: "object",
			properties: {
				path: pathProp("Caminho da nota a dividir."),
				headingLevel: { type: "number", description: "Nível de heading que separa as partes (padrão 2 = \"## Título\")." },
				dryRun: dryRunProp,
			},
			required: ["path"],
		},
	},
	{
		name: "combine_notes",
		description:
			"Junta várias notas em uma só. Se o destino existir, é SOBRESCRITO " +
			"(resposta marca overwritten: true); notas de origem ausentes são " +
			"reportadas em `missing` — só falha se nenhuma existir.",
		inputSchema: {
			type: "object",
			properties: {
				paths: { ...STRING_ARRAY, description: "Notas de origem, na ordem em que serão juntadas." },
				targetPath: pathProp("Caminho da nota de destino com o conteúdo combinado."),
				dryRun: dryRunProp,
			},
			required: ["paths", "targetPath"],
		},
	},
	{
		name: "dataview_query",
		description: "Executa uma query Dataview (exige o plugin Dataview).",
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string", description: "Query DQL (ex.: TABLE status FROM \"Estudos\")." },
			},
			required: ["query"],
		},
	},
	{
		name: "get_active_file",
		description: "Qual nota está aberta agora no Obsidian.",
		inputSchema: { type: "object", properties: {}, required: [] },
	},
];

/**
 * Campos de argumento que apontam para um caminho ALÉM de `path` —
 * usado por `collectWriteTargets` no gate de permissões (chave = nome do
 * campo em args; valor = ferramentas que o usam). Vive aqui porque é parte
 * do CONTRATO do schema: um campo novo que aponta para outro caminho
 * precisa ser adicionado aos dois lugares (e o teste de schemas pega se
 * esquecer).
 */
export const EXTRA_PATH_ARGS: Record<string, string[]> = {
	newPath: ["rename_note"],
	targetPath: ["combine_notes"],
};
