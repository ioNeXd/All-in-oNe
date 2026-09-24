import { describe, it, expect, vi } from "vitest";
import { FileWriteQueue } from "../src/core/FileWriteQueue";
import {
	createSplitPersistence,
	type SplitPersistenceHandle,
} from "../src/core/SplitPersistence";
import { createDefaultSettings } from "../src/core/types";
import {
	interpretGpgStatusOutput,
	extractFingerprintFromArmoredKey,
	decideSignatureVerification,
	shouldYieldToBrat,
	detectBratInstallation,
} from "../src/modules/autoupdate/SignatureUtils";
import { compareVersions, isNewerVersion } from "../src/modules/autoupdate/ReleaseUtils";
import {
	validateVaultPath,
	uniqueNameWith,
	isPathWithinBase,
} from "../src/core/PathUtils";
import type { App } from "obsidian";
import { HubCore } from "../src/core/HubCore";
import { makeTestModule } from "./helpers";

/* ================================================================
   1. PATHS — validação defensiva (Correção 7)
   ================================================================ */
describe("Adversarial — Paths", () => {
	it("rejeita path vazio", () => {
		expect(() => validateVaultPath("")).toThrow("não pode ser vazio");
	});
	it("rejeita whitespace-only", () => {
		expect(() => validateVaultPath("   \t\n  ")).toThrow("não pode ser vazio");
	});
	it("rejeita path absoluto Unix", () => {
		expect(() => validateVaultPath("/etc/passwd")).toThrow("absolutos não são permitidos");
	});
	it("rejeita path absoluto Windows", () => {
		expect(() => validateVaultPath("C:\\Windows\\System32")).toThrow("absolutos não são permitidos");
	});
	it("rejeita .. no início", () => {
		expect(() => validateVaultPath("../outro/nota.md")).toThrow("..");
	});
	it("rejeita .. no meio", () => {
		expect(() => validateVaultPath("Notas/../../etc/passwd")).toThrow("..");
	});
	it("rejeita .. após ./", () => {
		expect(() => validateVaultPath("./Notas/../../secrets.md")).toThrow("..");
	});
	it("normaliza separadores Windows", () => {
		expect(validateVaultPath("Notas\\sub\\nota.md")).toBe("Notas/sub/nota.md");
	});
	it("colapsa //", () => {
		expect(validateVaultPath("Notas//sub///nota.md")).toBe("Notas/sub/nota.md");
	});
	it("remove ./ no início", () => {
		expect(validateVaultPath("./Notas/nota.md")).toBe("Notas/nota.md");
	});
	it("remove trailing /", () => {
		expect(validateVaultPath("Notas/")).toBe("Notas");
	});
	it("rejeita caracteres de controle", () => {
		expect(() => validateVaultPath("Notas/\x00nota.md")).toThrow("caracteres de controle");
	});
	it("rejeita não-string", () => {
		expect(() => validateVaultPath(undefined as unknown as string)).toThrow("string");
	});
	it("aceita Unicode", () => {
		expect(validateVaultPath("Cadernos/relatório.md")).toBe("Cadernos/relatório.md");
	});
	it("path .. sozinho rejeitado", () => {
		expect(() => validateVaultPath("..")).toThrow("..");
	});
	it("bypass com %2e%2e não funciona", () => {
		const r = validateVaultPath("Notas/%2e%2e/secrets.md");
		expect(r).toContain("%2e%2e");
	});
	it("isPathWithinBase: dentro retorna true", () => {
		expect(isPathWithinBase("Notas/sub/nota.md", "Notas")).toBe(true);
	});
	it("isPathWithinBase: igual retorna true", () => {
		expect(isPathWithinBase("Notas", "Notas")).toBe(true);
	});
	it("isPathWithinBase: fora retorna false", () => {
		expect(isPathWithinBase("Outros/nota.md", "Notas")).toBe(false);
	});
	it("isPathWithinBase: com .. retorna false", () => {
		expect(isPathWithinBase("Notas/../Outros/nota.md", "Notas")).toBe(false);
	});
	it("uniqueNameWith: gera 2 quando existe", () => {
		const existing = new Set(["nota.md"]);
		expect(uniqueNameWith("nota.md", (p) => existing.has(p))).toBe("nota 2.md");
	});
	it("uniqueNameWith: pula colisões", () => {
		const existing = new Set(["nota.md", "nota 2.md", "nota 3.md"]);
		expect(uniqueNameWith("nota.md", (p) => existing.has(p))).toBe("nota 4.md");
	});
});

/* ================================================================
   2. CONCORRÊNCIA — FileWriteQueue (Correção 4)
   ================================================================ */
