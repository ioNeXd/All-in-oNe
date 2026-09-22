import { describe, it, expect, vi } from "vitest";
import { shouldFire, monthFolderName, describeEvent } from "../src/modules/calendar/EventTypes";
import type { CalendarEvent } from "../src/modules/calendar/EventTypes";
import { CalendarModule } from "../src/modules/calendar/CalendarModule";

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

/**
 * Reset nível "data" do Calendário (onResetData implementado na revisão do
 * 0.2.0): eventos importados de .ics (id `ics:<uid>`) são dados derivados
 * de um arquivo e SAEM; os criados à mão (id `evt-*`) são configuração do
 * usuário e FICAM. Importa a classe real contra um contexto falso (padrão
 * de tests/HistoryModule.test.ts).
 */
describe("onResetData do Calendário — dados × configuração", () => {
	function setup(events: CalendarEvent[]) {
		const module = new CalendarModule();
		const slice = {
			events: structuredClone(events),
			view: "month" as const,
			eventNotesFolder: "Calendario/notas",
			autoFocusOnReminder: false,
		};
		const updateSettings = vi.fn(async (patch: Record<string, unknown>) => {
			if (Array.isArray(patch.events)) slice.events = structuredClone(patch.events);
			return [];
		});
		module.onRegister({
			app: {} as never,
			bus: {} as never,
			getSettings: () => JSON.parse(JSON.stringify(slice)) as typeof slice,
			updateSettings,
			getFullSettings: () => ({ modules: { calendar: slice } }) as never,
			isModuleEnabled: () => true,
			log: () => {},
			registerCommand: () => {},
			fileWriteQueueRun: async (_p: string, op: () => Promise<unknown>) => op(),
			updatePaths: async () => [],
		} as never);
		return { module, updateSettings, slice };
	}

	it("limpa eventos importados (ics:) e preserva os criados à mão (evt-)", async () => {
		const { module, updateSettings, slice } = setup([
			{ id: "ics:abc@x", title: "Do calendário", description: "", recurrence: "once", day: 1, month: 1, reminder: false },
			{ id: "evt-manual", title: "Manual", description: "", recurrence: "yearly", day: 2, month: 1, reminder: true },
		]);
		await module.onResetData();
		expect(updateSettings).toHaveBeenCalledTimes(1);
		expect(slice.events.map((e) => e.id)).toEqual(["evt-manual"]);
	});

	it("com só eventos importados, a fatia fica vazia", async () => {
		const { module, slice } = setup([
			{ id: "ics:only@x", title: "X", description: "", recurrence: "once", day: 3, month: 1, reminder: false },
		]);
		await module.onResetData();
		expect(slice.events).toEqual([]);
	});
});
