import type { CalendarEvent } from "./EventTypes";

/**
 * PARSER DE ARQUIVOS .ics — PURO, SEM I/O DE VAULT
 * -------------------------------------------------
 * Recebe o TEXTO de um arquivo .ics (iCalendar, RFC 5545) e devolve eventos
 * no modelo do projeto (CalendarEvent, ver EventTypes.ts). Regra de negócio
 * pura em arquivo próprio ao lado do módulo — padrão do projeto (como
 * mcp/WriteRules.ts e templates/NoteStatus.ts) — com suíte própria que
 * importa este código real.
 *
 * MAPA DE CONVERSÃO (o modelo do projeto é mais estreito que o iCalendar —
 * parte honesta da conversão, nunca aproximação silenciosa):
 *   - VEVENT            → CalendarEvent
 *   - SUMMARY           → title
 *   - DESCRIPTION       → description
 *   - DTSTART (data)    → day/month (+ year quando data absoluta)
 *   - DTSTART (data-hora local) → day/month/year + time "HH:MM"
 *   - DTSTART (UTC)     → idem, no horário local da máquina (o lembrete
 *                         dispara pelo relógio local — mesma semântica de
 *                         um evento criado na mão)
 *   - RRULE FREQ=YEARLY → recurrence "yearly" (repete todo ano na data)
 *   - RRULE com outra frequência (MONTHLY, WEEKLY, DAILY...) → recurrence
 *     "once" + um WARNING por evento: o modelo atual só sabe anual/único,
 *     e importar como anual MENTIRIA sobre quando o evento dispara. O
 *     aviso sobe para a UI (Notice) — nada é descartado em silêncio.
 *   - Eventos sem DTSTART ou com data ilegível entram nos WARNINGS e não
 *     viram evento — um evento sem data não existe.
 *
 * DUPLICATAS: cada VEVENT vira um evento com id determinístico derivado do
 * UID do iCalendar (`ics:<uid>`), então importar o MESMO arquivo duas vezes
 * NÃO duplica — o mesclador do módulo (mergeIcsEvents) substitui o evento
 * anterior com o mesmo id. VEVENT sem UID também é suportado (id derivado
 * do conteúdo), mas o .ics do Google/Outlook sempre traz UID.
 */

/** Um evento legível vindo do .ics + problemas que não impediram a importação. */
export interface IcsParseResult {
	/** Eventos convertidos para o modelo do projeto (já com id determinístico). */
	events: CalendarEvent[];
	/**
	 * Avisos não-bloqueantes: recorrência sem suporte, DTSTART ilegível,
	 * VEVENT ignorado — tudo que o usuário precisa saber, em português.
	 */
	warnings: string[];
}

/** Erro quando o texto nem se parece com um .ics (usado pela UI para Notice). */
export class IcsParseError extends Error {}

interface RawIcsEvent {
	uid?: string;
	summary?: string;
	description?: string;
	dtstart?: IcsDateTime;
	rrule?: string;
}

interface IcsDateTime {
	/** Date do JS no instante representado (fuso tratado pela própria Date). */
	date: Date;
	/** true se a linha original era só DATA (DTSTART;VALUE=DATE:20260915). */
	allDay: boolean;
}

/** Linha lógica do iCalendar: nome, parâmetros e valor (desdobramento já aplicado). */
interface IcsLine {
	name: string;
	params: Record<string, string>;
	value: string;
}

/**
 * Desdobra as linhas físicas do arquivo em linhas lógicas: pela RFC 5545,
 * uma linha de continuação começa com espaço ou tabulação e pertence à
 * linha anterior. Sem isto, SUMMARY e DESCRIPTION longos (o comum em .ics
 * reais) chegam truncados.
 */
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

/** Quebra "NOME;PARAM=x:valor" em partes — o valor pode conter ":" (ex.: DTSTART com fuso). */
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

/**
 * Formatos de data do iCalendar suportados:
 *   - DATA:        20260915
 *   - LOCAL:       20260915T143000
 *   - UTC (Z):     20260915T143000Z
 *   - COM FUSO:    TZID=America/Sao_Paulo:20260915T143000 — o valor é igual ao
 *                  local; o fuso nomeado é interpretado pela Date nativa
 *                  (que usa o fuso da máquina). Aviso: um .ics gerado em
 *                  outro fuso pode deslocar a hora — o parser prioriza não
 *                  perder o evento a errar a conversão de fuso na mão.
 */