describe("Adversarial — FileWriteQueue concorrência", () => {
	it("10 operações concorrentes no mesmo path serializam", async () => {
		const queue = new FileWriteQueue();
		const order: number[] = [];
		const ops = Array.from({ length: 10 }, (_, i) =>
			queue.run("x.md", async () => { order.push(i); })
		);
		await Promise.all(ops);
		expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
	});

	it("operação parcialmente sobreposta: [A,B] e [B,C]", async () => {
		const queue = new FileWriteQueue();
		const order: string[] = [];
		await Promise.all([
			queue.runMany(["a.md", "b.md"], async () => {
				await new Promise((r) => setTimeout(r, 20));
				order.push("AB");
			}),
			queue.runMany(["b.md", "c.md"], async () => {
				order.push("BC");
			}),
		]);
		expect(order).toEqual(["AB", "BC"]);
	});

	it("[A,B,C] + [C,B,A] não deadlock (sort canônico)", async () => {
		const queue = new FileWriteQueue();
		const order: number[] = [];
		await Promise.all([
			queue.runMany(["c.md", "b.md", "a.md"], async () => {
				await new Promise((r) => setTimeout(r, 20));
				order.push(1);
			}),
			queue.runMany(["a.md", "b.md", "c.md"], async () => {
				order.push(2);
			}),
		]);
		expect(order).toEqual([1, 2]);
	});

	it("operação que falha não trava a seguinte no mesmo path", async () => {
		const queue = new FileWriteQueue();
		await queue.run("z.md", async () => { throw new Error("boom"); }).catch(() => {});
		let ok = false;
		await queue.run("z.md", async () => { ok = true; });
		expect(ok).toBe(true);
	});

	it("cleanup: Map vazio após todas as operações", async () => {
		const queue = new FileWriteQueue();
		await Promise.all([
			queue.run("a.md", async () => {}),
			queue.runMany(["b.md", "c.md"], async () => {}),
			queue.run("d.md", async () => {}),
		]);
		await new Promise((r) => setTimeout(r, 10));
		expect((queue as unknown as { queues: Map<string, unknown> }).queues.size).toBe(0);
	});

	it("5 runMany concorrentes com 3 paths cada, todos resolvem", async () => {
		const queue = new FileWriteQueue();
		let count = 0;
		const ops = Array.from({ length: 5 }, (_, i) => {
			const paths = [`p${i}.md`, `p${(i + 1) % 5}.md`, `p${(i + 2) % 5}.md`];
			return queue.runMany(paths, async () => { count++; });
		});
		await Promise.all(ops);
		expect(count).toBe(5);
	});
});

/* ================================================================
   3. SplitPersistence — crash/falha (Correção 3)
   ================================================================ */
describe("Adversarial — SplitPersistence crash/falha", () => {
	const dir = ".obsidian/plugins/All-in-oNe";

	/** Cria store em memória e devolve handle + referência ao Map de arquivos. */
	function makeStore(initial: Record<string, string> = {}) {
		const files = new Map<string, string>(Object.entries(initial));
		const adapter = {
			exists: async (p: string) => files.has(p),
			read: async (p: string) => files.get(p)!,
			write: async (p: string, data: string) => { files.set(p, data); },
			mkdir: async () => {},
		};
		const app = { vault: { adapter } } as never;
		const handle = createSplitPersistence(app, dir);
		return { handle, files };
	}

	function fSet(s: ReturnType<typeof makeStore>, name: string, data: unknown) {
		s.files.set(`${dir}/${name}`, JSON.stringify(data, null, 2));
	}
	function fGet(s: ReturnType<typeof makeStore>, name: string): string {
		return s.files.get(`${dir}/${name}`)!;
	}

	it("crash: main _v=5, history _v=3 → history descartado", async () => {
		const s = makeStore();
		fSet(s, "data.json", { ...createDefaultSettings(), _v: 5, modules: { history: {}, notifications: {} } });
		fSet(s, "data.modules/history.json", { entries: [99], _v: 3 });
		const loaded = await s.handle.loadMain();
		expect(loaded!.modules["history"]).toEqual({});
	});

	it("crash: main _v=2, history _v=5 → history aceito", async () => {
		const s = makeStore();
		fSet(s, "data.json", { ...createDefaultSettings(), _v: 2, modules: { history: {}, notifications: {} } });
		fSet(s, "data.modules/history.json", { entries: [1, 2, 3], _v: 5 });
		const loaded = await s.handle.loadMain();
		expect(loaded!.modules["history"]).toEqual({ entries: [1, 2, 3] });
	});

	it("inconsistência de versão sinalizada", async () => {
		const s = makeStore();
		fSet(s, "data.json", { ...createDefaultSettings(), _v: 5, modules: { history: {}, notifications: {} } });
		fSet(s, "data.modules/history.json", { entries: [1], _v: 7 });
		fSet(s, "data.modules/notifications.json", { prefs: true, _v: 3 });
		await s.handle.loadMain();
		expect(s.handle.versionInconsistencyDetected).toBe(true);
	});

	it("arquivo corrompido salva .corrupt", async () => {
		const files = new Map<string, string>();
		files.set(dir + "/data.json", "{not json!!!");
		const adapter = {
			exists: async (p: string) => files.has(p),
			read: async (p: string) => files.get(p)!,
			write: async (p: string, data: string) => { files.set(p, data); },
			mkdir: async () => {},
		};
		const app = { vault: { adapter } } as never;
		const h = createSplitPersistence(app, dir);
		const loaded = await h.loadMain();
		expect(loaded).toBeNull();
		expect(h.readCorrupted).toBe(true);
	});

	it("arquivo ausente não causa erro", async () => {
		const s = makeStore();
		fSet(s, "data.json", { ...createDefaultSettings(), _v: 1, modules: {} });
		const loaded = await s.handle.loadMain();
		expect(loaded).not.toBeNull();
	});

	it("persistVersioned: todos os arquivos recebem o mesmo _v", async () => {
		const s = makeStore();
		const settings = createDefaultSettings();
		const slices = new Map([["history", { entries: [1] }]]);
		await s.handle.persistVersioned(settings, slices, 42);
		const mainRaw = JSON.parse(fGet(s, "data.json")) as Record<string, unknown>;
		const histRaw = JSON.parse(fGet(s, "data.modules/history.json")) as Record<string, unknown>;
		expect(mainRaw._v).toBe(42);
		expect(histRaw._v).toBe(42);
	});
});

