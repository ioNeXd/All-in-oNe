import type { CalendarEvent } from "./EventTypes";

/**
 * PARSER DE ARQUIVOS .ics — PURO, SEM I/O DE VAULT
 * -------------------------------------------------
 * Recebe o TEXTO de um arquivo .ics (iCalendar, RFC 5545) e devolve eventos
 * no modelo do projeto (CalendarEvent, ver EventTypes.ts). Regra de negócio
 * pura em arquivo próprio ao lado do módulo — padrão do projeto (como
 * mcp/WriteRules.ts e core/NoteStatus.ts) — com suíte própria que importa
 * este código real.
 *
 * MAPA DE CONVERSÃO (o modelo do projeto é mais estreito que o iCalendar —
 * parte honesta da conversão, nunca aproximação silenciosa):
 *   - VEVENT            → CalendarEvent
 *   - SUMMARY           → title
 *   - DESCRIPTION       → description
 *   - DTSTART (data)    → day/month (+ year quando data absoluta)
 *   - DTSTART (data-hora local) → day/month/year + time "HH:MM"
 *   - DTSTART (UTC)     → idem, no horário local da máquina
 *   - RRULE FREQ=YEARLY → recurrence "yearly"
 *   - RRULE com outra frequência → recurrence "once" + WARNING por evento
 *   - Eventos sem DTSTART ou com data ilegível entram nos WARNINGS e não viram
 *     evento.
 *
 * DUPLICATAS: cada VEVENT vira um evento com id determinístico derivado do
 * UID do iCalendar (ics:<uid>), então importar o MESMO arquivo duas vezes NÃO
 * duplica — o mesclador do módulo substitui o evento anterior com o mesmo id.
 */

export interface IcsParseResult {
	events: CalendarEvent[];
	warnings: string[];
	limitations: string[];
}

export class IcsParseError extends Error {}

interface RawIcsEvent {
	uid?: string;
	summary?: string;
	description?: string;
	dtstart?: IcsDateTime;
	dtstartInvalid?: boolean;
	rrule?: string;
}

interface IcsDateTime {
	date: Date;
	allDay: boolean;
}

interface IcsLine {
	name: string;
	params: Record<string, string>;
	value: string;
}

export function unfoldIcsLines(raw: string): string[] {
	const physical = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
	const logical: string[] = [];
	for (const line of physical) {
		if ((line.startsWith(" ") || line.startsWith("\t")) && logical.length > 0) {
			logical[logical.length - 1] += line.slice(1);
		} else if (line.trim().length > 0) {
			logical.push(line);
		}
	}
	return logical;
}

function parseLine(line: string): IcsLine | undefined {
	const nameEnd = line.indexOf(":");
	if (nameEnd === -1) return undefined;
	const head = line.slice(0, nameEnd);
	const value = line.slice(nameEnd + 1);
	const headParts = head.split(";");
	const name = headParts[0].trim().toUpperCase();
	const params: Record<string, string> = {};
	for (const part of headParts.slice(1)) {
		const eq = part.indexOf("=");
		if (eq !== -1) params[part.slice(0, eq).trim().toUpperCase()] = part.slice(eq + 1).trim();
	}
	return { name, params, value };
}

function parseIcsDate(value: string, params: Record<string, string>): IcsDateTime | undefined {
	const raw = value.trim();
	if (/^\d{8}$/.test(raw)) {
		const date = buildLocalDate(raw);
		return date ? { date, allDay: true } : undefined;
	}
	const match = raw.match(/^(\d{8})T(\d{6})(Z?)$/);
	if (match) {
		const [, datePart, timePart, zulu] = match;
		const date = zulu ? fromUtc(datePart, timePart) : buildLocalDate(datePart, timePart);
		return date ? { date, allDay: false } : undefined;
	}
	void params;
	return undefined;
}

/** Constrói uma data local sem a conversão especial de anos 0–99 do construtor Date. */
function buildLocalDate(datePart: string, timePart = "000000"): Date | undefined {
	const year = Number(datePart.slice(0, 4));
	const month = Number(datePart.slice(4, 6));
	const day = Number(datePart.slice(6, 8));
	const hour = Number(timePart.slice(0, 2));
	const minute = Number(timePart.slice(2, 4));
	const second = Number(timePart.slice(4, 6));
	const date = new Date(0);
	date.setHours(0, 0, 0, 0);
	date.setFullYear(year, month - 1, day);
	date.setHours(hour, minute, second, 0);
	return isExactDate(date, year, month, day, hour, minute, second) ? date : undefined;
}

