import type { TFile } from "obsidian";

export function dateKey(date: Date): string {
	return String(date.getFullYear()) + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate());
}

export function dailyNoteFilename(date: Date): string {
	return dateKey(date) + ".md";
}

export function templateNoteFilename(templateName: string, date: Date, suffix = 1): string {
	if (!Number.isInteger(suffix) || suffix < 1) throw new RangeError("O sufixo do template deve ser um inteiro >= 1");
	const base = sanitizeTemplateName(templateName);
	const key = dateKey(date);
	return suffix === 1 ? base + "-" + key + ".md" : base + "-" + suffix + "-" + key + ".md";
}

export function sanitizeTemplateName(name: string): string {
	return name.replace(/\\/g, "/").split("/").pop()!.replace(/\.md$/i, "").trim().replace(/[\\/:*?"<>|]/g, "-") || "Nota";
}

export function isCalendarNoteForDate(file: Pick<TFile, "basename">, date: Date): boolean {
	const key = dateKey(date);
	return file.basename === key || file.basename.endsWith("-" + key);
}

export function firstAvailableTemplateSuffix(existingBasenames: Iterable<string>, templateName: string, date: Date): number {
	const existing = new Set(existingBasenames);
	for (let suffix = 1; ; suffix++) {
		if (!existing.has(templateNoteFilename(templateName, date, suffix))) return suffix;
	}
}

function pad(value: number): string {
	return String(value).padStart(2, "0");
}
