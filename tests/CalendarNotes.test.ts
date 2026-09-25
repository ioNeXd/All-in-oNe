import { describe, expect, it } from "vitest";
import { dateKey, dailyNoteFilename, templateNoteFilename, firstAvailableTemplateSuffix, sanitizeTemplateName } from "../src/modules/calendar/CalendarNotes";

const date = new Date(2026, 8, 24);

describe("CalendarNotes", () => {
	it("usa YYYY-MM-DD", () => {
		expect(dateKey(date)).toBe("2026-09-24");
		expect(dailyNoteFilename(date)).toBe("2026-09-24.md");
	});
	it("gera nomes de template por data", () => {
		expect(templateNoteFilename("Reuniao", date)).toBe("Reuniao-2026-09-24.md");
		expect(templateNoteFilename("Reuniao", date, 2)).toBe("Reuniao-2-2026-09-24.md");
	});
	it("usa o primeiro número livre, não count+1", () => {
		const names = ["Reuniao-2026-09-24.md","Reuniao-2-2026-09-24.md","Reuniao-4-2026-09-24.md"];
		expect(firstAvailableTemplateSuffix(names,"Reuniao",date)).toBe(3);
	});
	it("sanitiza nome e remove extensão", () => {
		expect(sanitizeTemplateName("pessoal/Reuniao.md")).toBe("Reuniao");
	});
});
