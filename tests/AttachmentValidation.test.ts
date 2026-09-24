import { describe, it, expect } from "vitest";
import { assertAttachmentPath } from "../src/modules/mcp/McpModule";

describe("assertAttachmentPath — rejeita .md", () => {
	it("rejeita note.md", () => {
		expect(() => assertAttachmentPath("note.md")).toThrow("notas Markdown não são anexos");
	});

	it("rejeita NOTE.MD (case-insensitive)", () => {
		expect(() => assertAttachmentPath("NOTE.MD")).toThrow("notas Markdown não são anexos");
	});

	it("rejeita Note.Md (mixed case)", () => {
		expect(() => assertAttachmentPath("Note.Md")).toThrow("notas Markdown não são anexos");
	});

	it("rejeita caminho com pasta", () => {
		expect(() => assertAttachmentPath("Anexos/note.md")).toThrow("notas Markdown não são anexos");
	});

	it("rejeita caminho profundo", () => {
		expect(() => assertAttachmentPath("a/b/c/nota.md")).toThrow("notas Markdown não são anexos");
	});
});

describe("assertAttachmentPath — aceita extensões normais", () => {
	const ok = ["image.png", "photo.jpg", "doc.pdf", "icon.svg", "anim.gif", "pic.webp", "file.zip", "noext"];
	for (const ext of ok) {
		it(`aceita ${ext}`, () => {
			expect(() => assertAttachmentPath(ext)).not.toThrow();
		});
	}
});