/* ================================================================
   4. GPG — fingerprint e identidade (Correção 9)
   ================================================================ */
describe("Adversarial — GPG fingerprint", () => {
	const GOOD = [
		"[GNUPG:] NEWSIG",
		"[GNUPG:] GOODSIG 9C1B0A1B4B2B0B7C2A3D4E5F60718293A4B5C6D7 Nome",
		"[GNUPG:] VALIDSIG 9C1B0A1B4B2B0B7C2A3D4E5F60718293A4B5C6D7 2026-09-01 1756700000 0 4 0 1 2 00 AB",
	].join("\n");

	it("assinatura válida com fingerprint reportado", () => {
		const r = interpretGpgStatusOutput(GOOD);
		expect(r.valid).toBe(true);
		expect(r.keyFingerprint).toBe("9C1B0A1B4B2B0B7C2A3D4E5F60718293A4B5C6D7");
	});

	it("assinatura de chave diferente reporta fingerprint diferente", () => {
		const bad = [
			"[GNUPG:] NEWSIG",
			"[GNUPG:] GOODSIG DEADBEEF1234567890ABCDEF1234567890ABCDEF Outro",
			"[GNUPG:] VALIDSIG DEADBEEF1234567890ABCDEF1234567890ABCDEF 2026-09-01 1756700000 0 4 0 1 2 00 AB",
		].join("\n");
		const r = interpretGpgStatusOutput(bad);
		expect(r.valid).toBe(true);
		expect(r.keyFingerprint).toBe("DEADBEEF1234567890ABCDEF1234567890ABCDEF");
	});

	it("extractFingerprintFromArmoredKey: chave válida extrai hash", () => {
		const key = [
			"-----BEGIN PGP PUBLIC KEY BLOCK-----",
			"",
			"mDMEZabc123==",
			"",
			"-----END PGP PUBLIC KEY BLOCK-----",
		].join("\n");
		const fp = extractFingerprintFromArmoredKey(key);
		expect(fp).not.toBeNull();
		expect(fp).toMatch(/^keyhash:/);
	});

	it("extractFingerprintFromArmoredKey: string vazia → null", () => {
		expect(extractFingerprintFromArmoredKey("")).toBeNull();
	});

	it("extractFingerprintFromArmoredKey: sem BEGIN/END → null", () => {
		expect(extractFingerprintFromArmoredKey("just text")).toBeNull();
	});

	it("decideSignatureVerification: ligada + ausente → abort", () => {
		const d = decideSignatureVerification({
			enabled: true, signaturePresent: false, verificationAvailable: true, assetName: "main.js",
		});
		expect(d.action).toBe("abort");
	});

	it("decideSignatureVerification: desligada + ausente → skip", () => {
		const d = decideSignatureVerification({
			enabled: false, signaturePresent: false, verificationAvailable: true, assetName: "main.js",
		});
		expect(d.action).toBe("skip");
	});

	it("decideSignatureVerification: ligada + gpg indisponível → abort", () => {
		const d = decideSignatureVerification({
			enabled: true, signaturePresent: true, verificationAvailable: false,
			verificationProblem: "gpg não encontrado", assetName: "main.js",
		});
		expect(d.action).toBe("abort");
		if (d.action === "abort") expect(d.reason).toContain("gpg não encontrado");
	});
});

