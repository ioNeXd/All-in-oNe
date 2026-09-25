import { describe, it, expect } from "vitest";
import { parseIcs, mergeIcsEvents, IcsParseError } from "../src/modules/calendar/IcsParser";
import type { CalendarEvent } from "../src/modules/calendar/EventTypes";

function buildIcs(vevents: string[], extra = ""): string {
	return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Teste//All in oNe//PT-BR", ...vevents, extra, "END:VCALENDAR"].join("\r\n");
}

function vevent(lines: string[]): string {
	return ["BEGIN:VEVENT", ...lines, "END:VEVENT"].join("\r\n");
}

describe("parseIcs — evento simples", () => {
	it("converte VEVENT de data inteira para evento único", () => {
		const { events, warnings } = parseIcs(buildIcs([vevent(["UID:ev-1", "SUMMARY:Reunião de projeto", "DTSTART;VALUE=DATE:20260915"])]));
		expect(warnings).toEqual([]);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ title: "Reunião de projeto", day: 15, month: 9, year: 2026, recurrence: "once", reminder: true, id: "ics:ev-1" });
		expect(events[0].time).toBeUndefined();
	});
	it("converte data-hora local para HH:MM", () => {
		const { events } = parseIcs(buildIcs([vevent(["UID:ev-2", "SUMMARY:Consulta", "DTSTART:20260915T143000"])]));
		expect(events[0].time).toBe("14:30");
		expect(events[0].day).toBe(15);
	});
	it("desdobra linhas longas sem truncar título nem descrição", () => {
		const { events } = parseIcs(buildIcs([vevent(["UID:ev-3", "SUMMARY:Titulo muito longo que foi ", " quebrado no meio pelo exportador", "DESCRIPTION:Primeira linha ", " da descricao quebrada", "DTSTART;VALUE=DATE:20260915"])]));
		expect(events[0].title).toBe("Titulo muito longo que foi quebrado no meio pelo exportador");
		expect(events[0].description).toBe("Primeira linha da descricao quebrada");
	});
	it("converte escapes do iCalendar", () => {
		const { events } = parseIcs(buildIcs([vevent(["UID:ev-4", "SUMMARY:Reunião\\, parte 2\\; continue", "DTSTART;VALUE=DATE:20260915"])]));
		expect(events[0].title).toBe("Reunião, parte 2; continue");
	});
	it("SUMMARY ausente vira título genérico", () => {
		const { events } = parseIcs(buildIcs([vevent(["UID:ev-5", "DTSTART;VALUE=DATE:20260915"])]));
		expect(events[0].title).toBe("Evento importado do .ics");
	});
	it("mantém a ordem dos VEVENTs", () => {
		const { events } = parseIcs(buildIcs([vevent(["UID:a", "SUMMARY:Primeiro", "DTSTART;VALUE=DATE:20260901"]), vevent(["UID:b", "SUMMARY:Segundo", "DTSTART;VALUE=DATE:20261002"])]));
		expect(events.map((e) => e.title)).toEqual(["Primeiro", "Segundo"]);
		expect(events.map((e) => e.id)).toEqual(["ics:a", "ics:b"]);
	});
});

describe("parseIcs — RRULE", () => {
	it("FREQ=YEARLY vira recurrence yearly, sem ano fixo", () => {
		const { events, warnings } = parseIcs(buildIcs([vevent(["UID:aniv", "SUMMARY:Aniversário", "DTSTART;VALUE=DATE:19900915", "RRULE:FREQ=YEARLY"])]));
		expect(warnings).toEqual([]);
		expect(events[0].recurrence).toBe("yearly");
		expect(events[0].year).toBeUndefined();
	});
	it("FREQ=MONTHLY vira evento único com aviso", () => {
		const { events, warnings } = parseIcs(buildIcs([vevent(["UID:mensal", "SUMMARY:Boleto", "DTSTART;VALUE=DATE:20260910", "RRULE:FREQ=MONTHLY"])]));
		expect(events[0]).toMatchObject({ recurrence: "once", year: 2026 });
		expect(warnings[0]).toContain("Boleto");
		expect(warnings[0]).toContain("único");
	});
	it("RRULE sem FREQ reconhecível vira evento único com aviso", () => {
		const { events, warnings } = parseIcs(buildIcs([vevent(["UID:x", "SUMMARY:Estranho", "DTSTART;VALUE=DATE:20260910", "RRULE:QUALQUERCOISA"])]));
		expect(events[0].recurrence).toBe("once");
		expect(warnings[0]).toContain("Estranho");
	});
});

