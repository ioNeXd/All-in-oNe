import { describe, it, expect } from "vitest";
import {
	TOOL_DEFINITIONS,
	EXTRA_PATH_ARGS,
	type ToolDefinition,
	type JsonSchema,
} from "../src/modules/mcp/ToolSchemas";

/**
 * CONTRATO tools/list — toda ferramenta expõe inputSchema JSON Schema.
 * Clientes em modo estrito (Claude Desktop, Cursor) montam os argumentos a
 * partir deste schema: um schema ausente ou incoerente com o que
 * executeTool lê vira chamada quebrada em produção.
 *
 * O teste cruza ToolSchemas com a lista dos argumentos que o executor
 * realmente usa (mantida à mão neste arquivo, espelhando McpModule.ts —
 * qualquer divergência dos dois lados quebra aqui).
 */

const byName = new Map(TOOL_DEFINITIONS.map((t) => [t.name, t]));

/** Args que cada tool lê em executeTool (fonte: src/modules/mcp/McpModule.ts). */
const ARGS_READ_BY_EXECUTOR: Record<string, string[]> = {
	read_note: ["path"],
	create_note: ["path", "content"],
	append_note: ["path", "content"],
	edit_note: ["path", "content"],
	delete_note: ["path"],
	list_folder: ["path"],
	search_vault: ["query", "maxResults"],
	get_note_metadata: ["path"],
	describe_vault: [],
	rename_note: ["path", "newPath"],
	patch_note: ["path", "search", "replace"],
	get_links: ["path"],
	get_backlinks: ["path"],
	list_tags: [],
	search_by_tag: ["tag"],
	list_attachments: [],
	get_attachment: ["path"],
	put_attachment: ["path", "base64"],
	delete_attachment: ["path"],
	get_server_info: [],
	split_note: ["path", "headingLevel"],
	combine_notes: ["paths", "targetPath"],
	dataview_query: ["query"],
	get_active_file: [],
};

/** Tools de escrita: dryRun é honrado pelo handleToolCall em todas elas. */
const WRITE_TOOLS = new Set([
	"create_note",
	"append_note",
	"edit_note",
	"delete_note",
	"rename_note",
	"patch_note",
	"split_note",
	"combine_notes",
	"put_attachment",
	"delete_attachment",
]);

const propType = (v: unknown): string => (v as { type?: string })?.type ?? "(sem type)";

describe("ToolSchemas — forma geral das definições", () => {
	it("cobre exatamente as ferramentas do executor (nem a mais, nem a menos)", () => {
		expect(new Set(byName.keys())).toEqual(new Set(Object.keys(ARGS_READ_BY_EXECUTOR)));
	});

	it("toda definição tem name, description e inputSchema objeto", () => {
		for (const tool of TOOL_DEFINITIONS) {
			expect(tool.name, tool.name).toMatch(/^[a-z_]+$/);
			expect(tool.description?.length ?? 0, tool.name).toBeGreaterThan(5);
			expect(tool.inputSchema?.type, tool.name).toBe("object");
			expect(tool.inputSchema?.properties, tool.name).toBeTypeOf("object");
			expect(Array.isArray(tool.inputSchema?.required), tool.name).toBe(true);
		}
	});

	it("todo campo required existe em properties (nada exigido que não seja declarado)", () => {
		for (const tool of TOOL_DEFINITIONS) {
			for (const req of tool.inputSchema.required ?? []) {
				expect(tool.inputSchema.properties, `${tool.name}: ${req}`).toHaveProperty(req);
			}
		}
	});

	it("toda property declara um type JSON Schema válido", () => {
		const valid = ["string", "number", "boolean", "array", "object"];
		for (const tool of TOOL_DEFINITIONS) {
			for (const [key, value] of Object.entries(tool.inputSchema.properties)) {
				expect(valid, `${tool.name}.${key}: type="${propType(value)}"`).toContain(propType(value));
			}
		}
	});
});

describe("ToolSchemas — coerência com o que executeTool lê", () => {
	it("cada tool declara TODOS os args que o executor lê", () => {
		for (const tool of TOOL_DEFINITIONS) {
			const declared = Object.keys(tool.inputSchema.properties).filter((k) => k !== "dryRun");
			const read = ARGS_READ_BY_EXECUTOR[tool.name] ?? [];
			expect(declared.sort(), tool.name).toEqual([...read].sort());
		}
	});

	it("todo arg required é de fato lido pelo executor (nada obrigatório em vão)", () => {
		for (const tool of TOOL_DEFINITIONS) {
			const read = new Set(ARGS_READ_BY_EXECUTOR[tool.name] ?? []);
			for (const req of tool.inputSchema.required ?? []) {
				expect(read.has(req), `${tool.name}: "${req}" é required mas o executor não lê`).toBe(true);
			}
		}
	});

	it("ferramenta de escrita declara dryRun; ferramenta de leitura, não", () => {
		for (const tool of TOOL_DEFINITIONS) {
			const hasDryRun = "dryRun" in tool.inputSchema.properties;
			expect(hasDryRun, tool.name).toBe(WRITE_TOOLS.has(tool.name));
		}
	});
});

describe("ToolSchemas — casos específicos que já quebraram antes", () => {
	it("rename_note e combine_notes declaram os campos extras de caminho (gate de permissão)", () => {
		// collectWriteTargets usa EXTRA_PATH_ARGS: se o schema não declarar
		// newPath/targetPath, o cliente nunca os manda e o gate checa só path.
		expect(byName.get("rename_note")?.inputSchema.required).toContain("newPath");
		expect(byName.get("combine_notes")?.inputSchema.required).toContain("targetPath");
		expect(EXTRA_PATH_ARGS).toEqual({ newPath: ["rename_note"], targetPath: ["combine_notes"] });
	});

	it("paths de combine_notes é array de strings (não string solta)", () => {
		const paths = byName.get("combine_notes")?.inputSchema.properties.paths as JsonSchema;
		expect(paths.type).toBe("array");
	});

	it("ferramentas sem argumento declaram properties vazio e required vazio", () => {
		for (const name of ["describe_vault", "list_tags", "list_attachments", "get_server_info", "get_active_file"]) {
			const tool = byName.get(name) as ToolDefinition;
			expect(Object.keys(tool.inputSchema.properties), name).toHaveLength(0);
			expect(tool.inputSchema.required, name).toEqual([]);
		}
	});

	it("list_folder não exige path (raiz é o default)", () => {
		expect(byName.get("list_folder")?.inputSchema.required).toEqual([]);
		expect(byName.get("list_folder")?.inputSchema.properties).toHaveProperty("path");
	});
});
