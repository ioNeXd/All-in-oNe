import { describe, it, expect } from "vitest";
import { parseIcs, mergeIcsEvents, IcsParseError } from "../src/modules/calendar/IcsParser";
import type { CalendarEvent } from "../src/modules/calendar/EventTypes";

/**
 * IMPORTA O CÓDIGO REAL do parser de .ics do Calendário (IcsParser.ts) —
 * regra de negócio pura, sem I/O de vault, no padrão do projeto.
 */

/** Minimal, mas com a estrutura que exportadores reais (Google, Outlook) geram. */
function buildIcs(vevents: string[], extra = ""): string {
	return [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//Teste//All in oNe//PT-BR",
		...vevents,
		extra,
		"END:VCALENDAR",
	].join("\r\n");
}

function vevent(lines: string[]): string {
	return ["BEGIN:VEVENT", ...lines, "END:VEVENT"].join("\r\n");
}

describe("parseIcs — evento simples", () => {
	it("converte VEVENT de data inteira (VALUE=DATE) para evento anual por padrão de leitura… não: para único, com ano", () => {
		const { events, warnings } = parseIcs(
			buildIcs([vevent(["UID:ev-1", "SUMMARY:Reunião de projeto", "DTSTART;VALUE=DATE:20260915"])])
		);

		expect(warnings).toEqual([]);
		expect(events).toHaveLength(1);
		const e = events[0];
		expect(e.title).toBe("Reunião de projeto");
		expect(e.day).toBe(15);
		expect(e.month).toBe(9);
		expect(e.year).toBe(2026);
		expect(e.recurrence).toBe("once");
		expect(e.time).toBeUndefined(); // dia inteiro: dispara a qualquer hora
		expect(e.reminder).toBe(true);
		expect(e.id).toBe("ics:ev-1");
	});

	it("converte data-hora local para day/month/year + time HH:MM", () => {
		const { events } = parseIcs(
			buildIcs([vevent(["UID:ev-2", "SUMMARY:Consulta", "DTSTART:20260915T143000"])])
		);
		expect(events[0].time).toBe("14:30");
		expect(events[0].day).toBe(15);
	});

	it("desdobramento de linhas longas (RFC 5545) não trunca título nem descrição", () => {
		// Na semântica da RFC, o espaço em branco logo após o CRLF é o MARCADOR
		// de dobra (não faz parte do conteúdo) — o espaço que pertence ao texto
		// fica no fim da linha física anterior.
		const { events } = parseIcs(
			buildIcs([
				vevent([
					"UID:ev-3",
					"SUMMARY:Titulo muito longo que foi ",
					" quebrado no meio pelo exportador",
					"DESCRIPTION:Primeira linha ",
					 " da descricao quebrada",
					"DTSTART;VALUE=DATE:20260915",
				]),
			])
		);
		expect(events).toHaveLength(1);
		expect(events[0].title).toBe("Titulo muito longo que foi quebrado no meio pelo exportador");
		expect(events[0].description).toBe("Primeira linha da descricao quebrada");
	});

	it("escapes do iCalendar (\\, e \\;) voltam a texto legível", () => {
		const { events } = parseIcs(
			buildIcs([vevent(["UID:ev-4", "SUMMARY:Reunião\\, parte 2\\; continue", "DTSTART;VALUE=DATE:20260915"])])
		);
		expect(events[0].title).toBe("Reunião, parte 2; continue");
	});

	it("SUMMARY ausente vira título genérico em vez de vazio", () => {
		const { events } = parseIcs(
			buildIcs([vevent(["UID:ev-5", "DTSTART;VALUE=DATE:20260915"])])
		);
		expect(events[0].title).toBe("Evento importado do .ics");
	});

	it("vários VEVENTs viram vários eventos, na ordem do arquivo", () => {
		const { events } = parseIcs(
			buildIcs([
				vevent(["UID:a", "SUMMARY:Primeiro", "DTSTART;VALUE=DATE:20260901"]),
				vevent(["UID:b", "SUMMARY:Segundo", "DTSTART;VALUE=DATE:20261002"]),
			])
		);
		expect(events.map((e) => e.title)).toEqual(["Primeiro", "Segundo"]);
		expect(events.map((e) => e.id)).toEqual(["ics:a", "ics:b"]);
	});
});

