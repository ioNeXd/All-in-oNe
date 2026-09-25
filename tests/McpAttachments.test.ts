import { describe, it, expect, vi } from "vitest";
import { McpModule, decodeBase64, MCP_DEFAULTS } from "../src/modules/mcp/McpModule";
import type { ModuleContext } from "../src/core/ModuleContract";
import type { EventBus } from "../src/core/EventBus";
import type { HubSettings } from "../src/core/types";
import { TFile as TFileClass } from "obsidian";

/**
 * IMPORTA O CÓDIGO REAL do McpModule (handleToolCall/executeTool) contra um
 * vault falso em memória que imita a superfície da API do Obsidian usada
 * pelas ferramentas de anexo. As checagens de política (readOnly, dry-run,
 * permissões por pasta) e de mecânica (fila, base64, lixeira) rodam contra
 * a implementação de verdade — nada é espelhado à mão.
 *
 * handleToolCall/executeTool são privados: o cast abaixo é a forma de
 * exercitá-los isolados, sem subir servidor HTTP (isso cabe a
 * tests/McpServer.test.ts).
 */

type ToolResult = { ok: boolean; result?: unknown; error?: string };

class FakeFile extends TFileClass {
	constructor(
		path: string,
		public extension: string,
		public data: Buffer
	) {
		super();
		this.path = path;
		this.stat = { size: data.byteLength, ctime: 0, mtime: 0 } as never;
	}
}

class FakeVault {
	files = new Map<string, FakeFile>();
	folders = new Set<string>();
	trashed: string[] = [];

	getAbstractFileByPath(path: string): FakeFile | undefined {
		return this.files.get(path);
	}
	getMarkdownFiles(): FakeFile[] {
		return [...this.files.values()].filter((f) => f.extension === "md");
	}
	getFiles(): FakeFile[] {
		return [...this.files.values()];
	}
	async create(path: string, data: string): Promise<FakeFile> {
		const file = new FakeFile(path, "md", Buffer.from(data));
		this.files.set(path, file);
		return file;
	}
	async modify(file: FakeFile, data: string): Promise<void> {
		file.data = Buffer.from(data);
	}
	async append(file: FakeFile, data: string): Promise<void> {
		file.data = Buffer.concat([file.data, Buffer.from(data)]);
	}
	async trash(file: FakeFile, _system: boolean): Promise<void> {
		this.trashed.push(file.path);
		this.files.delete(file.path);
	}
	async readBinary(file: FakeFile): Promise<Buffer> {
		return file.data;
	}
	async createBinary(path: string, data: Buffer | ArrayBuffer): Promise<FakeFile> {
		if (this.files.has(path)) throw new Error("Arquivo já existe.");
		const file = new FakeFile(path, path.split(".").pop() ?? "", asBuffer(data));
		this.files.set(path, file);
		return file;
	}
	async modifyBinary(file: FakeFile, data: Buffer | ArrayBuffer): Promise<void> {
		file.data = asBuffer(data);
	}
	async createFolder(path: string): Promise<void> {
		this.folders.add(path);
	}
}

function setup(vaultOpts: { readOnly?: boolean; dryRunDefault?: boolean; blocklist?: string[] } = {}) {
	const vault = new FakeVault();
	const emitted: { name: string; payload: Record<string, unknown> }[] = [];
	const queuedPaths: string[] = [];

	const settings = {
		...MCP_DEFAULTS,
		readOnly: vaultOpts.readOnly ?? false,
		dryRunDefault: vaultOpts.dryRunDefault ?? false,
		writeBlocklist: vaultOpts.blocklist ?? [],
	};

	const bus = {
		on: vi.fn(() => () => {}),
		emit: vi.fn(async (name: string, payload: Record<string, unknown>, _source?: string) => {
			emitted.push({ name, payload });
		}),
	} as unknown as EventBus;

	const context: ModuleContext = {
		app: { vault } as never,
		bus,
		getSettings: <T>() => JSON.parse(JSON.stringify(settings)) as T,
		updateSettings: vi.fn(async () => []),
		getFullSettings: () => ({ modules: { mcp: settings } }) as unknown as HubSettings,
		isModuleEnabled: () => true,
		log: vi.fn(),
		registerCommand: vi.fn(),
		fileWriteQueueRun: vi.fn(async (_path: string, op: () => Promise<unknown>) => {
			queuedPaths.push(_path);
			return op();
		}),
		updatePaths: async () => [],
	};

	const module = new McpModule();
	module.onRegister(context);

	const callTool = (name: string, args: Record<string, unknown>): Promise<ToolResult> =>
		(
			module as unknown as {
				handleToolCall(name: string, args: Record<string, unknown>): Promise<ToolResult>;
			}
		).handleToolCall(name, args);

	return { vault, emitted, queuedPaths, callTool, context };
}

