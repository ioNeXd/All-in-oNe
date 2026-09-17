import { Notice, Setting, Modal, App } from "obsidian";
import { BUILTIN_PRESETS, type ThemePreset } from "./presets";
export type { ThemePreset } from "./presets";
import type { HubModule, ModuleContext, ModuleManifest } from "../../core/ModuleContract";


export interface StylesModuleSettings {
	activeCss: string;
	history: { css: string; savedAt: number }[];
	presets: ThemePreset[];
	highContrastPreset: boolean;
}

const STYLE_TAG_ID = "ione-hub-styles";
const MAX_HISTORY = 20;


export const STYLES_DEFAULTS: StylesModuleSettings = {
	activeCss: "",
	history: [],
	presets: [],
	highContrastPreset: false,
};

/**
 * MÓDULO DE ESTILOS
 * -----------------
 * Injeta um único <style> gerenciado por este módulo no <head> do documento
 * do Obsidian — em vez de escrever num arquivo de snippet, o que exigiria
 * recarregar o Obsidian para refletir a mudança. Isso também é o que
 * permite qualquer outro módulo (ex.: Calendário) ser estilizado por aqui:
 * eles usam as mesmas variáveis CSS nativas do Obsidian, e este módulo só
 * precisa saber sobrescrever essas variáveis ou adicionar seletores
 * específicos (ex.: `.ione-hub-calendar { ... }`).
 */
export class StylesModule implements HubModule {
	readonly manifest: ModuleManifest = {
		id: "styles",
		displayName: "Estilos",
		description: "Editor de CSS livre + temas prontos para o Obsidian e para os demais módulos.",
		icon: "palette",
		version: "0.1.0",
		contractVersion: "2.0.0",
		desktopOnly: false,
		emits: ["styles:applied"],
		listensTo: [],
		settingsSchema: [],
	};

	private context?: ModuleContext;
	private styleEl?: HTMLStyleElement;

	onRegister(context: ModuleContext): void {
		this.context = context;
	}

	onEnable(): void {
		this.styleEl = document.createElement("style");
		this.styleEl.id = STYLE_TAG_ID;
		document.head.appendChild(this.styleEl);
		this.applyCss(this.readSettings().activeCss);
	}

	onDisable(): void {
		this.styleEl?.remove();
		this.styleEl = undefined;
	}

	getHealthStatus() {
		const hasCustomCss = !!this.readSettings().activeCss.trim();
		return { ok: true, summary: hasCustomCss ? "CSS customizado ativo" : "Usando padrão do Obsidian" };
	}

	/** Aba ativa do painel — "Temas prontos" é a primeira, como porta de entrada. */
	private activeTab: "presets" | "visual" | "editor" = "presets";

	renderSettingsPanel(container: HTMLElement): void {
		this.panelRoot = container;

		const tabs = container.createDiv({ cls: "ione-hub-tabs" });
		const tabDefs: [typeof this.activeTab, string][] = [
			["presets", "🎨 Temas prontos"],
			["visual", "🎚️ Painel visual"],
			["editor", "⌨️ Editor livre"],
		];
		for (const [id, label] of tabDefs) {
			const tab = tabs.createDiv({ cls: "ione-hub-tabs__tab", text: label });
			if (this.activeTab === id) tab.addClass("is-active");
			tab.tabIndex = 0;
			const activate = () => {
				this.activeTab = id;
				this.refreshPanel();
			};
			tab.onclick = activate;
			tab.onkeydown = (evt) => {
				if (evt.key === "Enter" || evt.key === " ") {
					evt.preventDefault();
					activate();
				}
			};
		}

		const body = container.createDiv({ cls: "ione-hub-tabs__body" });
		if (this.activeTab === "presets") this.renderPresetsTab(body);
		else if (this.activeTab === "visual") this.renderVisualTab(body);
		else this.renderEditorTab(body);
	}