describe("parseIcs — RRULE (recorrência)", () => {
	it("FREQ=YEARLY vira recurrence yearly, sem ano fixo", () => {
		const { events, warnings } = parseIcs(
			buildIcs([vevent(["UID:aniv", "SUMMARY:Aniversário", "DTSTART;VALUE=DATE:19900915", "RRULE:FREQ=YEARLY"])])
		);
		expect(warnings).toEqual([]);
		expect(events[0].recurrence).toBe("yearly");
		expect(events[0].year).toBeUndefined();
		expect(events[0].day).toBe(15);
		expect(events[0].month).toBe(9);
	});

	it("FREQ=MONTHLY vira evento único COM aviso (o modelo não mente 'repete todo ano')", () => {
		const { events, warnings } = parseIcs(
			buildIcs([vevent(["UID:mensal", "SUMMARY:Boleto", "DTSTART;VALUE=DATE:20260910", "RRULE:FREQ=MONTHLY"])])
		);
		expect(events).toHaveLength(1);
		expect(events[0].recurrence).toBe("once");
		expect(events[0].year).toBe(2026);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("Boleto");
		expect(warnings[0]).toContain("único");
	});

	it("RRULE sem FREQ reconhecível vira evento único com aviso", () => {
		const { events, warnings } = parseIcs(
			buildIcs([vevent(["UID:x", "SUMMARY:Estranho", "DTSTART;VALUE=DATE:20260910", "RRULE:QUALQUERCOISA"])])
		);
		expect(events[0].recurrence).toBe("once");
		expect(warnings[0]).toContain("Estranho");
	});
});

describe("parseIcs — malformado e casos-limite", () => {
	it("texto que não é .ics lança IcsParseError com mensagem clara", () => {
		expect(() => parseIcs("isto não é um calendário")).toThrow(IcsParseError);
		expect(() => parseIcs("isto não é um calendário")).toThrow(/VCALENDAR/);
	});

	it(".ics vazio lança IcsParseError", () => {
		expect(() => parseIcs("")).toThrow(IcsParseError);
		expect(() => parseIcs("   \n\t")).toThrow(IcsParseError);
	});

	it("VCALENDAR sem nenhum VEVENT lança IcsParseError", () => {
		expect(() => parseIcs(buildIcs([]))).toThrow(/nenhum evento/);
	});

	it("VEVENT sem DTSTART é descartado com warning — os bons continuam", () => {
		const { events, warnings } = parseIcs(
			buildIcs([
				vevent(["UID:ruim", "SUMMARY:Sem data"]),
				vevent(["UID:bom", "SUMMARY:Com data", "DTSTART;VALUE=DATE:20260915"]),
			])
		);
		expect(events.map((e) => e.id)).toEqual(["ics:bom"]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("Sem data");
	});

	it("BEGIN:VEVENT sem END (arquivo truncado) é contado nos warnings, não derruba o resto", () => {
		const ics = [
			"BEGIN:VCALENDAR",
			"BEGIN:VEVENT",
			"UID:truncado",
			"SUMMARY:Truncado",
			"DTSTART;VALUE=DATE:20260915",
			"BEGIN:VEVENT",
			"UID:completo",
			"SUMMARY:Completo",
			"DTSTART;VALUE=DATE:20261010",
			"END:VEVENT",
			"END:VCALENDAR",
		].join("\r\n");
		const { events, warnings } = parseIcs(ics);
		expect(events.map((e) => e.title)).toContain("Completo");
		expect(warnings.some((w) => w.includes("incompletos"))).toBe(true);
	});

	it("VEVENT sem UID ainda importa, com id determinístico por posição", () => {
		const { events } = parseIcs(
			buildIcs([vevent(["SUMMARY:Sem uid", "DTSTART;VALUE=DATE:20260915"])])
		);
		expect(events[0].id).toBe("ics:sem-uid-0");
	});

	it("DTSTART em UTC (sufixo Z) mantém o dia local correto para fuso negativo de Brasília", () => {
		// 2026-09-15T03:00Z = 2026-09-15 00:00 em UTC-3 — o dia NÃO muda.
		const { events } = parseIcs(
			buildIcs([vevent(["UID:utc", "SUMMARY:UTC", "DTSTART:20260915T030000Z"])])
		);
		expect(events[0].day).toBe(15);
		expect(events[0].month).toBe(9);
	});
});

describe("mergeIcsEvents — mescla por UID sem duplicar", () => {
	const base: CalendarEvent = {
		id: "ics:a",
		title: "Original",
		description: "",
		recurrence: "once",
		day: 1,
		month: 5,
		year: 2026,
		reminder: true,
	};

	it("importar o mesmo arquivo duas vezes não duplica (id substitui)", () => {
		const first = mergeIcsEvents([], [base]);
		const second = mergeIcsEvents(first, [{ ...base, title: "Atualizado" }]);
		expect(second).toHaveLength(1);
		expect(second[0].title).toBe("Atualizado");
	});

	it("eventos criados à mão nunca são tocados pela importação", () => {
		const manual: CalendarEvent = { ...base, id: "evt-1758000000000", title: "Feito na mão" };
		const merged = mergeIcsEvents([manual], [base]);
		expect(merged).toHaveLength(2);
		expect(merged.find((e) => e.id === "evt-1758000000000")?.title).toBe("Feito na mão");
	});

	it("importação vazia mantém os eventos existentes intactos", () => {
		const existing = [base, { ...base, id: "ics:b" }];
		expect(mergeIcsEvents(existing, [])).toEqual(existing);
	});
});
