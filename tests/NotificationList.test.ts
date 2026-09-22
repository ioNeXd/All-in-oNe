import { describe, it, expect } from "vitest";
import {
	filterNotifications,
	groupNotificationsByDay,
	countByTrigger,
	buildFilterOptions,
	type NotificationListFilter,
} from "../src/modules/notifications/NotificationList";
import {
	TRIGGER_LABELS,
	type StoredNotification,
	type NotifiableTrigger,
} from "../src/modules/notifications/NotificationsModule";

/**
 * IMPORTA O CÓDIGO REAL das regras de apresentação da central de
 * notificações (NotificationList.ts) — puro, sem DOM, com `now` sempre
 * injetável para dias relativos (Hoje/Ontem) serem determinísticos.
 */

function makeEntry(overrides: Partial<StoredNotification> = {}): StoredNotification {
	const trigger: NotifiableTrigger = overrides.trigger ?? "file:created";
	return {
		id: overrides.id ?? `notif-${Math.random().toString(36).slice(2, 9)}`,
		trigger,
		message: overrides.message ?? `mensagem de ${trigger}`,
		timestamp: overrides.timestamp ?? new Date("2026-09-22T10:00:00").getTime(),
		read: overrides.read ?? false,
	};
}

/** Fixa "hoje" num dia útil neutro (quarta, 2026-09-23, fuso local do teste). */
const NOW = new Date(2026, 8, 23, 12, 0, 0);

describe("filterNotifications — filtro por tipo de gatilho", () => {
	const history = [
		makeEntry({ trigger: "file:created", id: "a" }),
		makeEntry({ trigger: "calendar:event-fired", id: "b" }),
		makeEntry({ trigger: "file:created", id: "c" }),
	];

	it("\"all\" devolve tudo, na ordem original", () => {
		expect(filterNotifications(history, "all").map((e) => e.id)).toEqual(["a", "b", "c"]);
	});

	it("filtra por um gatilho, preservando a ordem", () => {
		expect(filterNotifications(history, "file:created").map((e) => e.id)).toEqual(["a", "c"]);
		expect(filterNotifications(history, "calendar:event-fired").map((e) => e.id)).toEqual(["b"]);
	});

	it("gatilho sem ocorrências devolve lista vazia (comportamento esperado do filtro)", () => {
		expect(filterNotifications(history, "folder:deleted")).toEqual([]);
	});

	it("filtro DESCONHECIDO (gatilho removido no futuro) degrada para 'all' — lista vazia sem explicação é pior", () => {
		expect(filterNotifications(history, "gatilho-fantasma" as NotificationListFilter, Object.keys(TRIGGER_LABELS))).toEqual(history);
	});

	it("sem a lista de gatilhos conhecidos, filtro inválido filtra (vazio) — contrato mínimo", () => {
		expect(filterNotifications(history, "gatilho-fantasma" as NotificationListFilter)).toEqual([]);
	});
});

describe("countByTrigger — contagem para o dropdown", () => {
	it("conta por gatilho", () => {
		const history = [
			makeEntry({ trigger: "file:created" }),
			makeEntry({ trigger: "file:created" }),
			makeEntry({ trigger: "templates:note-pending" }),
		];
		expect(countByTrigger(history)).toEqual({
			"file:created": 2,
			"templates:note-pending": 1,
		});
	});

	it("histórico vazio → objeto vazio", () => {
		expect(countByTrigger([])).toEqual({});
	});
});

describe("groupNotificationsByDay — agrupamento por dia local", () => {
	it("Hoje e Ontem ganham rótulos relativos", () => {
		const todayEntry = makeEntry({ id: "hoje", timestamp: NOW.getTime() });
		const yesterdayEntry = makeEntry({
			id: "ontem",
			timestamp: NOW.getTime() - 24 * 60 * 60 * 1000,
		});
		const groups = groupNotificationsByDay([todayEntry, yesterdayEntry], NOW);

		expect(groups).toHaveLength(2);
		expect(groups[0].label).toBe("Hoje");
		expect(groups[0].items.map((e) => e.id)).toEqual(["hoje"]);
		expect(groups[1].label).toBe("Ontem");
	});

	it("dias mais antigos ganham data por extenso em pt-BR, sem ano no ano corrente", () => {
		// 2026-09-21 é segunda-feira (mesmo ano do NOW).
		const older = makeEntry({ id: "segunda", timestamp: new Date(2026, 8, 21, 9, 0).getTime() });
		const groups = groupNotificationsByDay([older], NOW);
		expect(groups[0].label).toBe("segunda-feira, 21 de setembro");
	});

	it("dia de outro ano inclui o ano no rótulo", () => {
		const old = makeEntry({ id: "2025", timestamp: new Date(2025, 11, 31, 23, 0).getTime() });
		const groups = groupNotificationsByDay([old], NOW);
		expect(groups[0].label).toContain("2025");
	});

	it("dias saem do mais recente para o mais antigo (ordem de primeira ocorrência)", () => {
		const e1 = makeEntry({ id: "hoje", timestamp: NOW.getTime() });
		const e2 = makeEntry({ id: "anteriores", timestamp: new Date(2026, 8, 20, 8, 0).getTime() });
		const e3 = makeEntry({ id: "hoje-2", timestamp: new Date(2026, 8, 23, 9, 0).getTime() });
		const groups = groupNotificationsByDay([e1, e2, e3], NOW);
		expect(groups.map((g) => g.dayKey)).toEqual(["2026-09-23", "2026-09-20"]);
		expect(groups[0].items.map((e) => e.id)).toEqual(["hoje", "hoje-2"]);
	});

	it("meia-noite exata cai no dia certo (fuso local, não UTC)", () => {
		const midnight = makeEntry({ id: "meianoite", timestamp: new Date(2026, 8, 23, 0, 0).getTime() });
		const groups = groupNotificationsByDay([midnight], NOW);
		expect(groups[0].dayKey).toBe("2026-09-23");
	});

	it("invariante: o agrupamento não perde nem duplica entradas", () => {
		const history = Array.from({ length: 30 }, (_, i) =>
			makeEntry({ id: `e${i}`, timestamp: NOW.getTime() - i * 7 * 60 * 60 * 1000 })
		);
		const groups = groupNotificationsByDay(history, NOW);
		const total = groups.reduce((sum, g) => sum + g.items.length, 0);
		expect(total).toBe(history.length);
		expect(groups.flatMap((g) => g.items).map((e) => e.id)).toEqual(history.map((e) => e.id));
	});
});

describe("buildFilterOptions — dropdown com contagens", () => {
	it("\"Todas\" vem primeiro com o total; gatilhos com zero não entram", () => {
		const options = buildFilterOptions(
			{ "file:created": 3, "calendar:event-fired": 1 },
			Object.keys(TRIGGER_LABELS) as NotifiableTrigger[],
			TRIGGER_LABELS,
			"all"
		);
		expect(options[0]).toEqual({ value: "all", label: "Todas (4)" });
		expect(options.find((o) => o.value === "file:created")?.label).toContain("(3)");
		expect(options.find((o) => o.value === "folder:deleted")).toBeUndefined();
	});

	it("o filtro PERSISTIDO entra mesmo com zero ocorrências — preferência salva não some do controle", () => {
		const options = buildFilterOptions(
			{},
			Object.keys(TRIGGER_LABELS) as NotifiableTrigger[],
			TRIGGER_LABELS,
			"folder:deleted"
		);
		expect(options.find((o) => o.value === "folder:deleted")).toBeDefined();
	});
});
