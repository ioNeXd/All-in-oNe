import type { App, TFile } from "obsidian";
import { STATUS_COMPLETE, STATUS_PENDING_INITIAL } from "./NoteStatus";

/**
 * Serviço central de metadados de notas.
 *
 * Módulos continuam donos da semântica dos seus campos, mas toda escrita de
 * frontmatter passa por este ponto. Isso evita que Calendário, Templates e
 * futuros módulos implementem sua própria camada de processFrontMatter.
 */
export type NoteMetadataValues = Record<string, unknown>;
export type CompletionStatusShape = "scalar" | "array";

export class NoteMetadataService {
	constructor(private readonly app: App) {}

	async update(file: TFile, values: NoteMetadataValues): Promise<void> {
		await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
			Object.assign(frontmatter, values);
		});
	}

	async setCompletionStatus(file: TFile, completed: boolean, shape: CompletionStatusShape = "scalar"): Promise<void> {
		await this.update(file, {
			concluido: completed,
			status:
				shape === "array"
					? (completed ? [STATUS_COMPLETE] : STATUS_PENDING_INITIAL)
					: (completed ? STATUS_COMPLETE : STATUS_PENDING_INITIAL[0]),
		});
	}
}
