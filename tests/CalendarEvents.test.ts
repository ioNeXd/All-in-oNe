import { describe, it, expect, vi } from "vitest";
import {
	shouldFire,
	monthFolderName,
	describeEvent,
	nextEventDelayMs,
	MAX_SCHEDULE_DELAY_MS,
	MIN_SCHEDULE_DELAY_MS,
} from "../src/modules/calendar/EventTypes";
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
}

describe("disparo de eventos do calendário", () => {
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

	it("horário inválido nunca dispara", () => {
		const event = makeEvent({ time: "25:99" });
		expect(shouldFire(event, new Date(2026, 8, 15, 23, 59))).toBe(false);
	});

	/**
	 * Contrato do evento SEM horário — decisão de produto explicitada no item
	 * 19 da auditoria: "a qualquer hora do dia", NÃO um default 00:00.
	 */
	describe("evento sem horário — 'a qualquer hora do dia'", () => {
		it("é elegível o DIA INTEIRO: dispara à meia-noite, de manhã e à noite", () => {
			// Exatamente o comportamento que motivou o item — agora travado
			// como contrato, não como acaso do primeiro tick:
			expect(shouldFire(makeEvent(), new Date(2026, 8, 15, 0, 0))).toBe(true);
			expect(shouldFire(makeEvent(), new Date(2026, 8, 15, 10, 0))).toBe(true);
			expect(shouldFire(makeEvent(), new Date(2026, 8, 15, 23, 59))).toBe(true);
		});

		it("NUNCA alcança outro dia — nem retroativo, nem futuro", () => {
			// A propriedade que protege o usuário do disparo retrôativo errado:
			// Obsidian aberto em 16/09 NÃO recebe o lembrete de 15/09 "atrasado".
			expect(shouldFire(makeEvent(), new Date(2026, 8, 14, 23, 59))).toBe(false);
			expect(shouldFire(makeEvent(), new Date(2026, 8, 16, 0, 0))).toBe(false);
			expect(shouldFire(makeEvent(), new Date(2026, 8, 20, 10, 0))).toBe(false);
		});

		it("anual sem horário dispara UMA vez: o estado (lastFiredYear) bloqueia, não a janela de horas", () => {
			// A restrição real é a marca de disparo, não o relógio — fireEvent
			// grava lastFiredYear e o resto do dia o predicado já nega:
			const fired = makeEvent({ lastFiredYear: 2026 });
			expect(shouldFire(fired, new Date(2026, 8, 15, 10, 0))).toBe(false);
			expect(shouldFire(fired, new Date(2026, 8, 15, 23, 59))).toBe(false);
			// E volta a ser elegível no próximo ano, em qualquer hora do dia:
			expect(shouldFire(makeEvent({ lastFiredYear: 2025 }), new Date(2026, 8, 15, 3, 0))).toBe(true);
		});

		it("evento único sem horário é elegível no dia marcado e nunca fora dele", () => {
			const once = makeEvent({ recurrence: "once", year: 2026 });
			expect(shouldFire(once, new Date(2026, 8, 15, 0, 5))).toBe(true);
			expect(shouldFire(once, new Date(2027, 8, 15, 10, 0))).toBe(false);
		});
	});
});

describe("pasta do mês", () => {
	it("usa número com zero à esquerda e nome do mês", () => {
		expect(monthFolderName(0)).toBe("01 - Janeiro");
		expect(monthFolderName(8)).toBe("09 - Setembro");
		expect(monthFolderName(11)).toBe("12 - Dezembro");
	});

	it("rejeita índice de mês fora do intervalo", () => {
		expect(() => monthFolderName(-1)).toThrow(RangeError);
		expect(() => monthFolderName(12)).toThrow(RangeError);
		expect(() => monthFolderName(1.5)).toThrow(RangeError);
	});
});

describe("descrição do evento", () => {
	it("descreve um evento anual com lembrete", () => {
		expect(describeEvent(makeEvent())).toContain("todo ano em 15/09");
		expect(describeEvent(makeEvent())).toContain("com lembrete");
	});

	it("evento sem horário diz explicitamente 'a qualquer hora do dia'", () => {
		expect(describeEvent(makeEvent())).toContain("a qualquer hora do dia");
		expect(describeEvent(makeEvent({ time: "09:00" }))).not.toContain("a qualquer hora do dia");
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
			{ id: "ics:abc@x", source: "ics", title: "Do calendário", description: "", recurrence: "once", day: 1, month: 1, reminder: false },
			{ id: "evt-manual", source: "manual", title: "Manual", description: "", recurrence: "yearly", day: 2, month: 1, reminder: true },
		]);
		await module.onResetData();
		expect(updateSettings).toHaveBeenCalledTimes(1);
		expect(slice.events.map((e) => e.id)).toEqual(["evt-manual"]);
	});

	it("com só eventos importados, a fatia fica vazia", async () => {
		const { module, slice } = setup([
			{ id: "ics:only@x", source: "ics", title: "X", description: "", recurrence: "once", day: 3, month: 1, reminder: false },
		]);
		await module.onResetData();
		expect(slice.events).toEqual([]);
	});
});