function parseIcsDate(value: string, params: Record<string, string>): IcsDateTime | undefined {
	const raw = value.trim();
	if (/^\d{8}$/.test(raw)) {
		return { date: buildLocalDate(raw), allDay: true };
	}
	const match = raw.match(/^(\d{8})T(\d{6})(Z?)$/);
	if (match) {
		const [, datePart, timePart, zulu] = match;
		const base = buildLocalDate(datePart, timePart);
		const date = zulu ? fromUtc(datePart, timePart) : base;
		return date ? { date, allDay: false } : undefined;
	}
	// VALUE=DATE-PERIOD ou formatos exóticos: sem suporte declarado.
	void params;
	return undefined;
}

/** "20260915" + "143000" → Date no fuso local da máquina. */
function buildLocalDate(datePart: string, timePart = "000000"): Date {
	return new Date(
		Number(datePart.slice(0, 4)),
		Number(datePart.slice(4, 6)) - 1,
		Number(datePart.slice(6, 8)),
		Number(timePart.slice(0, 2)),
		Number(timePart.slice(2, 4)),
		Number(timePart.slice(4, 6))
	);
}

/** UTC explícito (sufixo Z): monta como UTC e deixa a Date converter para local. */
function fromUtc(datePart: string, timePart: string): Date {
	return new Date(
		Date.UTC(
			Number(datePart.slice(0, 4)),
			Number(datePart.slice(4, 6)) - 1,
			Number(datePart.slice(6, 8)),
			Number(timePart.slice(0, 2)),
			Number(timePart.slice(2, 4)),
			Number(timePart.slice(4, 6))
		)
	);
}

/**
 * Frequências de RRULE que o modelo do projeto NÃO consegue representar sem
 * mentir. YEARLY vira "yearly"; todo o resto vira evento único com aviso.
 */
const UNSUPPORTED_RRULE_FREQS = new Set(["MONTHLY", "WEEKLY", "DAILY", "HOURLY", "MINUTELY", "SECONDLY"]);

/** Extrai os VEVENTs do texto. Válido só se existir BEGIN:VEVENT … END:VEVENT. */
function collectRawEvents(lines: IcsLine[]): { raws: RawIcsEvent[]; orphans: number } {
	const raws: RawIcsEvent[] = [];
	let orphans = 0;
	let current: RawIcsEvent | null = null;

	for (const line of lines) {
		if (line.name === "BEGIN" && line.value.trim().toUpperCase() === "VEVENT") {
			if (current) orphans++; // BEGIN:VEVENT sem END anterior — arquivo truncado
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
			case "UID":
				current.uid = line.value.trim();
				break;
			case "SUMMARY":
				current.summary = unescapeIcsText(line.value.trim());
				break;
			case "DESCRIPTION":
				current.description = unescapeIcsText(line.value.trim());
				break;
			case "DTSTART":
				current.dtstart = parseIcsDate(line.value, line.params);
				break;
			case "RRULE":
				current.rrule = line.value.trim();
				break;
		}
	}
	if (current) orphans++; // BEGIN:VEVENT sem END — .ics truncado
	return { raws, orphans };
}

/** Escapes do iCalendar (\n, \, e ;) de volta ao texto legível. */
function unescapeIcsText(value: string): string {
	return value
		.replace(/\\n/gi, " ")
		.replace(/\\,/g, ",")
		.replace(/\\;/g, ";")
		.replace(/\\\\/g, "\\");
}

/** id determinístico por UID — a garantia do "importar 2x não duplica". */
function eventIdFor(raw: RawIcsEvent, index: number): string {
	if (raw.uid) return `ics:${raw.uid}`;
	return `ics:sem-uid-${index}`;
}

/**
 * Converte um VEVENT cru em CalendarEvent, ou devolve o motivo de ter sido
 * descartado (string de warning). Nunca lança — um evento ruim não pode
 * derrubar a importação inteira.
 */
