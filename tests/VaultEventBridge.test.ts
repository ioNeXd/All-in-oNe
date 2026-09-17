import { describe, it, expect, vi, beforeEach } from "vitest";
import { TFile, TFolder } from "obsidian";
import { VaultEventBridge } from "../src/core/VaultEventBridge";
import type { EventBus } from "../src/core/EventBus";

/**
 * REGRESSÃO: listeners órfãos no desligamento precoce.
 *
 * Todo o registro de listeners do vault acontece dentro de
 * `onLayoutReady`. Se o plugin é descarregado ANTES do layout ficar
 * pronto, `stop()` rodava com a lista de detachers vazia e o callback do
 * layout disparava DEPOIS — registrando listeners que nunca seriam
 * removidos (Histórico e Notificações continuariam recebendo eventos com
 * o plugin "desligado").
 *
 * Importa o CÓDIGO REAL da ponte; só o módulo "obsidian" é substituído
 * por stub (via alias no vitest.config.ts — o pacote é types-only), e o
 * stub fornece TFile/TFolder de verdade para o `instanceof`.
 */

interface VaultMock {
	on: ReturnType<typeof vi.fn>;
	offref: ReturnType<typeof vi.fn>;
	refs: { handler: (...args: unknown[]) => void; event: string }[];
}

function makeVaultMock(): VaultMock {
	const refs: VaultMock["refs"] = [];
	const on = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
		const ref = { event, handler };
		refs.push(ref);
		return ref;
	});
	const offref = vi.fn((ref: { event: string }) => {
		const i = refs.indexOf(ref);
		if (i >= 0) refs.splice(i, 1);
	});
	return { on, offref, refs };
}

function makeBridge(options?: {
	lifecycleHandlesNotes?: () => boolean;
	internalNaming?: (oldPath: string) => boolean;
}) {
	const vault = makeVaultMock();
	let layoutCb: (() => void) | undefined;
	const app = {
		workspace: {
			onLayoutReady: (cb: () => void) => {
				layoutCb = cb;
			},
		},
		vault: vault,
	};
	const bus = { emit: vi.fn(async () => {}) } as unknown as EventBus;
	const bridge = new VaultEventBridge(
		app as never,
		bus,
		options?.lifecycleHandlesNotes,
		options?.internalNaming
	);
	return {
		bridge,
		bus,
		vault,
		fireLayout: () => layoutCb?.(),
		handlerFor: (event: string) => vault.refs.find((r) => r.event === event)?.handler,
	};
}

function mdFile(path: string): TFile {
	const f = new TFile();
	f.path = path;
	return f;
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("VaultEventBridge — regressão de listeners órfãos", () => {
	it("stop() ANTES do layout pronto: o callback tardio não registra listener nenhum", () => {
		const { bridge, vault, fireLayout } = makeBridge();

		bridge.start(); // registra apenas a intenção (onLayoutReady pendente)
		bridge.stop(); // plugin descarregado antes do layout ficar pronto
		fireLayout(); // o Obsidian dispara o layout DEPOIS do unload

		expect(vault.on).not.toHaveBeenCalled();
		expect(vault.offref).not.toHaveBeenCalled();
		expect(vault.refs).toHaveLength(0);
	});

	it("fluxo normal: layout pronto registra os 4 listeners e stop() remove todos", () => {
		const { bridge, vault, fireLayout } = makeBridge();

		bridge.start();
		fireLayout();

		const eventos = vault.refs.map((r) => r.event).sort();
		expect(eventos).toEqual(["create", "delete", "modify", "rename"]);

		bridge.stop();
		expect(vault.offref).toHaveBeenCalledTimes(4);
		expect(vault.refs).toHaveLength(0);
	});

	it("mesmo com o guard, o fluxo normal continua emitindo eventos corretos", async () => {
		const { bridge, bus, fireLayout, handlerFor } = makeBridge();

		bridge.start();
		fireLayout();

		await handlerFor("create")!(mdFile("Notas/Compra.md"));
		expect(bus.emit).toHaveBeenCalledWith("file:created", { path: "Notas/Compra.md" }, "core");

		const folder = new TFolder();
		folder.path = "Notas";
		await handlerFor("create")!(folder);
		expect(bus.emit).toHaveBeenCalledWith("folder:created", { path: "Notas" }, "core");

		await handlerFor("modify")!(mdFile("Notas/Compra.md"));
		expect(bus.emit).toHaveBeenCalledWith("file:modified", { path: "Notas/Compra.md" }, "core");
	});

	it("guard não quebra o filtro do Ciclo de Vida nem o de rename interno", async () => {
		const { bridge, bus, fireLayout, handlerFor } = makeBridge({
			lifecycleHandlesNotes: () => true,
			internalNaming: (oldPath) => oldPath === "Untitled.md",
		});

		bridge.start();
		fireLayout();

		// Nota .md com Ciclo de Vida ligado: a ponte NÃO emite (quem emite é ele).
		await handlerFor("create")!(mdFile("Untitled.md"));
		expect(bus.emit).not.toHaveBeenCalledWith("file:created", expect.anything(), expect.anything());

		// Anexo no mesmo cenário: a ponte emite normalmente.
		await handlerFor("create")!(mdFile("img.png"));
		expect(bus.emit).toHaveBeenCalledWith("file:created", { path: "img.png" }, "core");

		// Rename interno (pergunta de nome): suprimido.
		await handlerFor("rename")!(mdFile("Compra.md"), "Untitled.md");
		expect(bus.emit).not.toHaveBeenCalledWith("file:renamed", expect.anything(), expect.anything());

		// Rename real do usuário: emitido com oldPath capturado ANTES da mutação.
		await handlerFor("rename")!(mdFile("Novo.md"), "Antigo.md");
		expect(bus.emit).toHaveBeenCalledWith(
			"file:renamed",
			{ path: "Novo.md", oldPath: "Antigo.md" },
			"core"
		);
	});
});