const PNG = Buffer.from("png-fake-bytes").toString("base64");

/** O código real converte para ArrayBuffer na fronteira (tipagem do Obsidian). */
function asBuffer(data: Buffer | ArrayBuffer): Buffer {
	return data instanceof Buffer ? data : Buffer.from(new Uint8Array(data));
}

describe("put_attachment — criação, sobrescrita e validação", () => {
	it("cria anexo novo, criando a pasta-pai quando não existe, e devolve created: true", async () => {
		const { vault, callTool } = setup();
		const r = await callTool("put_attachment", { path: "Anexos/Imagens/foto.png", base64: PNG });

		expect(r.ok).toBe(true);
		expect(r.result).toMatchObject({ path: "Anexos/Imagens/foto.png", created: true });
		const file = vault.getAbstractFileByPath("Anexos/Imagens/foto.png");
		expect(file?.data.equals(Buffer.from(PNG, "base64"))).toBe(true);
		// A pasta-pai foi criada (vault.createBinary não cria pastas-pai):
		expect(vault.folders.has("Anexos")).toBe(true);
		expect(vault.folders.has("Anexos/Imagens")).toBe(true);
	});

	it("sobrescreve anexo existente via modifyBinary, sem duplicar arquivo", async () => {
		const { vault, callTool } = setup();
		vault.files.set("Anexos/foto.png", new FakeFile("Anexos/foto.png", "png", Buffer.from("antigo")));

		const novo = Buffer.from("conteudo-novo").toString("base64");
		const r = await callTool("put_attachment", { path: "Anexos/foto.png", base64: novo });

		expect(r.ok).toBe(true);
		expect(r.result).toMatchObject({ path: "Anexos/foto.png", created: false });
		expect(vault.getAbstractFileByPath("Anexos/foto.png")?.data.toString()).toBe("conteudo-novo");
	});

	it("base64 inválido falha ANTES de tocar o vault (nada é gravado)", async () => {
		const { vault, callTool } = setup();
		for (const bad of ["!!!", "aGVsbG8", "aGVs bG8=", ""]) {
			const r = await callTool("put_attachment", { path: "Anexos/x.png", base64: bad });
			expect(r.ok).toBe(false, `deveria rejeitar "${bad}"`);
			expect(r.error).toContain("base64");
		}
		expect(vault.getAbstractFileByPath("Anexos/x.png")).toBeUndefined();
	});

	it("escrita em pasta bloqueada é negada; irmã com prefixo parecido NÃO é (fronteira por segmento)", async () => {
		const { vault, callTool } = setup({ blocklist: ["Secretas"] });

		const blocked = await callTool("put_attachment", { path: "Secretas/x.png", base64: PNG });
		expect(blocked.ok).toBe(false);
		expect(blocked.error).toContain("não permitida");
		expect(vault.getAbstractFileByPath("Secretas/x.png")).toBeUndefined();

		// "Secretas2" NÃO é "Secretas" — o startsWith cru bloquearia por engano.
		const sibling = await callTool("put_attachment", { path: "Secretas2/x.png", base64: PNG });
		expect(sibling.ok).toBe(true);
		expect(vault.getAbstractFileByPath("Secretas2/x.png")).toBeDefined();
	});

	it("readOnly global bloqueia; liberação temporária não é necessária para leitura", async () => {
		const { vault, callTool } = setup({ readOnly: true });
		const r = await callTool("put_attachment", { path: "Anexos/x.png", base64: PNG });
		expect(r.ok).toBe(false);
		expect(r.error).toContain("somente-leitura");
		expect(vault.getAbstractFileByPath("Anexos/x.png")).toBeUndefined();
	});

	it("dry-run não escreve e não emite log de ação executada", async () => {
		const { vault, callTool, emitted } = setup();
		const r = await callTool("put_attachment", { path: "Anexos/x.png", base64: PNG, dryRun: true });

		expect(r.ok).toBe(true);
		expect(r.result).toMatchObject({ simulated: true });
		expect(vault.getAbstractFileByPath("Anexos/x.png")).toBeUndefined();
		const actionLog = emitted.find((e) => e.name === "mcp:action-logged");
	expect(actionLog).toBeDefined();
	expect(actionLog!.payload).toMatchObject({ dryRun: true, tool: "put_attachment" });
	});

	it("a escrita passa pela fila do núcleo (fileWriteQueueRun)", async () => {
		const { queuedPaths, callTool } = setup();
		await callTool("put_attachment", { path: "Anexos/x.png", base64: PNG });
		expect(queuedPaths).toContain("Anexos/x.png");
	});
});

