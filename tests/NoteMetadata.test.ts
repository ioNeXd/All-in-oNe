import { describe, it, expect, vi } from "vitest";
import { NoteMetadataService } from "../src/core/NoteMetadata";

function makeService(initial: Record<string, unknown> = {}) {
	const frontmatter = { ...initial };
	const processFrontMatter = vi.fn(async (_file: unknown, fn: (fm: Record<string, unknown>) => void) => fn(frontmatter));
	const app = {
		fileManager: { processFrontMatter },
		metadataCache: { getFileCache: () => ({ frontmatter }) },
	} as any;
	return { service: new NoteMetadataService(app), frontmatter, processFrontMatter };
}

describe("NoteMetadataService", () => {
	it("grava status escalar e concluido", async () => {
		const { service, frontmatter } = makeService();
		await service.setCompletionStatus({} as any, true);
		expect(frontmatter).toEqual({ concluido: true, status: "Completo" });
	});

	it("grava status em lista para templates", async () => {
		const { service, frontmatter } = makeService();
		await service.setCompletionStatus({} as any, false, "array");
		expect(frontmatter).toEqual({ concluido: false, status: ["Incompleto"] });
	});

	it("é idempotente quando o frontmatter já está correto", async () => {
		const { service, processFrontMatter } = makeService({ concluido: true, status: "Completo" });
		await service.setCompletionStatus({} as any, true);
		expect(processFrontMatter).not.toHaveBeenCalled();
	});

	it("remove metadados pelo serviço central", async () => {
		const { service, frontmatter } = makeService({ origem: "a.md", concluido: true });
		await service.remove({} as any, ["origem"]);
		expect(frontmatter).toEqual({ concluido: true });
	});
});