	// ---------- Aba 1: temas prontos ----------
	private renderPresetsTab(container: HTMLElement): void {
		container.createEl("p", {
			cls: "ione-hub-lobby__description",
			text:
				"Escolha um ponto de partida. Aplicar um tema substitui o CSS atual — " +
				"use o Preview antes se quiser só espiar. Depois dá para refinar no Editor livre.",
		});

		const grid = container.createDiv({ cls: "ione-hub-preset-grid" });
		for (const preset of this.allPresets()) {
			const card = grid.createDiv({ cls: "ione-hub-preset-card" });

			// Amostra das cores principais do tema, lida do próprio CSS do preset.
			const swatches = card.createDiv({ cls: "ione-hub-preset-card__swatches" });
			for (const color of extractSwatches(preset.css)) {
				const dot = swatches.createDiv({ cls: "ione-hub-preset-card__swatch" });
				dot.style.background = color;
			}

			card.createEl("div", { cls: "ione-hub-preset-card__name", text: preset.name });
			card.createEl("div", {
				cls: "ione-hub-preset-card__desc",
				text: preset.description ?? "",
			});

			const actions = card.createDiv({ cls: "ione-hub-preset-card__actions" });
			const previewBtn = actions.createEl("button", { text: "Preview" });
			previewBtn.onclick = () =>
				new ThemePreviewModal(this.context!.app, preset, async () => {
					await this.applyPreset(preset.id);
					new Notice(`Tema "${preset.name}" aplicado.`);
					this.refreshPanel();
				}).open();

			const applyBtn = actions.createEl("button", { text: "Aplicar", cls: "mod-cta" });
			applyBtn.onclick = async () => {
				await this.applyPreset(preset.id);
				new Notice(`Tema "${preset.name}" aplicado.`);
				this.refreshPanel();
			};
		}

		container.createEl("h3", { text: "Seus temas salvos" });
		const custom = this.readSettings().presets;
		if (custom.length === 0) {
			container.createEl("p", {
				cls: "ione-hub-lobby__description",
				text: "Nenhum tema salvo ainda. Personalize no Editor livre e salve com um nome.",
			});
		}
		for (const preset of custom) {
			new Setting(container)
				.setName(preset.name)
				.addButton((btn) =>
					btn.setButtonText("Aplicar").onClick(async () => {
						await this.applyPreset(preset.id);
						new Notice(`Tema "${preset.name}" aplicado.`);
						this.refreshPanel();
					})
				)
				.addButton((btn) =>
					btn.setButtonText("Excluir").onClick(async () => {
						await this.context?.updateSettings({
							presets: custom.filter((x) => x.id !== preset.id),
						});
						this.refreshPanel();
					})
				);
		}

		container.createEl("h3", { text: "Importar / exportar" });
		new Setting(container)
			.setName("Exportar o CSS atual")
			.addButton((btn) =>
				btn.setButtonText("Copiar JSON").onClick(async () => {
					await navigator.clipboard.writeText(this.exportTheme());
					new Notice("Tema copiado para a área de transferência.");
				})
			);

		let importJson = "";
		new Setting(container)
			.setName("Importar tema")
			.setDesc('Cole um JSON exportado (formato: {"css": "..."}).')
			.addTextArea((area) => area.onChange((v) => (importJson = v)))
			.addButton((btn) =>
				btn.setButtonText("Importar").onClick(async () => {
					try {
						await this.importTheme(importJson);
						new Notice("Tema importado e aplicado.");
						this.refreshPanel();
					} catch {
						new Notice('JSON inválido. Esperado algo como {"css": "..."}.');
					}
				})
			);
	}

	// ---------- Aba 2: painel visual ----------
	private renderVisualTab(container: HTMLElement): void {
		container.createEl("p", {
			cls: "ione-hub-lobby__description",
			text:
				"Ajustes rápidos das variáveis mais usadas. Mexer aqui edita apenas o bloco gerado " +
				"no final do CSS — o que você escrever à mão continua intacto.",
		});

		const draft: Record<string, string> = { ...this.readVisualVars() };

		let currentGroup = "";
		for (const spec of VISUAL_VARS) {
			if (spec.group !== currentGroup) {
				currentGroup = spec.group;
				container.createEl("h3", { text: currentGroup });
			}
			const setting = new Setting(container).setName(spec.label).setDesc(spec.cssVar);

			if (spec.type === "color") {
				setting.addColorPicker((picker) =>
					picker
						.setValue(normalizeColor(draft[spec.cssVar] ?? spec.fallback))
						.onChange((value) => (draft[spec.cssVar] = value))
				);
			} else {
				const current = parseFloat(draft[spec.cssVar] ?? spec.fallback);
				setting.addSlider((slider) =>
					slider
						.setLimits(spec.min ?? 10, spec.max ?? 30, spec.step ?? 1)
						.setDynamicTooltip()
						.setValue(Number.isFinite(current) ? current : spec.fallbackNumber ?? 16)
						.onChange((value) => (draft[spec.cssVar] = `${value}${spec.unit ?? "px"}`))
				);
			}
		}

		new Setting(container)
			.addButton((btn) =>
				btn
					.setButtonText("Aplicar painel visual")
					.setCta()
					.onClick(async () => {
						await this.writeVisualVars(draft);
						new Notice("Ajustes visuais aplicados.");
						this.refreshPanel();
					})
			)
			.addButton((btn) =>
				btn.setButtonText("Limpar ajustes visuais").onClick(async () => {
					await this.setCss(stripGeneratedBlock(this.readSettings().activeCss));
					new Notice("Bloco do painel visual removido. Seu CSS manual foi mantido.");
					this.refreshPanel();
				})
			);
	}

