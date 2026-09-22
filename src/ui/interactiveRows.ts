/**
 * LINHA CLICÁVEL ACESSÍVEL — HELPER COMPARTILHADO, SEM ESTADO
 * ------------------------------------------------------------
 * Vários painéis têm linhas de `<div>` clicáveis que o teclado não alcança
 * (só o mouse). Este helper concentra o tratamento padrão do projeto:
 * `tabIndex`, `role="button"`, `aria-label` e Enter/Espaço com
 * `preventDefault` (Espaço rola a página sem ele).
 *
 * Foco visível: `styles.css` dá outline a `.ione-hub-focusable:focus-visible`
 * (mesma linguagem dos nav-items do Lobby).
 */

export interface InteractiveRowOptions {
	/** Anunciado por leitores de tela (obrigatório — linha é um botão sem rótulo visível). */
	ariaLabel: string;
	/** Opcional: sobrescreve o texto acessível com leitor de tela; visual intocado. */
	ariaLabelledBy?: string;
}

export function makeInteractiveRow(
	row: HTMLElement,
	options: InteractiveRowOptions,
	onClick: () => void
): HTMLElement {
	row.tabIndex = 0;
	row.addClass("ione-hub-focusable");
	row.setAttr("role", "button");
	if (options.ariaLabelledBy) {
		row.setAttr("aria-labelledby", options.ariaLabelledBy);
	} else {
		row.setAttr("aria-label", options.ariaLabel);
	}
	row.onclick = () => onClick();
	row.onkeydown = (evt: KeyboardEvent) => {
		if (evt.key === "Enter" || evt.key === " ") {
			evt.preventDefault();
			onClick();
		}
	};
	return row;
}

/**
 * Navegação por setas entre abas (`←`/`→`, com volta ao início/fim).
 * Modo "manual" do padrão ARIA: a seta SÓ move o foco; Enter/Espaço ativa —
 * assim o foco nunca se perde num re-render disparado pela ativação.
 * Chame de dentro do `onkeydown` da aba; `tabsEl` é o container das abas.
 */
export function focusSiblingTab(evt: KeyboardEvent, tabsEl: HTMLElement, current: HTMLElement): void {
	const dir = evt.key === "ArrowRight" ? 1 : evt.key === "ArrowLeft" ? -1 : 0;
	if (dir === 0) return;
	evt.preventDefault();
	const all = Array.from(tabsEl.querySelectorAll<HTMLElement>(".ione-hub-tabs__tab"));
	const i = all.indexOf(current);
	if (i === -1) return;
	all[(i + dir + all.length) % all.length]?.focus();
}
