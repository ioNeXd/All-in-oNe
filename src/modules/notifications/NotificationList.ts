/**
 * FILTRO E AGRUPAMENTO DA CENTRAL DE NOTIFICAÇÕES — PURO, SEM DOM
 * ----------------------------------------------------------------
 * A lista do painel era puramente cronológica (settings.history.slice(0,50)):
 * num vault ativo, dezenas de "Arquivo criado" do mesmo dia enterravam o que
 * importava. Este arquivo concentra as DUAS regras de apresentação novas —
 * filtro por tipo de gatilho e agrupamento por dia — como funções puras ao
 * lado do módulo (padrão do projeto), testadas contra o código real.
 *
 * O `now` é SEMPRE parâmetro: dia de hoje/ontem não pode depender do
 * relógio da máquina no meio do teste.
 */

import type { NotifiableTrigger, StoredNotification } from "./NotificationsModule";

/** Valor do dropdown: "all" ou um gatilho específico. */
export type NotificationListFilter = "all" | NotifiableTrigger;

/**
 * Filtra o histórico pelo gatilho escolhido. Preserva a ordem de entrada
 * (mais recente primeiro, como o módulo guarda). Um filtro DESCONHECIDO
 * (valor persistido de um gatilho que não existe mais) NÃO esconde nada:
 * degrada para "all" — lista vazia sem explicação é pior que lista cheia.
 * `knownTriggers` é opcional para facilitar o uso direto; o módulo passa
 * as chaves de TRIGGER_LABELS.
 */
export function filterNotifications(
	history: StoredNotification[],
	filter: NotificationListFilter,
	knownTriggers?: readonly string[]
): StoredNotification[] {
	if (filter === "all") return history;
	if (knownTriggers && !knownTriggers.includes(filter)) return history;
	return history.filter((entry) => entry.trigger === filter);
}

/**
 * Contagem por gatilho do histórico ATUAL — alimenta o dropdown (o usuário
 * vê que "Arquivo criado (12)" tem conteúdo antes de clicar).
 */
export function countByTrigger(history: StoredNotification[]): Partial<Record<NotifiableTrigger, number>> {
	const counts: Partial<Record<NotifiableTrigger, number>> = {};
	for (const entry of history) {
		counts[entry.trigger] = (counts[entry.trigger] ?? 0) + 1;
	}
	return counts;
}

export interface NotificationDayGroup {
	/** Rótulo do cabeçalho: "Hoje", "Ontem" ou a data por extenso (pt-BR). */
	label: string;
	/** Chave estável do dia local, "YYYY-MM-DD" — nunca exibida, só ordenação/teste. */
	dayKey: string;
	items: StoredNotification[];
}

/** "YYYY-MM-DD" no fuso LOCAL (mesmo fuso em que o usuário lê a lista). */
function localDayKey(timestamp: number): string {
	const d = new Date(timestamp);
	const month = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${d.getFullYear()}-${month}-${day}`;
}

function dayKeyOffset(now: Date, days: number): string {
	return localDayKey(now.getTime() - days * 86_400_000);
}

/**
 * Agrupa por dia LOCAL, do mais recente para o mais antigo, com rótulos
 * relativos: Hoje, Ontem, e data por extenso nos anteriores (com o ano só
 * quando difere do atual). Entradas de um mesmo dia preservam a ordem.
 * A ordem dos DIAS segue a primeira ocorrência no histórico (que já vem
 * mais-recente-primeiro), sem reordenar entradas entre dias.
 */
export function groupNotificationsByDay(
	history: StoredNotification[],
	now: Date
): NotificationDayGroup[] {
	const today = dayKeyOffset(now, 0);
	const yesterday = dayKeyOffset(now, 1);
	const thisYear = now.getFullYear();

	const groups: NotificationDayGroup[] = [];
	const byDay = new Map<string, NotificationDayGroup>();

	for (const entry of history) {
		const key = localDayKey(entry.timestamp);
		let group = byDay.get(key);
		if (!group) {
			group = { dayKey: key, label: labelForDay(key, { today, yesterday, thisYear }), items: [] };
			byDay.set(key, group);
			groups.push(group);
		}
		group.items.push(entry);
	}
	return groups;
}

function labelForDay(
	key: string,
	ctx: { today: string; yesterday: string; thisYear: number }
): string {
	if (key === ctx.today) return "Hoje";
	if (key === ctx.yesterday) return "Ontem";
	// key é "YYYY-MM-DD" — reconstrói a Date SEM fuso para rotular.
	const [year, month, day] = key.split("-").map(Number);
	const date = new Date(year, month - 1, day);
	const base = date.toLocaleDateString("pt-BR", {
		weekday: "long",
		day: "2-digit",
		month: "long",
	});
	return year === ctx.thisYear ? base : `${base} de ${year}`;
}

/**
 * Opções do dropdown de filtro: "Todas" + um por gatilho COM ocorrências
 * (um dropdown com 11 opções, 9 vazias, é ruído) — mas quando o filtro
 * PERSISTIDO aponta para um gatilho que hoje tem zero, ele entra do mesmo
 * jeito, senão a preferência salva "sumiria" do controle.
 */
export function buildFilterOptions(
	counts: Partial<Record<NotifiableTrigger, number>>,
	allTriggers: NotifiableTrigger[],
	labels: Record<NotifiableTrigger, string>,
	currentFilter: NotificationListFilter
): { value: NotificationListFilter; label: string }[] {
	const options: { value: NotificationListFilter; label: string }[] = [
		{ value: "all", label: `Todas (${Object.values(counts).reduce((a, b) => a + (b ?? 0), 0)})` },
	];
	for (const trigger of allTriggers) {
		const count = counts[trigger] ?? 0;
		if (count === 0 && trigger !== currentFilter) continue;
		options.push({ value: trigger, label: `${labels[trigger] ?? trigger} (${count})` });
	}
	return options;
}