	// ---------- Aba 3: editor livre ----------
	private renderEditorTab(container: HTMLElement): void {
		const settings = this.readSettings();

		container.createEl("p", {
			cls: "ione-hub-lobby__description",
			text:
				"Este é o CSS que está valendo agora. Edite à vontade e clique em Aplicar — " +
				"a mudança entra em vigor na hora. Ctrl+Espaço abre a lista de variáveis.",
		});

		const textarea = container.createEl("textarea", { cls: "ione-hub-styles__editor" });
		textarea.spellcheck = false;
		// Começa com o CSS ativo; se não houver nada, um esqueleto comentado
		// explicando as duas famílias de variáveis, para não abrir em branco.
		textarea.value = settings.activeCss.trim() || STARTER_CSS;

		const suggestionBox = container.createDiv({ cls: "ione-hub-styles__suggestions" });
		suggestionBox.style.display = "none";
		attachVariableAutocomplete(textarea, suggestionBox);

		new Setting(container)
			.addButton((btn) =>
				btn
					.setButtonText("Aplicar CSS")
					.setCta()
					.onClick(async () => {
						await this.setCss(textarea.value);
						new Notice("Estilo aplicado.");
					})
			)
			.addButton((btn) =>
				btn
					.setButtonText(`Desfazer (${settings.history.length})`)
					.setDisabled(settings.history.length === 0)
					.onClick(async () => {
						await this.undo();
						new Notice("Última mudança desfeita.");
						this.refreshPanel();
					})
			)
			.addButton((btn) =>
				btn.setButtonText("Recarregar do disco").onClick(() => this.refreshPanel())
			);

		let newPresetName = "";
		new Setting(container)
			.setName("Salvar como tema")
			.addText((text) => text.setPlaceholder("Nome do tema").onChange((v) => (newPresetName = v)))
			.addButton((btn) =>
				btn.setButtonText("Salvar").onClick(async () => {
					if (!newPresetName.trim()) {
						new Notice("Dê um nome ao tema.");
						return;
					}
					await this.saveAsPreset(newPresetName.trim());
					new Notice("Tema salvo na aba Temas prontos.");
				})
			);

		// ---- Referência dividida: Obsidian x este plugin ----
		for (const group of CSS_REFERENCE) {
			const ref = container.createEl("details", { cls: "ione-hub-styles__reference" });
			ref.createEl("summary", { text: group.group });
			if (group.note) {
				ref.createEl("p", { cls: "ione-hub-lobby__description", text: group.note });
			}
			for (const entry of group.entries) {
				const row = ref.createDiv({ cls: "ione-hub-styles__reference-row" });
				row.createEl("code", { text: entry.name });
				row.createSpan({ text: ` — ${entry.description}` });
				row.onclick = () => {
					insertAtCursor(textarea, `  ${entry.name}: ${entry.example};\n`);
					textarea.focus();
				};
			}
		}

		const conflicts = this.detectConflicts(settings.activeCss);
		if (conflicts.length > 0) {
			container.createEl("h3", { text: "Possíveis conflitos" });
			container.createEl("p", {
				cls: "ione-hub-lobby__description",
				text:
					`O tema externo ativo ("${this.getActiveObsidianTheme()}") também define: ` +
					`${conflicts.join(", ")}. O CSS deste plugin vence por ter especificidade maior.`,
			});
		}
	}

	private allPresets(): ThemePreset[] {
		return BUILTIN_PRESETS;
	}

	/** Raiz do painel, para redesenhar sempre a partir do topo (evita aninhar painéis). */
	private panelRoot?: HTMLElement;

	private refreshPanel(container?: HTMLElement): void {
		const root = container ?? this.panelRoot;
		if (!root) return;
		root.empty();
		this.renderSettingsPanel(root);
	}

	/** Lê os valores atuais do bloco gerado pelo painel visual. */
	private readVisualVars(): Record<string, string> {
		const css = this.readSettings().activeCss;
		const startIdx = css.indexOf(GENERATED_START);
		const endIdx = css.indexOf(GENERATED_END);
		if (startIdx === -1 || endIdx === -1) return {};

		const block = css.slice(startIdx, endIdx);
		const result: Record<string, string> = {};
		for (const match of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
			result[match[1]] = match[2].trim();
		}
		return result;
	}

