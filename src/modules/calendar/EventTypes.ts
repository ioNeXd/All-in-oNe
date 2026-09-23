/** Um evento do calendário, com lembrete opcional e nota vinculada. */
export interface CalendarEvent {
	id: string;
	title: string;
	/** Texto mostrado na janela do lembrete (ex.: "lembrar de comprar presente"). */
	description: string;
	recurrence: "once" | "yearly";
	/** Dia do mês (1-31). */
	day: number;
	/** Mês (1-12). */
	month: number;
	/** Ano — obrigatório só para eventos únicos. */
	year?: number;
	/**
	 * "HH:MM" — se ausente, dispara a QUALQUER HORA DO DIA (decisão de
	 * produto, não um default 00:00): o lembrete chega na primeira checagem
	 * do dia — inclusive retroativa, ao abrir o Obsidian depois da hora.
	 */
	time?: string;
	/** Se true, abre a janela de lembrete com som. */
	reminder: boolean;
	/**
	 * Identificador estável da nota vinculada — NÃO é o caminho/nome. Guardado
	 * também dentro da nota (campo `origem_evento` no frontmatter), então
	 * renomear ou mover a nota não quebra o vínculo: a localização é por
	 * busca de metadado, não por caminho de arquivo.
	 */
	noteRefId?: string;
	/** Ano em que já disparou — evita repetir no mesmo dia. */
	lastFiredYear?: number;
}

export const MONTH_NAMES = [
	"Janeiro",
	"Fevereiro",
	"Março",
	"Abril",
	"Maio",
	"Junho",
	"Julho",
	"Agosto",
	"Setembro",
	"Outubro",
	"Novembro",
	"Dezembro",
];

/** Pasta do mês no formato "09 - Setembro", como pedido. */
export function monthFolderName(monthIndexZeroBased: number): string {
	const number = String(monthIndexZeroBased + 1).padStart(2, "0");
	return `${number} - ${MONTH_NAMES[monthIndexZeroBased]}`;
}

export function describeEvent(event: CalendarEvent): string {
	const date = `${String(event.day).padStart(2, "0")}/${String(event.month).padStart(2, "0")}`;
	const when = event.recurrence === "yearly" ? `todo ano em ${date}` : `${date}/${event.year}`;
	const time = event.time ? ` às ${event.time}` : " · a qualquer hora do dia";
	const extras: string[] = [];
	if (event.reminder) extras.push("com lembrete");
	if (event.noteRefId) extras.push("abre uma nota vinculada");
	return `${when}${time}${extras.length ? ` · ${extras.join(", ")}` : ""}`;
}

/**
 * Decide se o evento deve disparar agora. Separado para ser testável.
 *
 * Contrato do evento SEM horário: elegível durante TODO o dia do evento —
 * a checagem retroativa entrega "na abertura do Obsidian", não "à meia-noite".
 * "Dispara UMA vez" é garantia do ESTADO de disparo (anual → lastFiredYear;
 * único → removido da lista em fireEvent), NÃO da janela de horas: enquanto
 * o estado não muda, este predicado continua true em qualquer minuto do dia
 * do evento. O dia exato no 1º if é o que impede o retroativo de alcançar
 * dias anteriores (nunca dispara ontem à noite, por exemplo).
 */
export function shouldFire(event: CalendarEvent, now: Date): boolean {
	if (event.day !== now.getDate() || event.month !== now.getMonth() + 1) return false;

	if (event.recurrence === "once") {
		if (event.year !== now.getFullYear()) return false;
	} else if (event.lastFiredYear === now.getFullYear()) {
		return false; // anual, já disparou este ano
	}

	if (event.time) {
		const [hour, minute] = event.time.split(":").map(Number);
		const target = hour * 60 + minute;
		const current = now.getHours() * 60 + now.getMinutes();
		if (current < target) return false; // ainda não chegou a hora
	}

	return true;
}

/**
 * Quanto tempo (ms) falta para o PRÓXIMO disparo futuro — regra pura que
 * alimenta o agendador por setTimeout (em vez de polling fixo de 10s).
 * Eventos com horário marcado de hoje/amanhã (anuais inclusive) entram na
 * conta; sem horário, o disparo é "em qualquer momento do dia", então não
 * adianta horário — a re-checagem de rotina (teto) cobre a virada.
 * Sem nada agendável: teto padrão (re-checagem de rotina, p.ex. virada de
 * dia), nunca polling curto.
 *
 * Invariante: o resultado é SEMPRE >= 1_000 (nunca agenda para "agora" —
 * quem decide disparar é o shouldFire na hora da checagem, evitando rajada).
 */
export const MAX_SCHEDULE_DELAY_MS = 60 * 60 * 1000; // 1h: re-checagem de rotina
export const MIN_SCHEDULE_DELAY_MS = 1_000;

export function nextEventDelayMs(events: readonly CalendarEvent[], now: Date): number {
	let best = MAX_SCHEDULE_DELAY_MS;
	for (const event of events) {
		if (event.recurrence === "once" && event.year !== now.getFullYear()) continue;
		if (event.recurrence === "yearly" && event.lastFiredYear === now.getFullYear()) continue;
		if (!event.time) continue; // sem horário: não há "próximo momento" preciso

		const [hour, minute] = event.time.split(":").map(Number);
		if (!Number.isFinite(hour) || !Number.isFinite(minute)) continue;

		const candidates: Date[] = [
			new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0),
		];
		// Evento com horário de hoje que JÁ PASSOU (e ainda elegível — p.ex.
		// Obsidian fechado na hora): o próximo é amanhã, mesmo dia/mês futuro
		// do ano que vem para anual.
		const tomorrow = new Date(candidates[0]);
		tomorrow.setDate(tomorrow.getDate() + 1);
		candidates.push(tomorrow);

		for (const when of candidates) {
			const delta = when.getTime() - now.getTime();
			if (delta > 0 && delta < best) best = delta;
		}
	}
	return Math.max(MIN_SCHEDULE_DELAY_MS, best);
}
