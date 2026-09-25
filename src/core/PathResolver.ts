import { DEFAULT_PATHS, type HubSettings } from "./types";

export type ResolvedPaths = typeof DEFAULT_PATHS;

export function resolvePaths(paths: HubSettings["paths"]): ResolvedPaths {
	const system = paths.systemFolder?.trim() || DEFAULT_PATHS.systemFolder;
	const calendar = paths.calendarFolder?.trim() || DEFAULT_PATHS.calendarFolder;
	return {
		inboxFolder: paths.inboxFolder?.trim() || DEFAULT_PATHS.inboxFolder,
		calendarFolder: calendar,
		systemFolder: system,
		calendarTemplatesFolder: paths.calendarTemplatesFolder?.trim() || `${system}/Templates/Calendário`,
		eventNotesFolder: paths.eventNotesFolder?.trim() || `${calendar}/Notas-Eventos`,
		filesFolder: paths.filesFolder?.trim() || `${system}/arquivos`,
	};
}

/** Atualiza filhos derivados quando a raiz muda; caminhos personalizados são preservados. */
export function updateDerivedPaths(previous: HubSettings["paths"], next: HubSettings["paths"]): HubSettings["paths"] {
	const result = { ...next };
	const previousSystem = previous.systemFolder || DEFAULT_PATHS.systemFolder;
	const nextSystem = next.systemFolder || DEFAULT_PATHS.systemFolder;
	const previousCalendar = previous.calendarFolder || DEFAULT_PATHS.calendarFolder;
	const nextCalendar = next.calendarFolder || DEFAULT_PATHS.calendarFolder;

	if (previousSystem !== nextSystem) {
		const previousTemplates = previous.calendarTemplatesFolder || "";
		const previousFiles = previous.filesFolder || "";
		if (!previousTemplates || previousTemplates === `${previousSystem}/Templates/Calendário` || previousTemplates === "99 - Sistema/templetes" || previousTemplates === "Calendario/templates") {
			result.calendarTemplatesFolder = `${nextSystem}/Templates/Calendário`;
		}
		if (!previousFiles || previousFiles === `${previousSystem}/arquivos`) result.filesFolder = `${nextSystem}/arquivos`;
	}

	if (previousCalendar !== nextCalendar) {
		const previousEvents = previous.eventNotesFolder || "";
		if (!previousEvents || previousEvents === `${previousCalendar}/Notas-Eventos`) result.eventNotesFolder = `${nextCalendar}/Notas-Eventos`;
	}
	return result;
}