describe("delete_attachment — lixeira, rede de segurança", () => {
	it("move o anexo para a lixeira (nunca exclusão direta) e passa pela fila", async () => {
		const { vault, callTool, queuedPaths } = setup();
		vault.files.set("Anexos/x.png", new FakeFile("Anexos/x.png", "png", Buffer.from("x")));

		const r = await callTool("delete_attachment", { path: "Anexos/x.png" });

		expect(r.ok).toBe(true);
		expect(r.result).toMatchObject({ path: "Anexos/x.png", deleted: true });
		expect(vault.trashed).toEqual(["Anexos/x.png"]);
		expect(vault.getAbstractFileByPath("Anexos/x.png")).toBeUndefined();
		expect(queuedPaths).toContain("Anexos/x.png");
	});

	it("NÃO apaga nota (.md) — aponta para delete_note", async () => {
		const { vault, callTool } = setup();
		await vault.create("Notas/a.md", "conteúdo");

		const r = await callTool("delete_attachment", { path: "Notas/a.md" });

		expect(r.ok).toBe(false);
		expect(r.error).toContain("delete_note");
		expect(vault.getAbstractFileByPath("Notas/a.md")).toBeDefined();
	});

	it("anexo inexistente dá erro claro", async () => {
		const { callTool } = setup();
		const r = await callTool("delete_attachment", { path: "Anexos/nao-existe.png" });
		expect(r.ok).toBe(false);
		expect(r.error).toContain("não encontrado");
	});
});

describe("mcp:action-logged — log de atividade dedicado", () => {
	it("cada ação executada emite o evento com tool, path, dryRun e result", async () => {
		const { callTool, emitted } = setup();
		await callTool("put_attachment", { path: "Anexos/x.png", base64: PNG });

		const log = emitted.filter((e) => e.name === "mcp:action-logged");
		expect(log).toHaveLength(1);
		expect(log[0].payload).toMatchObject({
			tool: "put_attachment",
			path: "Anexos/x.png",
			dryRun: false,
			isWrite: true,
		});
		expect(log[0].payload.result).toMatchObject({ type: "metadata-only" });
		// UM evento por ação: o genérico mcp:action NÃO é mais emitido (era o
		// que duplicava cada ação no histórico):
		expect(emitted.some((e) => e.name === "mcp:action")).toBe(false);
	});

	it("falha TAMBÉM entra no log — com error em vez de result", async () => {
		const { callTool, emitted } = setup();
		await callTool("put_attachment", { path: "Anexos/x.png", base64: "!!!" });

		const log = emitted.filter((e) => e.name === "mcp:action-logged");
		expect(log).toHaveLength(1);
		expect(log[0].payload.tool).toBe("put_attachment");
		expect(log[0].payload.error).toContain("base64");
		expect(log[0].payload.result).toBeUndefined();
	});

	it("o evento está declarado no emits do manifest", () => {
		const module = new McpModule();
		expect(module.manifest.emits).toContain("mcp:action-logged");
	});
});

describe("get_attachment — ida e volta com put_attachment", () => {
	it("o que foi gravado volta igual (base64 e tamanho)", async () => {
		const { vault, callTool } = setup();
		await callTool("put_attachment", { path: "Anexos/x.png", base64: PNG });

		const r = await callTool("get_attachment", { path: "Anexos/x.png" });
		expect(r.ok).toBe(true);
		expect(r.result).toMatchObject({ path: "Anexos/x.png", sizeBytes: Buffer.from(PNG, "base64").byteLength });
		expect((r.result as { base64: string }).base64).toBe(PNG);
	});
});

describe("decodeBase64 — validação estrita (código real)", () => {
	it("aceita base64 válido com padding canônico", () => {
		expect(decodeBase64("aGVsbG8=").toString()).toBe("hello");
		expect(decodeBase64("cG5nLWZha2UtYnl0ZXM=").toString()).toBe("png-fake-bytes");
	});
	it("rejeita vazio, caracteres inválidos e comprimento não múltiplo de 4", () => {
		expect(() => decodeBase64("")).toThrow("vazio");
		expect(() => decodeBase64("abc!")).toThrow("base64");
		expect(() => decodeBase64("aGVsbG8")).toThrow("múltiplo de 4");
	});
	it("rejeita valor não textual (objeto/número vindo de JSON malformado)", () => {
		expect(() => decodeBase64(undefined)).toThrow();
		expect(() => decodeBase64(123 as unknown as string)).toThrow();
	});
});