	/** Escreve o bloco gerado de uma vez só, a partir do rascunho completo. */
	private async writeVisualVars(vars: Record<string, string>): Promise<void> {
		const entries = Object.entries(vars).filter(([, value]) => value);
		const base = stripGeneratedBlock(this.readSettings().activeCss).trimEnd();

		if (entries.length === 0) {
			await this.setCss(base);
			return;
		}

		const body = entries.map(([k, v]) => `  ${k}: ${v};`).join("\n");
		// `body.theme-dark, body.theme-light` tem especificidade maior que o
		// `body` usado pelos temas — sem isso, um tema instalado sobrescrevia
		// os ajustes do painel e parecia que "não fazia nada".
		const block = `${GENERATED_START}\nbody.theme-dark,\nbody.theme-light {\n${body}\n}\n${GENERATED_END}`;
		await this.setCss(base ? `${base}\n\n${block}` : block);
	}

	private getActiveObsidianTheme(): string {
		// @ts-expect-error — customCss não é público na tipagem, mas existe em runtime
		return (this.context?.app.customCss?.theme as string) || "padrão do Obsidian";
	}

	private detectConflicts(css: string): string[] {
		const mine = new Set<string>();
		for (const m of css.matchAll(/(--[\w-]+)\s*:/g)) mine.add(m[1]);
		if (mine.size === 0) return [];

		const themeSheet = Array.from(document.styleSheets).find((sheet) =>
			(sheet.ownerNode as HTMLElement | null)?.classList?.contains("theme")
		);
		const theirs = new Set<string>();
		try {
			for (const rule of Array.from(themeSheet?.cssRules ?? [])) {
				const text = (rule as CSSStyleRule).cssText ?? "";
				for (const m of text.matchAll(/(--[\w-]+)\s*:/g)) theirs.add(m[1]);
			}
		} catch {
			return [];
		}
		return [...mine].filter((v) => theirs.has(v)).slice(0, 8);
	}

	private readSettings(): StylesModuleSettings {
		return { ...STYLES_DEFAULTS, ...this.context?.getSettings<StylesModuleSettings>() };
	}

	/** Aplica CSS em tempo real e grava um snapshot no histórico (undo). */
	async setCss(css: string): Promise<void> {
		const settings = this.readSettings();
		const history = [{ css: settings.activeCss, savedAt: Date.now() }, ...settings.history].slice(
			0,
			MAX_HISTORY
		);
		await this.context?.updateSettings({ activeCss: css, history });
		this.applyCss(css);
		await this.context?.bus.emit("styles:applied", { length: css.length }, "styles");
	}

	async undo(): Promise<void> {
		const settings = this.readSettings();
		const [last, ...rest] = settings.history;
		if (!last) return;
		await this.context?.updateSettings({ activeCss: last.css, history: rest });
		this.applyCss(last.css);
	}

	async applyPreset(presetId: string): Promise<void> {
		const preset =
			BUILTIN_PRESETS.find((p) => p.id === presetId) ??
			this.readSettings().presets.find((p) => p.id === presetId);
		if (!preset) return;

		// BUG CORRIGIDO: antes, `setCss(preset.css)` jogava o CSS do tema como
		// texto solto — sem os marcadores GENERATED_START/END. Isso funcionava
		// para o Editor livre (que só mostra o CSS ativo), mas o Painel visual
		// lê exclusivamente o que está DENTRO desses marcadores para preencher
		// os seletores de cor e sliders — então, depois de aplicar um tema, o
		// painel continuava mostrando os valores padrão de fábrica, não as
		// cores do tema. Envolvendo o CSS do preset no mesmo bloco usado pelo
		// painel visual, os dois lados passam a concordar.
		const block = `${GENERATED_START}\n${preset.css}\n${GENERATED_END}`;
		await this.setCss(block);
	}

	async saveAsPreset(name: string): Promise<ThemePreset> {
		const settings = this.readSettings();
		const preset: ThemePreset = {
			id: `custom-${Date.now()}`,
			name,
			description: "Tema salvo por você.",
			css: settings.activeCss,
		};
		await this.context?.updateSettings({ presets: [...settings.presets, preset] });
		return preset;
	}

	exportTheme(): string {
		return JSON.stringify({ css: this.readSettings().activeCss }, null, 2);
	}

	async importTheme(json: string): Promise<void> {
		const parsed = JSON.parse(json) as { css: string };
		await this.setCss(parsed.css ?? "");
	}

	private applyCss(css: string): void {
		if (this.styleEl) this.styleEl.textContent = css;
	}
}

