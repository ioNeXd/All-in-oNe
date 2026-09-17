import { describe, it, expect } from "vitest";
import { shouldFire, monthFolderName, describeEvent } from "../src/modules/calendar/EventTypes";
import type { CalendarEvent } from "../src/modules/calendar/EventTypes";

function makeEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
	return {
		id: "evt-1",
		title: "Aniversário do Fulano",
		description: "lembrar de comprar presente",
		recurrence: "yearly",
		day: 15,
		month: 9,
		reminder: true,
		...overrides,
	};
}	describe("disparo de eventos do calendário", () => {
	it("dispara no dia certo de um evento anual", () => {
		expect(shouldFire(makeEvent(), new Date(2026, 8, 15, 10, 0))).toBe(true);
	});

	it("não dispara em outro dia", () => {
		expect(shouldFire(makeEvent(), new Date(2026, 8, 14, 10, 0))).toBe(false);
	});

	it("evento anual não repete no mesmo ano", () => {
		const event = makeEvent({ lastFiredYear: 2026 });
		expect(shouldFire(event, new Date(2026, 8, 15, 10, 0))).toBe(false);
		// ...mas volta a disparar no ano seguinte
		expect(shouldFire(event, new Date(2027, 8, 15, 10, 0))).toBe(true);
	});

	it("evento único só dispara no ano marcado", () => {
		const event = makeEvent({ recurrence: "once", year: 2026 });
		expect(shouldFire(event, new Date(2026, 8, 15, 10, 0))).toBe(true);
		expect(shouldFire(event, new Date(2027, 8, 15, 10, 0))).toBe(false);
	});

	it("com horário, só dispara depois da hora marcada", () => {
		const event = makeEvent({ time: "14:30" });
		expect(shouldFire(event, new Date(2026, 8, 15, 14, 29))).toBe(false);
		expect(shouldFire(event, new Date(2026, 8, 15, 14, 30))).toBe(true);
		expect(shouldFire(event, new Date(2026, 8, 15, 23, 0))).toBe(true);
	});
});

describe("pasta do mês", () => {
	it("usa número com zero à esquerda e nome do mês", () => {
		expect(monthFolderName(0)).toBe("01 - Janeiro");
		expect(monthFolderName(8)).toBe("09 - Setembro");
		expect(monthFolderName(11)).toBe("12 - Dezembro");
	});
});

describe("descrição do evento", () => {
	it("descreve um evento anual com lembrete", () => {
		expect(describeEvent(makeEvent())).toContain("todo ano em 15/09");
		expect(describeEvent(makeEvent())).toContain("com lembrete");
	});

	it("descreve um evento único com horário e nota vinculada", () => {
		// noteRefId é um identificador interno, não um caminho — o texto não
		// deve expor um "caminho de arquivo" que pode nem existir mais.
		const text = describeEvent(
			makeEvent({ recurrence: "once", year: 2026, time: "09:00", noteRefId: "note-123" })
		);
		expect(text).toContain("15/09/2026");
		expect(text).toContain("às 09:00");
		expect(text).toContain("abre uma nota vinculada");
	});
});
