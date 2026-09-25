import { describe, it, expect } from "vitest";
import { DEFAULT_PATHS } from "../src/core/types";
import { resolvePaths, updateDerivedPaths, syncModuleDerivedPaths } from "../src/core/PathResolver";

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

	it("ao mudar o calendário, sincroniza a pasta de eventos do módulo quando ela era derivada", () => {
		const previous = {
			...({ schemaVersion: 2, onboardingCompleted: true, modules: { calendar: { eventNotesFolder: "01 - Calendario/Notas-Eventos" } }, enabledModules: [], lobby: { openMode: "tab", theme: "match-obsidian" }, paths: DEFAULT_PATHS, sync: { lastWrittenBy: "x", lastWrittenAt: 0 }, telemetry: { enabled: false } }),
		};
		const next = { ...previous, paths: { ...DEFAULT_PATHS, calendarFolder: "Agenda" } };
		const synced = syncModuleDerivedPaths(previous, next);
		expect(synced.modules.calendar.eventNotesFolder).toBe("Agenda/Notas-Eventos");
	});
});
