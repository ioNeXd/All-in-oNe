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
	/** "HH:MM" — se ausente, dispara a qualquer hora do dia. */
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
	/** Marcado quando um evento único já disparou (será removido). */
	done?: boolean;
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
	const time = event.time ? ` às ${event.time}` : "";
	const extras: string[] = [];
	if (event.reminder) extras.push("com lembrete");
	if (event.noteRefId) extras.push("abre uma nota vinculada");
	return `${when}${time}${extras.length ? ` · ${extras.join(", ")}` : ""}`;
}

/** Decide se o evento deve disparar agora. Separado para ser testável. */
export function shouldFire(event: CalendarEvent, now: Date): boolean {
	if (event.done) return false;
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