const GENERATED_START = "/* === All iₙ oNe: painel visual (não edite à mão) === */";
const GENERATED_END = "/* === fim do painel visual === */";

interface VisualVarSpec {
	cssVar: string;
	label: string;
	group: string;
	type: "color" | "size";
	fallback: string;
	fallbackNumber?: number;
	unit?: string;
	min?: number;
	max?: number;
	step?: number;
}

/**
 * Variáveis expostas no painel visual.
 *
 * Por que a lista é grande: partes da interface do Obsidian (a janela de
 * Configurações, por exemplo) usam variáveis próprias — `--background-secondary`,
 * `--modal-background`, `--titlebar-background`. Só mexer em
 * `--background-primary` deixa essas áreas cinzas/roxas inalteradas, que foi
 * exatamente o que apareceu no print. Cobrindo os grupos abaixo, a tela de
 * configurações e as barras também acompanham o tema.
 */
const VISUAL_VARS: VisualVarSpec[] = [
	// Texto
	{ cssVar: "--text-normal", label: "Texto principal", group: "Texto", type: "color", fallback: "#dcddde" },
	{ cssVar: "--text-muted", label: "Texto secundário", group: "Texto", type: "color", fallback: "#999999" },
	{ cssVar: "--text-faint", label: "Texto apagado", group: "Texto", type: "color", fallback: "#666666" },
	{ cssVar: "--text-accent", label: "Links e destaques", group: "Texto", type: "color", fallback: "#7f6df2" },
	{ cssVar: "--text-on-accent", label: "Texto sobre botão colorido", group: "Texto", type: "color", fallback: "#ffffff" },

	// Fundos
	{ cssVar: "--background-primary", label: "Fundo do editor", group: "Fundos", type: "color", fallback: "#202020" },
	{ cssVar: "--background-primary-alt", label: "Fundo alternativo do editor", group: "Fundos", type: "color", fallback: "#1a1a1a" },
	{ cssVar: "--background-secondary", label: "Fundo das barras laterais", group: "Fundos", type: "color", fallback: "#161616" },
	{ cssVar: "--background-secondary-alt", label: "Fundo do rodapé da barra lateral", group: "Fundos", type: "color", fallback: "#121212" },
	{ cssVar: "--background-modifier-border", label: "Cor das bordas", group: "Fundos", type: "color", fallback: "#333333" },
	{ cssVar: "--background-modifier-hover", label: "Fundo ao passar o mouse", group: "Fundos", type: "color", fallback: "#2a2a2a" },

	// Janelas e interface — o que faltava para a tela de Configurações mudar
	{ cssVar: "--modal-background", label: "Fundo das janelas (Configurações)", group: "Janelas e interface", type: "color", fallback: "#202020" },
	{ cssVar: "--modal-border-color", label: "Borda das janelas", group: "Janelas e interface", type: "color", fallback: "#333333" },
	{ cssVar: "--titlebar-background", label: "Barra de título", group: "Janelas e interface", type: "color", fallback: "#161616" },
	{ cssVar: "--titlebar-background-focused", label: "Barra de título (foco)", group: "Janelas e interface", type: "color", fallback: "#1a1a1a" },
	{ cssVar: "--titlebar-text-color", label: "Texto da barra de título", group: "Janelas e interface", type: "color", fallback: "#dcddde" },
	{ cssVar: "--tab-background-active", label: "Aba ativa", group: "Janelas e interface", type: "color", fallback: "#202020" },
	{ cssVar: "--interactive-accent", label: "Cor dos botões e interruptores", group: "Janelas e interface", type: "color", fallback: "#7f6df2" },
	{ cssVar: "--interactive-accent-hover", label: "Botões ao passar o mouse", group: "Janelas e interface", type: "color", fallback: "#8f7ff5" },
	{ cssVar: "--interactive-normal", label: "Fundo de controles neutros", group: "Janelas e interface", type: "color", fallback: "#2a2a2a" },
	{ cssVar: "--interactive-hover", label: "Controles ao passar o mouse", group: "Janelas e interface", type: "color", fallback: "#333333" },
	{ cssVar: "--scrollbar-thumb-bg", label: "Barra de rolagem", group: "Janelas e interface", type: "color", fallback: "#3a3a3a" },
	{ cssVar: "--divider-color", label: "Linhas divisórias", group: "Janelas e interface", type: "color", fallback: "#333333" },

	// Navegação — cobre a lista de plugins/arquivos, área que ficava "cinza"
	{ cssVar: "--nav-item-color", label: "Texto de itens de lista", group: "Navegação e listas", type: "color", fallback: "#999999" },
	{ cssVar: "--nav-item-color-hover", label: "Item ao passar o mouse", group: "Navegação e listas", type: "color", fallback: "#dcddde" },
	{ cssVar: "--nav-item-background-hover", label: "Fundo do item em hover", group: "Navegação e listas", type: "color", fallback: "#2a2a2a" },
	{ cssVar: "--nav-item-background-active", label: "Fundo do item selecionado", group: "Navegação e listas", type: "color", fallback: "#7f6df2" },
	{ cssVar: "--icon-color", label: "Cor dos ícones", group: "Navegação e listas", type: "color", fallback: "#999999" },

	// Controles — toggles, checkboxes, links (a área "roxo fixo" do print)
	{ cssVar: "--toggle-background-active", label: "Interruptor ligado", group: "Controles", type: "color", fallback: "#7f6df2" },
	{ cssVar: "--toggle-background", label: "Interruptor desligado", group: "Controles", type: "color", fallback: "#333333" },
	{ cssVar: "--checkbox-color", label: "Caixa de seleção marcada", group: "Controles", type: "color", fallback: "#7f6df2" },
	{ cssVar: "--link-color", label: "Links", group: "Controles", type: "color", fallback: "#7f6df2" },

	// Títulos
	{ cssVar: "--h1-color", label: "Título nível 1", group: "Títulos e ênfase", type: "color", fallback: "#ffffff" },
	{ cssVar: "--h2-color", label: "Título nível 2", group: "Títulos e ênfase", type: "color", fallback: "#eeeeee" },
	{ cssVar: "--h3-color", label: "Título nível 3", group: "Títulos e ênfase", type: "color", fallback: "#dddddd" },
	{ cssVar: "--bold-color", label: "Negrito", group: "Títulos e ênfase", type: "color", fallback: "#ffffff" },
	{ cssVar: "--italic-color", label: "Itálico", group: "Títulos e ênfase", type: "color", fallback: "#cccccc" },

	// Tipografia
	{
		cssVar: "--font-text-size",
		label: "Tamanho da fonte do editor",
		group: "Tipografia",
		type: "size",
		fallback: "16px",
		fallbackNumber: 16,
		min: 10,
		max: 32,
	},
	{
		cssVar: "--font-ui-medium",
		label: "Tamanho da fonte da interface",
		group: "Tipografia",
		type: "size",
		fallback: "15px",
		fallbackNumber: 15,
		min: 10,
		max: 24,
	},
	{
		cssVar: "--line-height-normal",
		label: "Altura da linha",
		group: "Tipografia",
		type: "size",
		fallback: "1.5",
		fallbackNumber: 1.5,
		unit: "",
		min: 1,
		max: 2.5,
		step: 0.1,
	},
];