describe("nextEventDelayMs — agendamento por evento (em vez de polling)", () => {
	const NOW = new Date(2026, 8, 23, 10, 0, 0, 0); // 23/09/2026 10:00:00.000

	it("evento DISTANTE (4h30): devolve o teto de rotina — o agendador re-checa e re-agenda a cada 1h", () => {
		// Contrato: o teto de 1h é o look-ahead máximo do setTimeout. Evento
		// mais longe que isso agenda o teto; na checagem seguinte re-agenda,
		// até o delta entrar na janela precisa (testes abaixo).
		const events = [makeEvent({ day: 23, month: 9, time: "14:30" })]; // 4h30 de distância
		expect(nextEventDelayMs(events, NOW)).toBe(MAX_SCHEDULE_DELAY_MS);
	});

	it("evento DENTRO da janela de 1h: agendamento EXATO", () => {
		const events = [makeEvent({ day: 23, month: 9, time: "10:30" })]; // 30min de distância
		expect(nextEventDelayMs(events, NOW)).toBe(30 * 60 * 1000);
	});

	it("usa a data do evento, não a data de hoje, para a próxima ocorrência", () => {
		const events = [makeEvent({ day: 24, month: 9, time: "10:30" })];
		expect(nextEventDelayMs(events, NOW)).toBe(MAX_SCHEDULE_DELAY_MS);
	});

	it("evento anual em outro mês é agendado na próxima ocorrência", () => {
		const events = [makeEvent({ day: 23, month: 10, time: "10:30" })];
		expect(nextEventDelayMs(events, NOW)).toBe(MAX_SCHEDULE_DELAY_MS);
	});

	it("horário anual que JÁ PASSOU espera a próxima ocorrência anual", () => {
		const lateNight = new Date(2026, 8, 23, 23, 40, 0, 0); // 23:40
		const events = [makeEvent({ day: 23, month: 9, time: "00:10" })];
		// O horário de hoje já passou; a próxima ocorrência é 23/09/2027.
		expect(nextEventDelayMs(events, lateNight)).toBe(MAX_SCHEDULE_DELAY_MS);
	});

	it("sem eventos com horário: teto de rotina (1h), nunca polling curto", () => {
		const events = [makeEvent({ day: 23, month: 9 })]; // sem time
		expect(nextEventDelayMs(events, NOW)).toBe(MAX_SCHEDULE_DELAY_MS);
		expect(nextEventDelayMs([], NOW)).toBe(MAX_SCHEDULE_DELAY_MS);
	});

	it("evento anual já disparado este ano não entra no cálculo", () => {
		const fired = makeEvent({ day: 23, month: 9, time: "11:00", lastFiredYear: 2026 });
		expect(nextEventDelayMs([fired], NOW)).toBe(MAX_SCHEDULE_DELAY_MS);
	});

	it("o mais próximo vence quando há vários eventos", () => {
		const events = [
			makeEvent({ id: "a", day: 23, month: 9, time: "18:00" }),
			makeEvent({ id: "b", day: 23, month: 9, time: "10:30" }),
		];
		expect(nextEventDelayMs(events, NOW)).toBe(30 * 60 * 1000);
	});

	it("time malformado é ignorado (sem agendar para NaN)", () => {
		const events = [makeEvent({ day: 23, month: 9, time: " bananas " })];
		expect(nextEventDelayMs(events, NOW)).toBe(MAX_SCHEDULE_DELAY_MS);
	});

	it("time fora do intervalo também é ignorado", () => {
		const events = [makeEvent({ day: 23, month: 9, time: "25:99" })];
		expect(nextEventDelayMs(events, NOW)).toBe(MAX_SCHEDULE_DELAY_MS);
	});

	it("resultado nunca fica abaixo do mínimo (sem agendar para 'agora')", () => {
		const events = [makeEvent({ day: 23, month: 9, time: "10:00" })]; // é AGORA
		expect(nextEventDelayMs(events, NOW)).toBeGreaterThanOrEqual(MIN_SCHEDULE_DELAY_MS);
	});
});
