/**
 * CAMPO DE TEXTO COM SUGESTÕES FILTRÁVEIS
 * -----------------------------------------
 * Um `<input>` que, ao digitar, mostra uma lista de sugestões filtradas
 * (contém o texto digitado, sem diferenciar maiúsculas). Existe para os
 * casos em que um <select>/dropdown ficaria com centenas de opções — em
 * vaults grandes, uma pasta ou uma nota entre milhares de arquivos é
 * inviável de rolar numa lista; digitar e filtrar é bem mais rápido.
 *
 * Uso:
 *   const input = container.createEl("input", { type: "text" });
 *   attachFilterSuggest(input, container.createDiv(), listaDeCaminhos, (v) => { ... });
 */
export function attachFilterSuggest(
	input: HTMLInputElement,
	box: HTMLElement,
	items: string[],
	onSelect: (value: string) => void,
	options?: { maxResults?: number }
): void {
	const maxResults = options?.maxResults ?? 30;
	let open = false;
	let selectedIndex = 0;
	let matches: string[] = [];

	box.addClass("ione-hub-filter-suggest__box");
	box.style.display = "none";

	const close = () => {
		open = false;
		box.style.display = "none";
		box.empty();
	};

	const draw = () => {
		box.empty();
		matches.forEach((value, index) => {
			const row = box.createDiv({ cls: "ione-hub-filter-suggest__row" });
			if (index === selectedIndex) row.addClass("is-selected");
			row.setText(value);
			row.onmousedown = (evt) => {
				evt.preventDefault(); // não deixa o input perder foco antes do clique registrar
				accept(value);
			};
		});
		box.style.display = matches.length > 0 ? "block" : "none";
	};

	const recompute = () => {
		const query = input.value.trim().toLowerCase();
		matches = (query ? items.filter((i) => i.toLowerCase().includes(query)) : items).slice(
			0,
			maxResults
		);
		selectedIndex = 0;
		open = matches.length > 0;
		draw();
	};

	const accept = (value: string) => {
		input.value = value;
		onSelect(value);
		close();
	};

	input.addEventListener("input", recompute);
	input.addEventListener("focus", recompute);

	input.addEventListener("keydown", (evt) => {
		if (!open) return;
		if (evt.key === "ArrowDown") {
			evt.preventDefault();
			selectedIndex = (selectedIndex + 1) % matches.length;
			draw();
		} else if (evt.key === "ArrowUp") {
			evt.preventDefault();
			selectedIndex = (selectedIndex - 1 + matches.length) % matches.length;
			draw();
		} else if (evt.key === "Enter") {
			if (matches[selectedIndex]) {
				evt.preventDefault();
				accept(matches[selectedIndex]);
			}
		} else if (evt.key === "Escape") {
			close();
		}
	});

	input.addEventListener("blur", () => window.setTimeout(close, 150));
}