function toCalendarEvent(raw: RawIcsEvent, index: number): { event?: CalendarEvent; warning?: string } {
	if (!raw.dtstart) {
		return { warning: `Evento${raw.summary ? ` "${raw.summary}"` : ` ${index + 1}`} ignorado: sem data de início (DTSTART) legível.` };
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
	};

	// RRULE: YEARLY é o único mapeável direto ao modelo atual. Outras
	// frequências viram evento ÚNICO (sem mentir "repete todo ano") + aviso.
	if (raw.rrule) {
		const freqMatch = raw.rrule.match(/FREQ\s*=\s*([A-Z]+)/i);
		const freq = freqMatch?.[1]?.toUpperCase();
		if (freq === "YEARLY") {
			const yearly: CalendarEvent = { ...base, recurrence: "yearly", year: undefined } as CalendarEvent;
			return { event: yearly };
		}
		if (freq && UNSUPPORTED_RRULE_FREQS.has(freq)) {
			const once: CalendarEvent = {
				...base,
				recurrence: "once",
				year: d.getFullYear(),
			} as CalendarEvent;
			return {
				event: once,
				warning:
					`"${title}" repete ${freqLabel(freq)} no .ics (RRULE), mas o calendário hoje só suporta ` +
					`anual ou data única — importado como evento único do dia ${once.day}/${once.month}/${once.year}.`,
			};
		}
		// RRULE sem FREQ reconhecível: trata como único e avisa do mesmo jeito.
		const fallback: CalendarEvent = { ...base, recurrence: "once", year: d.getFullYear() } as CalendarEvent;
		return {
			event: fallback,
			warning: `"${title}" tem uma regra de repetição (RRULE) que não foi possível interpretar — importado como evento único.`,
		};
	}

	const once: CalendarEvent = { ...base, recurrence: "once", year: d.getFullYear() } as CalendarEvent;
	return { event: once };
}

function freqLabel(freq: string): string {
	switch (freq) {
		case "MONTHLY":
			return "todo mês";
		case "WEEKLY":
			return "toda semana";
		case "DAILY":
			return "todo dia";
		default:
			return "em intervalos curtos";
	}
}

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

/**
 * Ponto de entrada: texto do .ics → eventos do projeto + avisos.
 * Lança IcsParseError quando o texto nem é um iCalendar (sem VEVENT
 * nenhum) — a UI converte em Notice e mantém o painel aberto.
 */
export function parseIcs(raw: string): IcsParseResult {
	if (typeof raw !== "string" || raw.trim().length === 0) {
		throw new IcsParseError("Arquivo .ics vazio.");
	}
	const lines = unfoldIcsLines(raw)
		.map(parseLine)
		.filter((l): l is IcsLine => !!l);

	const hasVcalendar = lines.some((l) => l.name === "BEGIN" && l.value.trim().toUpperCase() === "VCALENDAR");
	const { raws, orphans } = collectRawEvents(lines);

	if (raws.length === 0) {
		if (!hasVcalendar) {
			throw new IcsParseError(
				"O arquivo não parece um .ics válido: nenhuma seção VCALENDAR/VEVENT encontrada."
			);
		}
		throw new IcsParseError("O .ics não contém nenhum evento (VEVENT) para importar.");
	}

	const events: CalendarEvent[] = [];
	const warnings: string[] = [];
	raws.forEach((raw, index) => {
		const { event, warning } = toCalendarEvent(raw, index);
		if (event) events.push(event);
		if (warning) warnings.push(warning);
	});
	if (orphans > 0) {
		warnings.push(
			`${orphans} evento(s) do arquivo estavam incompletos (BEGIN:VEVENT sem END:VEVENT) e foram ignorados.`
		);
	}

	return { events, warnings };
}

/**
 * MESCLA eventos importados com os que já existem na fatia do calendário:
 * - dedupe por id (UID do .ics): o evento importado SUBSTITUI o anterior —
 *   importar o arquivo de novo depois de editar o calendário reflete a
 *   edição, que é o comportamento esperado de uma sincronização;
 * - eventos criados à mão (ids que não vêm de .ics) nunca são tocados.
 * Puro: recebe e devolve listas — testável sem vault.
 */
export function mergeIcsEvents(existing: CalendarEvent[], imported: CalendarEvent[]): CalendarEvent[] {
	const importedIds = new Set(imported.map((e) => e.id));
	const kept = existing.filter((e) => !importedIds.has(e.id));
	return [...kept, ...imported];
}
