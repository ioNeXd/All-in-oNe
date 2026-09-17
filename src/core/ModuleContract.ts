import type { App } from "obsidian";
import type { EventBus } from "./EventBus";
import type { HubSettings } from "./types";

/**
 * CONTRATO DE MÓDULO
 * -------------------
 * Este é o "contrato" (interface) que todo módulo do plugin — os 8 que já
 * existem (MCP, Ciclo de Vida, Estilos, Auto-update, Templates, Calendário,
 * Notificações, Histórico) e qualquer módulo futuro — precisa implementar.
 *
 * O núcleo (HubCore) nunca conhece os detalhes internos de um módulo. Ele só
 * conhece esta interface. Isso é o que permite adicionar um 7º, 8º, 9º módulo
 * no futuro sem alterar o núcleo, o Lobby ou o event bus: basta escrever uma
 * classe que implemente HubModule e registrá-la.
 *
 * REGRAS DO CONTRATO (documentadas aqui para quem for escrever um novo
 * módulo no futuro):
 *   1. Um módulo NUNCA acessa outro módulo diretamente. Toda comunicação
 *      entre módulos acontece via `context.bus` (o event bus).
 *   2. Um módulo NUNCA deve deixar uma exceção escapar de onEnable/onDisable/
 *      um handler de evento — isso quebraria o isolamento (ver HubCore,
 *      onde cada chamada de método de módulo é envolvida em try/catch).
 *   3. Um módulo declara, em `manifest`, todos os eventos que emite e todos
 *      que escuta. Isso serve tanto de documentação viva quanto de dado que
 *      a "Central de Eventos" do Lobby usa para mostrar o mapa de conexões.
 *   4. Configuração do módulo vive dentro de `settings.modules[moduleId]`,
 *      nunca em outro lugar. O módulo é dono do formato interno dessa fatia;
 *      a UI de configuração é o próprio `renderSettingsPanel` do módulo.
 *      O `settingsSchema` é documentação declarativa opcional dos campos
 *      (ex.: diagnósticos, futura UI gerada automaticamente).
 */

export type ModuleId =
	| "mcp"
	| "filelifecycle"
	| "styles"
	| "autoupdate"
	| "templates"
	| "calendar"
	| "notifications"
	| "history"
	| (string & {}); // permite módulos futuros com IDs não previstos aqui

/** Nível de severidade de um campo de configuração inválido. */
export type ConfigValidationLevel = "error" | "warning";

export interface ConfigValidationIssue {
	field: string;
	message: string;
	level: ConfigValidationLevel;
}

/**
 * Descreve um campo de configuração de forma genérica o suficiente para o
 * Lobby conseguir renderizar um formulário sem conhecer o módulo.
 */
export interface SettingsFieldSchema {
	key: string;
	label: string;
	description?: string;
	type: "text" | "path" | "boolean" | "number" | "select" | "color";
	options?: { value: string; label: string }[]; // usado quando type === "select"
	default: unknown;
}

/**
 * Metadados estáticos e declarativos de um módulo — usados pelo Lobby (para
 * listar módulos, gerar UI de config, mostrar na Central de Eventos e na aba
 * de Ajuda) sem precisar instanciar ou conhecer o módulo em si.
 */
export interface ModuleManifest {
	id: ModuleId;
	displayName: string;
	description: string;
	icon: string; // nome de ícone do lucide, usados nativamente pelo Obsidian
	/** Versão do próprio módulo (SemVer), independente da versão do plugin. */
	version: string;
	/** Versão do contrato (ModuleContract) que este módulo foi escrito contra. */
	contractVersion: string;
	/** Só roda em desktop (ex.: MCP depende de abrir uma porta HTTP local). */
	desktopOnly: boolean;
	/** Nomes de eventos que este módulo pode emitir no bus. */
	emits: string[];
	/** Nomes de eventos que este módulo escuta no bus. */
	listensTo: string[];
	/**
	 * Campos de configuração próprios do módulo — documentação declarativa.
	 * A UI de configuração de fato é o `renderSettingsPanel` do módulo; este
	 * schema descreve os campos para ferramentas (diagnóstico, docs) e para
	 * uma futura UI gerada automaticamente.
	 */
	settingsSchema?: SettingsFieldSchema[];
}

