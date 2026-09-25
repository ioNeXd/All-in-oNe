import { describe, expect, it } from "vitest";
import { dateKey, dailyNoteFilename, templateNoteFilename, firstAvailableTemplateSuffix, sanitizeTemplateName } from "../src/modules/calendar/CalendarNotes";

const date = new Date(2026, 8, 24);

describe("CalendarNotes", () => {
\tit("usa YYYY-MM-DD", () => {
\t\texpect(dateKey(date)).toBe("2026-09-24");
\t\texpect(dailyNoteFilename(date)).toBe("2026-09-24.md");
\t});
\tit("gera nomes de template por data", () => {
\t\texpect(templateNoteFilename("Reuniao", date)).toBe("Reuniao-2026-09-24.md");
\t\texpect(templateNoteFilename("Reuniao", date, 2)).toBe("Reuniao-2-2026-09-24.md");
\t});
\tit("usa o primeiro número livre, não count+1", () => {
\t\tconst names = ["Reuniao-2026-09-24.md","Reuniao-2-2026-09-24.md","Reuniao-4-2026-09-24.md"];
\t\texpect(firstAvailableTemplateSuffix(names,"Reuniao",date)).toBe(3);
\t});
\tit("sanitiza nome e remove extensão", () => {
\t\texpect(sanitizeTemplateName("pessoal/Reuniao.md")).toBe("Reuniao");
\t});
});