/* ================================================================
   5. AutoUpdate — versão e BRAT (Correções 1, 2)
   ================================================================ */
describe("Adversarial — AutoUpdate versionamento", () => {
	it("0.10.0 > 0.9.0 (regressão de comparação string)", () => {
		expect(isNewerVersion("0.10.0", "0.9.0")).toBe(true);
	});
	it("beta é mais antigo que estável do mesmo número", () => {
		expect(isNewerVersion("0.3.0", "0.3.0-beta.1")).toBe(true);
		expect(isNewerVersion("0.3.0-beta.1", "0.3.0")).toBe(false);
	});
	it("mesma versão não é mais nova", () => {
		expect(isNewerVersion("1.2.3", "1.2.3")).toBe(false);
	});
	it("segmentos faltantes contam como 0", () => {
		expect(compareVersions("0.2", "0.2.0")).toBe(0);
	});
	it("BRAT detectado → cede", () => {
		const json = JSON.stringify({ pluginList: ["ioNeXd/All-in-oNe"] });
		const d = detectBratInstallation(json, "ioNeXd/All-in-oNe");
		expect(shouldYieldToBrat(true, d)).toBe(true);
	});
	it("BRAT não gerencia este plugin → não cede", () => {
		const json = JSON.stringify({ pluginList: ["outro/repo"] });
		const d = detectBratInstallation(json, "ioNeXd/All-in-oNe");
		expect(shouldYieldToBrat(true, d)).toBe(false);
	});
	it("BRAT data.json corrompido → não gerencia", () => {
		const d = detectBratInstallation("not-json", "ioNeXd/All-in-oNe");
		expect(d.managedByBrat).toBe(false);
	});
});

/* ================================================================
   6. Module lifecycle — falhas (Correção 5)
   ================================================================ */
describe("Adversarial — Module lifecycle", () => {
	function makeCore() {
		const settings = createDefaultSettings();
		settings.enabledModules = ["mcp", "styles"];
		let stored: ReturnType<typeof createDefaultSettings> | null = JSON.parse(JSON.stringify(settings));
		const core = new HubCore(
			{} as App,
			async () => stored,
			async (data) => { stored = data; }
		);
		return { core, getStored: () => stored };
	}

	it("onRegister falha → módulo registrado mas não habilitado", async () => {
		const { core } = makeCore();
		await core.init();
		await core.registerModule(makeTestModule({
			id: "mcp",
			onRegister: () => { throw new Error("register boom"); },
		}));
		expect(core.isModuleEnabled("mcp")).toBe(false);
		expect(core.getLastEnableError("mcp")).toContain("register boom");
	});

	it("onEnable falha → onDisable chamado para cleanup", async () => {
		const { core } = makeCore();
		await core.init();
		const disableFn = vi.fn();
		await core.registerModule(makeTestModule({
			id: "mcp",
			onEnable: () => { throw new Error("enable boom"); },
			onDisable: disableFn,
		}));
		expect(core.isModuleEnabled("mcp")).toBe(false);
		expect(disableFn).toHaveBeenCalledTimes(1);
	});

	it("onDisable que falha não impede o cleanup", async () => {
		const { core } = makeCore();
		await core.init();
		await core.registerModule(makeTestModule({
			id: "mcp",
			onDisable: () => { throw new Error("disable boom"); },
		}));
		await core.disableModule("mcp");
		expect(core.isModuleEnabled("mcp")).toBe(false);
	});

	it("falha de um módulo não impede os demais", async () => {
		const { core } = makeCore();
		await core.init();
		await core.registerModule(makeTestModule({
			id: "mcp",
			onEnable: () => { throw new Error("boom"); },
		}));
		const enableStyles = vi.fn();
		await core.registerModule(makeTestModule({
			id: "styles",
			onEnable: enableStyles,
		}));
		expect(enableStyles).toHaveBeenCalled();
		expect(core.isModuleEnabled("styles")).toBe(true);
	});

	it("3 falhas → modo seguro bloqueia novos enables", async () => {
		const { core } = makeCore();
		await core.init();
		const fail = () => Promise.reject(new Error("x"));
		await core.registerModule(makeTestModule({ id: "mcp", onEnable: fail }));
		await core.enableModule("mcp");
		await core.enableModule("mcp");
		const onEnable2 = vi.fn();
		await core.registerModule(makeTestModule({ id: "styles", onEnable: onEnable2 }));
		expect(onEnable2).not.toHaveBeenCalled();
	});
});