/** Contexto injetado em todo módulo na hora de habilitá-lo. */
export interface ModuleContext {
	app: App;
	bus: EventBus;
	/** Lê a fatia de configuração deste módulo (settings.modules[moduleId]). */
	getSettings: <T = Record<string, unknown>>() => T;
	/**
	 * Atualiza a fatia de configuração deste módulo e persiste no disco.
	 * Retorna as issues de validação — vazias significa gravado; com erro
	 * bloqueante, NADA foi persistido (o módulo decide como avisar o usuário).
	 */
	updateSettings: (patch: Record<string, unknown>) => Promise<ConfigValidationIssue[]>;
	/** Acesso de leitura ao restante da config (para casos de integração). */
	getFullSettings: () => HubSettings;
	/**
	 * Estado de RUNTIME: o módulo está ativo AGORA? Não confundir com a config
	 * persistida (`enabledModules`) — um módulo listado lá pode ter FALHADO ao
	 * habilitar (erro no onEnable, modo seguro). Decisões do tipo "se o módulo
	 * X está ligado, ele cuida disso" precisam do estado real, senão os dois
	 * lados divergem e ninguém faz o trabalho (ex.: fallback do Templates).
	 */
	isModuleEnabled: (moduleId: ModuleId) => boolean;
	/**
	 * Log estruturado do módulo — vira um evento `core:log` no bus: aparece
	 * na Central de Eventos do Lobby (log da sessão) e pode ser registrado
	 * de forma persistente por quem o escutar (ex.: o módulo de Histórico).
	 */
	log: (message: string, data?: Record<string, unknown>) => void;
	/** Registra um comando no Command Palette do Obsidian, com cleanup automático. */
	registerCommand: (id: string, name: string, callback: () => void) => void;
	/**
	 * Serializa operações de escrita para um mesmo caminho de arquivo, evitando
	 * race conditions entre módulos (ex.: Templates movendo uma nota enquanto
	 * o MCP a edita). Ver FileWriteQueue.ts.
	 */
	fileWriteQueueRun: <T>(path: string, operation: () => Promise<T>) => Promise<T>;
	/**
	 * Atualiza `settings.paths` (caminhos globais, compartilhados entre
	 * módulos) com a mesma validação de conflito usada pela tela geral do
	 * Lobby. Permite que um módulo ofereça, dentro do seu próprio painel, a
	 * edição de um caminho que ele é dono — sem duplicar a lógica de
	 * validação em cada módulo.
	 */
	updatePaths: (patch: Record<string, string>) => Promise<ConfigValidationIssue[]>;
}

/**
 * A interface que toda classe de módulo deve implementar.
 */
export interface HubModule {
	readonly manifest: ModuleManifest;

	/**
	 * Chamado UMA VEZ no registro do módulo, independentemente de estar
	 * ligado ou desligado. Deve apenas guardar o `context` para uso posterior
	 * (configurações, renderSettingsPanel) — nunca iniciar nada "ativo" aqui
	 * (portas, listeners de vault, timers). Isso é o que permite configurar
	 * um módulo (ex.: mudar a porta do MCP) mesmo com ele desligado.
	 */
	onRegister(context: ModuleContext): void;

	/** Chamado quando o módulo é habilitado (no load do plugin, ou ao ligar pelo Lobby). Aqui sim: inicia o que for "ativo". */
	onEnable(): Promise<void> | void;

	/** Chamado quando o módulo é desabilitado (unload do plugin, ou ao desligar pelo Lobby). */
	onDisable(): Promise<void> | void;

	/**
	 * Chamado quando a configuração global (ou deste módulo) muda — tanto em
	 * gravações via `updateSettings` quanto nos níveis de reset "config"/"all"
	 * (que substituem a configuração inteira). Deve ser rápido e não deve
	 * lançar: o núcleo isola falhas, mas a semântica é "reagir a tempo".
	 */
	onSettingsChange?(newSettings: HubSettings): void;

	/**
	 * Chamado pelo núcleo nos níveis de reset "data" e "all" — o módulo deve
	 * limpar APENAS os dados que ele mesmo gerou (histórico, cache), gravando
	 * em sua fatia de configuração. Nunca apagar notas do usuário. O nível
	 * "config" NÃO chama este hook: configurações não são dados gerados.
	 */
	onResetData?(): Promise<void> | void;

	/**
	 * Valida a configuração antes de salvar — usado pelo núcleo para checar
	 * conflitos de caminho entre módulos e valores inválidos. Deve ser
	 * síncrono e barato (não deve ler o disco).
	 */
	validateSettings?(settings: HubSettings): ConfigValidationIssue[];

	/**
	 * Componente de UI (renderiza dentro do slot do Lobby). Disponível mesmo
	 * com o módulo desligado, desde que onRegister já tenha rodado.
	 */
	renderSettingsPanel?(container: HTMLElement): void;

	/** Retorna um resumo curto de status para o painel de Diagnóstico do Lobby. */
	getHealthStatus?(): { ok: boolean; summary: string };
}
