/**
 * TEMAS PRONTOS
 * -------------
 * Em vez de listar ~30 variáveis à mão para cada um dos 7 temas (repetitivo
 * e fácil de esquecer alguma — foi exatamente o que aconteceu na v0.4.0: só
 * as variáveis "óbvias" tinham cor, e telas como Configurações, a busca de
 * plugins e a lista de plugins continuavam na cor original), cada tema
 * declara só um punhado de cores-base, e `buildTheme()` deriva o resto de
 * forma consistente. Isso cobre também `--interactive-normal`,
 * `--nav-item-*`, `--checkbox-*`, `--scrollbar-*`, que é o que faltava nas
 * áreas "cinza/roxo" apontadas no print de referência.
 */

export interface ThemePreset {
	id: string;
	name: string;
	description: string;
	css: string;
}

interface BaseColors {
	bg: string; // fundo do editor
	bgAlt: string; // fundo alternativo (levemente diferente do bg)
	bgSecondary: string; // barras laterais, Configurações
	bgSecondaryAlt: string; // rodapé da barra lateral
	border: string;
	hover: string;
	text: string;
	textMuted: string;
	textFaint: string;
	accent: string;
	accentHover: string;
	textOnAccent: string;
	error: string;
}

function buildTheme(c: BaseColors): string {
	const vars: Record<string, string> = {
		// Texto
		"--text-normal": c.text,
		"--text-muted": c.textMuted,
		"--text-faint": c.textFaint,
		"--text-accent": c.accent,
		"--text-accent-hover": c.accentHover,
		"--text-on-accent": c.textOnAccent,
		"--text-error": c.error,
		"--text-selection": hexToRgba(c.accent, 0.28),

		// Fundos
		"--background-primary": c.bg,
		"--background-primary-alt": c.bgAlt,
		"--background-secondary": c.bgSecondary,
		"--background-secondary-alt": c.bgSecondaryAlt,
		"--background-modifier-border": c.border,
		"--background-modifier-hover": c.hover,
		"--background-modifier-form-field": c.bgAlt,
		"--background-modifier-error": hexToRgba(c.error, 0.15),

		// Janelas e interface — cobre a janela de Configurações inteira,
		// que é a área que ficava "original" antes desta correção.
		"--modal-background": c.bgSecondary,
		"--modal-border-color": c.border,
		"--titlebar-background": c.bgSecondary,
		"--titlebar-background-focused": c.bgSecondaryAlt,
		"--titlebar-text-color": c.text,
		"--tab-background-active": c.bg,
		"--interactive-accent": c.accent,
		"--interactive-accent-hover": c.accentHover,
		"--interactive-normal": c.bgAlt,
		"--interactive-hover": c.hover,
		"--scrollbar-thumb-bg": c.hover,
		"--scrollbar-active-thumb-bg": c.accent,
		"--divider-color": c.border,

		// Navegação (lista de plugins, arquivos, etc — a área "cinza" do print)
		"--nav-item-color": c.textMuted,
		"--nav-item-color-hover": c.text,
		"--nav-item-color-active": c.textOnAccent,
		"--nav-item-background-hover": c.hover,
		"--nav-item-background-active": c.accent,
		"--icon-color": c.textMuted,
		"--icon-color-hover": c.text,
		"--icon-color-active": c.accent,

		// Controles (toggles, checkboxes, links) — a área "roxo/cinza" fixa do print
		"--toggle-thumb-color": c.textOnAccent,
		"--toggle-background-active": c.accent,
		"--toggle-background": c.hover,
		"--checkbox-color": c.accent,
		"--checkbox-color-hover": c.accentHover,
		"--checkbox-border-color": c.border,
		"--link-color": c.accent,
		"--link-color-hover": c.accentHover,

		// Títulos
		"--h1-color": c.text,
		"--h2-color": c.accent,
		"--h3-color": c.accentHover,
		"--bold-color": c.text,
		"--italic-color": c.textMuted,
		"--code-background": c.bgAlt,
		"--code-normal": c.text,
	};

	const body = Object.entries(vars)
		.map(([k, v]) => `  ${k}: ${v};`)
		.join("\n");
	return `body.theme-dark,\nbody.theme-light {\n${body}\n}`;
}