describe("parseIcs — malformado e casos-limite", () => {
	it("texto que não é .ics lança IcsParseError", () => {
		expect(() => parseIcs("isto não é um calendário")).toThrow(IcsParseError);
		expect(() => parseIcs("isto não é um calendário")).toThrow(/VCALENDAR/);
	});
	it(".ics vazio lança IcsParseError", () => {
		expect(() => parseIcs("")).toThrow(IcsParseError);
		expect(() => parseIcs("   \n\t")).toThrow(IcsParseError);
	});
	it("VCALENDAR sem VEVENT lança IcsParseError", () => {
		expect(() => parseIcs(buildIcs([]))).toThrow(/nenhum evento/);
	});
	it("VEVENT sem DTSTART é descartado com warning", () => {
		const { events, warnings } = parseIcs(buildIcs([vevent(["UID:ruim", "SUMMARY:Sem data"]), vevent(["UID:bom", "SUMMARY:Com data", "DTSTART;VALUE=DATE:20260915"])]));
		expect(events.map((e) => e.id)).toEqual(["ics:bom"]);
		expect(warnings).toHaveLength(1);
	});
	it("data impossível é descartada em vez de normalizada pelo Date", () => {
		const { events, warnings } = parseIcs(buildIcs([vevent(["UID:ruim", "SUMMARY:Data inválida", "DTSTART;VALUE=DATE:20260230"])]));
		expect(events).toHaveLength(0);
		expect(warnings[0]).toContain("data inválida");
	});
	it("horário impossível é descartado", () => {
		const { events, warnings } = parseIcs(buildIcs([vevent(["UID:ruim", "SUMMARY:Hora inválida", "DTSTART:20260915T256000"])]));
		expect(events).toHaveLength(0);
		expect(warnings[0]).toContain("data de início");
	});
	it("preserva anos com menos de 100 sem a conversão 1900+ do construtor Date", () => {
		const { events } = parseIcs(buildIcs([vevent(["UID:antigo", "SUMMARY:Ano antigo", "DTSTART;VALUE=DATE:00900915"])]));
		expect(events[0].year).toBe(90);
	});
	it("detecta TZID como limitação explícita", () => {
		const { limitations } = parseIcs(buildIcs([vevent(["UID:tz", "DTSTART;TZID=America/Sao_Paulo:20260915T143000"])]));
		expect(limitations).toContain("timezone: DTSTART com TZID não mapeado — interpretado como horário local");
	});
	it("detecta VTIMEZONE como limitação", () => {
		const { limitations } = parseIcs(buildIcs([vevent(["UID:tz", "DTSTART:20260915T143000"])], "BEGIN:VTIMEZONE\r\nTZID:America/Sao_Paulo\r\nEND:VTIMEZONE"));
		expect(limitations).toContain("timezone: VTIMEZONE ignorado — horários usados no fuso local da máquina");
	});
	it("BEGIN:VEVENT sem END conta warning e não derruba o restante", () => {
		const ics = ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:truncado", "SUMMARY:Truncado", "DTSTART;VALUE=DATE:20260915", "BEGIN:VEVENT", "UID:completo", "SUMMARY:Completo", "DTSTART;VALUE=DATE:20261010", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
		const { events, warnings } = parseIcs(ics);
		expect(events.map((e) => e.title)).toContain("Completo");
		expect(warnings.some((w) => w.includes("incompletos"))).toBe(true);
	});
	it("VEVENT sem UID importa com id determinístico", () => {
		const { events } = parseIcs(buildIcs([vevent(["SUMMARY:Sem uid", "DTSTART;VALUE=DATE:20260915"])]));
		expect(events[0].id).toBe("ics:sem-uid-0");
	});
	it("DTSTART UTC mantém o dia esperado", () => {
		const { events } = parseIcs(buildIcs([vevent(["UID:utc", "SUMMARY:UTC", "DTSTART:20260915T030000Z"])]));
		expect(events[0].day).toBe(15);
	});
});

describe("mergeIcsEvents", () => {
	const base: CalendarEvent = { id: "ics:a", title: "Original", description: "", recurrence: "once", day: 1, month: 5, year: 2026, reminder: true };
	it("importar o mesmo evento duas vezes não duplica", () => {
		const first = mergeIcsEvents([], [base]);
		const second = mergeIcsEvents(first, [{ ...base, title: "Atualizado" }]);
		expect(second).toHaveLength(1);
		expect(second[0].title).toBe("Atualizado");
	});
	it("eventos manuais nunca são tocados", () => {
		const manual: CalendarEvent = { ...base, id: "evt-1758000000000", title: "Feito na mão" };
		expect(mergeIcsEvents([manual], [base])).toHaveLength(2);
	});
	it("importação vazia mantém existentes", () => {
		const existing = [base, { ...base, id: "ics:b" }];
		expect(mergeIcsEvents(existing, [])).toEqual(existing);
	});
	it("deduplica UIDs repetidos no mesmo lote mantendo a última ocorrência", () => {
		const first = { ...base, title: "Primeiro" };
		const second = { ...base, title: "Último" };
		expect(mergeIcsEvents([], [first, second])).toEqual([second]);
	});
});