/** Normaliza cores para o formato #rrggbb que o seletor de cor aceita. */
function normalizeColor(value: string): string {
	const trimmed = value.trim();
	if (/^#[0-9a-f]{6}$/i.test(trimmed)) return trimmed;
	if (/^#[0-9a-f]{3}$/i.test(trimmed)) {
		return "#" + trimmed.slice(1).split("").map((c) => c + c).join("");
	}
	const probe = document.createElement("div");
	probe.style.color = trimmed;
	document.body.appendChild(probe);
	const computed = getComputedStyle(probe).color;
	probe.remove();
	const match = computed.match(/\d+/g);
	if (!match) return "#000000";
	return (
		"#" +
		match.slice(0, 3).map((n) => Number(n).toString(16).padStart(2, "0")).join("")
	);
}

/** Pega algumas cores do CSS de um preset para desenhar a amostra no card. */
function extractSwatches(css: string): string[] {
	const wanted = ["--background-primary", "--background-secondary", "--text-normal", "--text-accent", "--h1-color"];
	const found: string[] = [];
	for (const name of wanted) {
		const match = css.match(new RegExp(`${name}\\s*:\\s*([^;]+);`));
		if (match) found.push(match[1].trim());
	}
	return found;
}

/** Conteúdo inicial do editor quando ainda não há CSS nenhum. */
const STARTER_CSS = `/* Seu CSS personalizado — edite e clique em "Aplicar CSS".
   Ctrl+Espaço abre a lista de variáveis disponíveis.
   As variáveis abaixo são só exemplos comentados; descomente para usar. */

body.theme-dark,
body.theme-light {
  /* --- Variáveis do Obsidian (afetam o app inteiro) --- */
  /* --text-normal: #ffffff; */          /* cor do texto das notas */
  /* --background-primary: #1e1e1e; */   /* fundo do editor */
  /* --text-accent: #7f6df2; */          /* links e destaques */
  /* --font-text-size: 16px; */          /* tamanho da fonte */
  /* --modal-background: #1e1e1e; */     /* fundo da janela de Configurações */
}

/* --- Elementos deste plugin (afetam só as telas do All iₙ oNe) --- */
/* .ione-hub-calendar__day { border-radius: 8px; } */
/* .ione-hub-lobby__sidebar { width: 280px; } */
`;

/** Referência dividida entre o que é do Obsidian e o que é deste plugin. */
const CSS_REFERENCE: {
	group: string;
	note?: string;
	entries: { name: string; description: string; example: string }[];
}[] = [
	{
		group: "📘 Variáveis do Obsidian — cores de texto",
		note: "Afetam o aplicativo inteiro, incluindo outros plugins.",
		entries: [
			{ name: "--text-normal", description: "cor do texto principal", example: "#ffffff" },
			{ name: "--text-muted", description: "texto secundário", example: "#999999" },
			{ name: "--text-faint", description: "texto bem apagado, dicas", example: "#666666" },
			{ name: "--text-accent", description: "links e destaques", example: "#7f6df2" },
			{ name: "--text-error", description: "mensagens de erro", example: "#ff3333" },
			{ name: "--text-selection", description: "fundo do texto selecionado", example: "#3a6dc4" },
		],
	},
	{
		group: "📘 Variáveis do Obsidian — fundos e janelas",
		note: "Inclui as variáveis que a janela de Configurações usa — sem elas, aquelas áreas ficam com a cor do tema instalado.",
		entries: [
			{ name: "--background-primary", description: "fundo do editor", example: "#202020" },
			{ name: "--background-secondary", description: "fundo das barras laterais", example: "#161616" },
			{ name: "--background-modifier-border", description: "cor das bordas", example: "#333333" },
			{ name: "--background-modifier-hover", description: "fundo ao passar o mouse", example: "#2a2a2a" },
			{ name: "--modal-background", description: "fundo das janelas (Configurações)", example: "#202020" },
			{ name: "--titlebar-background", description: "barra de título da janela", example: "#161616" },
			{ name: "--interactive-accent", description: "botões e interruptores", example: "#7f6df2" },
			{ name: "--scrollbar-thumb-bg", description: "barra de rolagem", example: "#3a3a3a" },
		],
	},
	{
		group: "📘 Variáveis do Obsidian — tipografia e títulos",
		entries: [
			{ name: "--font-text-size", description: "tamanho da fonte do editor", example: "16px" },
			{ name: "--font-text", description: "fonte do texto das notas", example: "Georgia, serif" },
			{ name: "--font-monospace", description: "fonte dos blocos de código", example: "Consolas, monospace" },
			{ name: "--font-interface", description: "fonte dos menus", example: "Inter, sans-serif" },
			{ name: "--line-height-normal", description: "altura da linha", example: "1.6" },
			{ name: "--h1-color", description: "cor do título nível 1", example: "#ffffff" },
			{ name: "--h1-size", description: "tamanho do título nível 1", example: "2em" },
			{ name: "--bold-color", description: "cor do negrito", example: "#ffcc00" },
		],
	},
	{
		group: "🧩 Elementos do All iₙ oNe",
		note: "Classes CSS das telas deste plugin. Não afetam o resto do Obsidian.",
		entries: [
			{ name: ".ione-hub-calendar__day", description: "cada dia da grade do calendário", example: "border-radius: 8px" },
			{ name: ".ione-hub-calendar__day--today", description: "o dia de hoje na grade", example: "outline-color: gold" },
			{ name: ".ione-hub-lobby__sidebar", description: "barra lateral do Lobby", example: "width: 280px" },
			{ name: ".ione-hub-lobby__nav-item", description: "cada item do menu do Lobby", example: "border-radius: 6px" },
			{ name: ".ione-hub-notification", description: "pop-up de notificação", example: "font-size: 14px" },
			{ name: ".ione-hub-preset-card", description: "cartão de tema pronto", example: "border-radius: 12px" },
		],
	},
];

/** Insere texto na posição do cursor do textarea. */
function insertAtCursor(textarea: HTMLTextAreaElement, text: string): void {
	const start = textarea.selectionStart;
	const end = textarea.selectionEnd;
	textarea.value = textarea.value.slice(0, start) + text + textarea.value.slice(end);
	const caret = start + text.length;
	textarea.setSelectionRange(caret, caret);
}

/**
 * Autocomplete simples de variáveis CSS: Ctrl+Espaço abre a lista filtrada
 * pelo trecho já digitado; setas navegam, Enter/Tab insere, Esc fecha.
 */
function attachVariableAutocomplete(textarea: HTMLTextAreaElement, box: HTMLElement): void {
	const allVars = CSS_REFERENCE.flatMap((g) => g.entries).filter((e) => e.name.startsWith("--"));
	let open = false;
	let selectedIndex = 0;
	let matches: typeof allVars = [];

	const close = () => {
		open = false;
		box.style.display = "none";
		box.empty();
	};

	const currentWord = (): string => {
		const upToCaret = textarea.value.slice(0, textarea.selectionStart);
		const match = upToCaret.match(/(--[\w-]*)$/);
		return match ? match[1] : "";
	};

	const draw = () => {
		box.empty();
		matches.forEach((entry, index) => {
			const row = box.createDiv({ cls: "ione-hub-styles__suggestion" });
			if (index === selectedIndex) row.addClass("is-selected");
			row.createEl("code", { text: entry.name });
			row.createSpan({ text: ` — ${entry.description}` });
			row.onmousedown = (evt) => {
				evt.preventDefault();
				accept(entry.name);
			};
		});
		box.style.display = matches.length > 0 ? "block" : "none";
	};

	const accept = (name: string) => {
		const word = currentWord();
		const start = textarea.selectionStart - word.length;
		textarea.value = textarea.value.slice(0, start) + name + textarea.value.slice(textarea.selectionStart);
		const caret = start + name.length;
		textarea.setSelectionRange(caret, caret);
		close();
		textarea.focus();
	};

	textarea.addEventListener("keydown", (evt) => {
		if (evt.ctrlKey && evt.code === "Space") {
			evt.preventDefault();
			const word = currentWord();
			matches = allVars.filter((v) => v.name.startsWith(word || "--")).slice(0, 12);
			selectedIndex = 0;
			open = matches.length > 0;
			draw();
			return;
		}
		if (!open) return;

		if (evt.key === "ArrowDown") {
			evt.preventDefault();
			selectedIndex = (selectedIndex + 1) % matches.length;
			draw();
		} else if (evt.key === "ArrowUp") {
			evt.preventDefault();
			selectedIndex = (selectedIndex - 1 + matches.length) % matches.length;
			draw();
		} else if (evt.key === "Enter" || evt.key === "Tab") {
			evt.preventDefault();
			accept(matches[selectedIndex].name);
		} else if (evt.key === "Escape") {
			close();
		}
	});

	textarea.addEventListener("blur", () => window.setTimeout(close, 150));
}

/** Remove o bloco gerado pelo painel visual, preservando o CSS escrito à mão. */
function stripGeneratedBlock(css: string): string {
	const startIdx = css.indexOf(GENERATED_START);
	const endIdx = css.indexOf(GENERATED_END);
	if (startIdx === -1 || endIdx === -1) return css;
	return (css.slice(0, startIdx) + css.slice(endIdx + GENERATED_END.length)).trim();
}

/** Mostra uma miniatura de interface com o tema aplicado, antes de trocar de verdade. */
class ThemePreviewModal extends Modal {
	constructor(app: App, private preset: ThemePreset, private onApply: () => void | Promise<void>) {
		super(app);
	}

	onOpen(): void {
		this.contentEl.createEl("h2", { text: `Preview: ${this.preset.name}` });

		const frame = this.contentEl.createDiv({ cls: "ione-hub-theme-preview" });
		// O CSS do preset é aplicado só dentro deste bloco, via <style> escopado.
		const styleEl = frame.createEl("style");
		// A regex cobre tanto "body" solto (CSS escrito à mão) quanto os
		// seletores "body.theme-dark"/"body.theme-light" usados pelos temas
		// prontos — a versão anterior só tratava "body {" puro e não escopava
		// o preview corretamente para os temas prontos.
		styleEl.textContent = this.preset.css.replace(
			/body(\.theme-(?:dark|light))?/g,
			".ione-hub-theme-preview"
		);

		const sample = frame.createDiv({ cls: "ione-hub-theme-preview__sample" });
		sample.createEl("h3", { text: "Título de exemplo" });
		sample.createEl("p", { text: "Texto normal de uma nota, para ver contraste e legibilidade." });
		sample.createEl("a", { text: "Um link de exemplo", href: "#" });

		new Setting(this.contentEl)
			.addButton((btn) =>
				btn
					.setButtonText("Aplicar este tema")
					.setCta()
					.onClick(async () => {
						await this.onApply();
						this.close();
					})
			)
			.addButton((btn) => btn.setButtonText("Cancelar").onClick(() => this.close()));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