function hexToRgba(hex: string, alpha: number): string {
	const clean = hex.replace("#", "");
	const bigint = parseInt(clean, 16);
	const r = (bigint >> 16) & 255;
	const g = (bigint >> 8) & 255;
	const b = bigint & 255;
	return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export const BUILTIN_PRESETS: ThemePreset[] = [
	{
		id: "claude",
		name: "Claude",
		description: "Terracota sobre pergaminho quente. Alto conforto de leitura, pouco contraste agressivo.",
		css: buildTheme({
			bg: "#262624",
			bgAlt: "#1f1f1d",
			bgSecondary: "#1f1f1d",
			bgSecondaryAlt: "#191918",
			border: "#3e3e3a",
			hover: "#32322f",
			text: "#f5f4ee",
			textMuted: "#b7b5ab",
			textFaint: "#7d7b73",
			accent: "#d97757",
			accentHover: "#e08b6f",
			textOnAccent: "#ffffff",
			error: "#e5484d",
		}),
	},
	{
		id: "dracula",
		name: "Dracula",
		description: "Roxo escuro com destaques em rosa e verde. Um dos esquemas mais populares entre devs.",
		css: buildTheme({
			bg: "#282a36",
			bgAlt: "#21222c",
			bgSecondary: "#21222c",
			bgSecondaryAlt: "#191a21",
			border: "#44475a",
			hover: "#44475a",
			text: "#f8f8f2",
			textMuted: "#bd93f9",
			textFaint: "#6272a4",
			accent: "#ff79c6",
			accentHover: "#ff92d0",
			textOnAccent: "#282a36",
			error: "#ff5555",
		}),
	},
	{
		id: "vscode-dark",
		name: "VS Code Dark+",
		description: "O azul-acinzentado clássico do editor da Microsoft, com azul de destaque.",
		css: buildTheme({
			bg: "#1e1e1e",
			bgAlt: "#252526",
			bgSecondary: "#252526",
			bgSecondaryAlt: "#333333",
			border: "#3c3c3c",
			hover: "#2a2d2e",
			text: "#d4d4d4",
			textMuted: "#9cdcfe",
			textFaint: "#6a9955",
			accent: "#569cd6",
			accentHover: "#6fb3e8",
			textOnAccent: "#ffffff",
			error: "#f14c4c",
		}),
	},
	{
		id: "nord",
		name: "Nord",
		description: "Paleta ártica em azul frio. Suave e uniforme, boa para sessões longas.",
		css: buildTheme({
			bg: "#2e3440",
			bgAlt: "#3b4252",
			bgSecondary: "#3b4252",
			bgSecondaryAlt: "#434c5e",
			border: "#4c566a",
			hover: "#434c5e",
			text: "#eceff4",
			textMuted: "#d8dee9",
			textFaint: "#7b88a1",
			accent: "#88c0d0",
			accentHover: "#8fbcbb",
			textOnAccent: "#2e3440",
			error: "#bf616a",
		}),
	},
	{
		id: "gruvbox",
		name: "Gruvbox Dark",
		description: "Tons retrô quentes, marrom e mostarda. Contraste médio, bem confortável.",
		css: buildTheme({
			bg: "#282828",
			bgAlt: "#32302f",
			bgSecondary: "#32302f",
			bgSecondaryAlt: "#3c3836",
			border: "#504945",
			hover: "#3c3836",
			text: "#ebdbb2",
			textMuted: "#bdae93",
			textFaint: "#928374",
			accent: "#fabd2f",
			accentHover: "#fbc74f",
			textOnAccent: "#282828",
			error: "#fb4934",
		}),
	},
	{
		id: "solarized-light",
		name: "Solarized Light",
		description: "Tema claro clássico, fundo sépia e contraste calibrado para pouca fadiga visual.",
		css: buildTheme({
			bg: "#fdf6e3",
			bgAlt: "#eee8d5",
			bgSecondary: "#eee8d5",
			bgSecondaryAlt: "#e4ddc8",
			border: "#d6cfbb",
			hover: "#e4ddc8",
			text: "#073642",
			textMuted: "#586e75",
			textFaint: "#93a1a1",
			accent: "#268bd2",
			accentHover: "#2aa198",
			textOnAccent: "#fdf6e3",
			error: "#dc322f",
		}),
	},
	{
		id: "high-contrast",
		name: "Alto contraste (acessibilidade)",
		description: "Preto e branco puros com destaque amarelo. Para baixa visão ou telas com muito reflexo.",
		css: buildTheme({
			bg: "#000000",
			bgAlt: "#0a0a0a",
			bgSecondary: "#0a0a0a",
			bgSecondaryAlt: "#141414",
			border: "#ffffff",
			hover: "#222222",
			text: "#ffffff",
			textMuted: "#e0e0e0",
			textFaint: "#b0b0b0",
			accent: "#ffff00",
			accentHover: "#ffff66",
			textOnAccent: "#000000",
			error: "#ff4444",
		}),
	},
];
