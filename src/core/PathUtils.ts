/**
 * Utilitários puros de caminho — sem dependência do Obsidian.
 *
 * Extraído das cópias idênticas de `uniquePath` em TemplatesModule,
 * CalendarModule e FileLifecycleModule (fatoração, sem mudança de
 * comportamento). A função de existência é injetada, o que permite
 * testar sem vault.
 */

/**
 * Deriva o primeiro nome livre a partir de `desired`, acrescentando
 * " 2", " 3", ... antes da extensão.
 *
 * Ex.: "Nota.md" existente → "Nota 2.md"; "Relatório" (sem extensão)
 * → "Relatório 2" — o guard de `dot === -1` evita que o slice coma o
 * último caractere (bug "Nota 2t" corrigido na v0.6.x).
 */
export function uniqueNameWith(
	desired: string,
	exists: (path: string) => boolean
): string {
	if (!exists(desired)) return desired;
	const dot = desired.lastIndexOf(".");
	const base = dot === -1 ? desired : desired.slice(0, dot);
	const ext = dot === -1 ? "" : desired.slice(dot);
	let counter = 2;
	while (exists(`${base} ${counter}${ext}`)) counter++;
	return `${base} ${counter}${ext}`;
}
