import { describe, it, expect } from "vitest";
import { DEFAULT_PATHS } from "../src/core/types";
import { resolvePaths, updateDerivedPaths } from "../src/core/PathResolver";

describe("PathResolver", () => {
	it("resolve os defaults canônicos", () => {
		const paths = resolvePaths({ calendarFolder: "", calendarTemplatesFolder: "" });
		expect(paths).toEqual(DEFAULT_PATHS);
	});

	it("ao mudar o sistema, atualiza templates e arquivos derivados", () => {
		const previous = { ...DEFAULT_PATHS };
		const next = { ...previous, systemFolder: "Sistema Novo" };
		const resolved = updateDerivedPaths(previous, next);
		expect(resolved.calendarTemplatesFolder).toBe("Sistema Novo/Templates/Calendário");
		expect(resolved.filesFolder).toBe("Sistema Novo/arquivos");
	});

	it("preserva caminhos personalizados", () => {
		const previous = { ...DEFAULT_PATHS, calendarTemplatesFolder: "Meu/Template" };
		const next = { ...previous, systemFolder: "Sistema Novo" };
		const resolved = updateDerivedPaths(previous, next);
		expect(resolved.calendarTemplatesFolder).toBe("Meu/Template");
	});

	it("ao mudar o calendário, atualiza a pasta global de notas de eventos derivada", () => {
		const previous = { ...DEFAULT_PATHS };
		const next = { ...previous, calendarFolder: "Agenda" };
		const resolved = updateDerivedPaths(previous, next);
		expect(resolved.eventNotesFolder).toBe("Agenda/Notas-Eventos");
	});
});