/** UTC explícito, também sem a conversão especial de anos 0–99 do Date.UTC. */
function fromUtc(datePart: string, timePart: string): Date | undefined {
	const year = Number(datePart.slice(0, 4));
	const month = Number(datePart.slice(4, 6));
	const day = Number(datePart.slice(6, 8));
	const hour = Number(timePart.slice(0, 2));
	const minute = Number(timePart.slice(2, 4));
	const second = Number(timePart.slice(4, 6));
	const date = new Date(0);
	date.setUTCFullYear(year, month - 1, day);
	date.setUTCHours(hour, minute, second, 0);
	return isExactUtcDate(date, year, month, day, hour, minute, second) ? date : undefined;
}

function isExactDate(date: Date, year: number, month: number, day: number, hour: number, minute: number, second: number): boolean {
	return (
		date.getFullYear() === year &&
		date.getMonth() + 1 === month &&
		date.getDate() === day &&
		date.getHours() === hour &&
		date.getMinutes() === minute &&
		date.getSeconds() === second
	);
}

function isExactUtcDate(date: Date, year: number, month: number, day: number, hour: number, minute: number, second: number): boolean {
	return (
		date.getUTCFullYear() === year &&
		date.getUTCMonth() + 1 === month &&
		date.getUTCDate() === day &&
		date.getUTCHours() === hour &&
		date.getUTCMinutes() === minute &&
		date.getUTCSeconds() === second
	);
}

const UNSUPPORTED_RRULE_FREQS = new Set(["MONTHLY", "WEEKLY", "DAILY", "HOURLY", "MINUTELY", "SECONDLY"]);

function collectRawEvents(lines: IcsLine[]): { raws: RawIcsEvent[]; orphans: number } {
	const raws: RawIcsEvent[] = [];
	let orphans = 0;
	let current: RawIcsEvent | null = null;

	for (const line of lines) {
		if (line.name === "BEGIN" && line.value.trim().toUpperCase() === "VEVENT") {
			if (current) orphans++;
			current = {};
			continue;
		}
		if (line.name === "END" && line.value.trim().toUpperCase() === "VEVENT") {
			if (current) raws.push(current);
			current = null;
			continue;
		}
		if (!current) continue;
		switch (line.name) {
			case "UID": current.uid = line.value.trim(); break;
			case "SUMMARY": current.summary = unescapeIcsText(line.value.trim()); break;
			case "DESCRIPTION": current.description = unescapeIcsText(line.value.trim()); break;
			case "DTSTART": {
				current.dtstart = parseIcsDate(line.value, line.params);
				current.dtstartInvalid = !current.dtstart;
				break;
			}
			case "RRULE": current.rrule = line.value.trim(); break;
		}
	}
	if (current) orphans++;
	return { raws, orphans };
}

function unescapeIcsText(value: string): string {
	return value
		.replace(/\\n/gi, " ")
		.replace(/\\,/g, ",")
		.replace(/\\;/g, ";")
		.replace(/\\\\/g, "\\");
}

function eventIdFor(raw: RawIcsEvent, index: number): string {
	return raw.uid ? `ics:${raw.uid}` : `ics:sem-uid-${index}`;
}

