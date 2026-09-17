/**
 * Stub mínimo do pacote "obsidian" para testes que importam CÓDIGO REAL
 * (o pacote é types-only: só existe dentro do app, sem entry executável).
 * O alias em vitest.config.ts aponta "obsidian" para cá APENAS nos testes;
 * o `tsc` continua usando os tipos oficiais, sem mudar nada na build.
 *
 * Mantenha o mínimo: só o que os módulos importados pelos testes tocam em
 * runtime. Classes aqui são inertes — nada de lógica do plugin.
 */

/** Notificações exibidas durante os testes — os testes importam isto direto. */
export const capturedNotices: { message: string; timeout?: number }[] = [];

export class TFile {
	path = "";
}

export class TFolder {
	path = "";
}

export class Notice {
	constructor(
		public message: string,
		public timeout?: number
	) {
		capturedNotices.push({ message, timeout });
	}
}

/** Elemento falso: aceita criar filhos e receber propriedades (onclick etc.). */
function fakeEl(): Record<string, unknown> {
	const el: Record<string, unknown> = {
		createEl: () => fakeEl(),
		createDiv: () => fakeEl(),
		createSpan: () => fakeEl(),
		empty: () => {},
		setText: () => {},
	};
	return el;
}

export class Modal {
	contentEl: Record<string, unknown> = fakeEl();
	constructor(public app: unknown) {}
	open(): void {}
	close(): void {}
}

export class Setting {
	constructor(public containerEl: unknown) {}
	setName(): this {
		return this;
	}
	setDesc(): this {
		return this;
	}
	addText(): this {
		return this;
	}
	addToggle(): this {
		return this;
	}
	addButton(): this {
		return this;
	}
	addTextArea(): this {
		return this;
	}
}