function toCalendarEvent(raw: RawIcsEvent, index: number): { event?: CalendarEvent; warning?: string } {
	if (!raw.dtstart) {
		return {
			warning: raw.dtstartInvalid
				? `Evento${raw.summary ? ` "${raw.summary}"` : ` ${index + 1}`} ignorado: data de início (DTSTART) inválida.`
				: `Evento${raw.summary ? ` "${raw.summary}"` : ` ${index + 1}`} ignorado: sem data de início (DTSTART) legível.`,
		};
	}
	const d = raw.dtstart.date;
	if (Number.isNaN(d.getTime())) {
		return { warning: `Evento${raw.summary ? ` "${raw.summary}"` : ` ${index + 1}`} ignorado: data inválida.` };
	}

	const title = raw.summary?.trim() || "Evento importado do .ics";
	const base: Omit<CalendarEvent, "recurrence" | "year"> & { recurrence?: CalendarEvent["recurrence"] } = {
		id: eventIdFor(raw, index),
		title,
		description: raw.description ?? "",
		day: d.getDate(),
		month: d.getMonth() + 1,
		time: raw.dtstart.allDay ? undefined : `${pad2(d.getHours())}:${pad2(d.getMinutes())}`,
		reminder: true,
		source: "ics",
	};

	if (raw.rrule) {
		const freqMatch = raw.rrule.match(/FREQ\s*=\s*([A-Z]+)/i);
		const freq = freqMatch?.[1]?.toUpperCase();
		if (freq === "YEARLY") {
			return { event: { ...base, recurrence: "yearly", year: undefined } as CalendarEvent };
		}
		if (freq && UNSUPPORTED_RRULE_FREQS.has(freq)) {
			const once: CalendarEvent = { ...base, recurrence: "once", year: d.getFullYear() } as CalendarEvent;
			return {
				event: once,
				warning: `"${title}" repete ${freqLabel(freq)} no .ics (RRULE), mas o calendário hoje só suporta anual ou data única — importado como evento único do dia ${once.day}/${once.month}/${once.year}.`,
			};
		}
		const fallback: CalendarEvent = { ...base, recurrence: "once", year: d.getFullYear() } as CalendarEvent;
		return {
			event: fallback,
			warning: `"${title}" tem uma regra de repetição (RRULE) que não foi possível interpretar — importado como evento único.`,
		};
	}

	return { event: { ...base, recurrence: "once", year: d.getFullYear() } as CalendarEvent };
}

function freqLabel(freq: string): string {
	switch (freq) {
		case "MONTHLY": return "todo mês";
		case "WEEKLY": return "toda semana";
		case "DAILY": return "todo dia";
		default: return "em intervalos curtos";
	}
}

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

export function parseIcs(raw: string): IcsParseResult {
	if (typeof raw !== "string" || raw.trim().length === 0) throw new IcsParseError("Arquivo .ics vazio.");
	const lines = unfoldIcsLines(raw).map(parseLine).filter((l): l is IcsLine => !!l);
	const hasVcalendar = lines.some((l) => l.name === "BEGIN" && l.value.trim().toUpperCase() === "VCALENDAR");
	const { raws, orphans } = collectRawEvents(lines);

	if (raws.length === 0) {
		if (!hasVcalendar) throw new IcsParseError("O arquivo não parece um .ics válido: nenhuma seção VCALENDAR/VEVENT encontrada.");
		throw new IcsParseError("O .ics não contém nenhum evento (VEVENT) para importar.");
	}

	const events: CalendarEvent[] = [];
	const warnings: string[] = [];
	const limitations = detectLimitations(lines);
	raws.forEach((raw, index) => {
		const { event, warning } = toCalendarEvent(raw, index);
		if (event) events.push(event);
		if (warning) warnings.push(warning);
	});
	if (orphans > 0) warnings.push(`${orphans} evento(s) do arquivo estavam incompletos (BEGIN:VEVENT sem END:VEVENT) e foram ignorados.`);
	return { events, warnings, limitations };
}

function detectLimitations(lines: IcsLine[]): string[] {
	const found = new Set<string>();
	for (const line of lines) {
		if (line.name === "BEGIN" && line.value.trim().toUpperCase() === "VTIMEZONE") {
			found.add("timezone: VTIMEZONE ignorado — horários usados no fuso local da máquina");
		}
		if (line.name === "DTSTART" && line.params.TZID) {
			found.add("timezone: DTSTART com TZID não mapeado — interpretado como horário local");
		}
		if (line.name === "EXDATE") found.add("recurrence: EXDATE ignorado — eventos excluídos da série não são removidos");
		if (line.name === "RDATE") found.add("recurrence: RDATE ignorado — datas adicionais não são adicionadas");
		if (line.name === "RECURRENCE-ID") found.add("recurrence: RECURRENCE-ID ignorado — ocorrências individuais não substituem a série");
		if (line.name === "STATUS" && line.value.trim().toUpperCase() === "CANCELLED") found.add("status: eventos cancelados (STATUS:CANCELLED) importados como normais");
		if (line.name === "BEGIN" && line.value.trim().toUpperCase() === "VALARM") found.add("alarm: lembretes VVALARM ignorados — use o sistema de lembretes do plugin");
	}
	return [...found];
}

export function mergeIcsEvents(existing: CalendarEvent[], imported: CalendarEvent[]): CalendarEvent[] {
	const importedIds = new Set(imported.map((e) => e.id));
	const kept = existing.filter((e) => !importedIds.has(e.id));
	const importedById = new Map<string, CalendarEvent>();
	for (const event of imported) importedById.set(event.id, event);
	return [...kept, ...importedById.values()];
}
