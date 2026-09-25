import { TFile } from "obsidian";
import type { App } from "obsidian";
import type { HubSettings } from "./types";
import { resolvePaths } from "./PathResolver";
import { ensureVaultFolder } from "./VaultPaths";

export class ManualManager {
	constructor(private app: App) {}

	async update(settings: HubSettings): Promise<void> {
		const paths = resolvePaths(settings.paths);
		const path = `${paths.systemFolder}/00 - Manual.md`;
		await ensureVaultFolder(this.app, paths.systemFolder);
		const content = [
			"---", "title: Manual All-in-oNe", "type: system", "---", "",
			"# All-in-oNe", "",
			"## Estrutura atual do vault", "",
			"```text",
			`${paths.inboxFolder}/`,
			`${paths.calendarFolder}/`,
			`  └── YYYY/`,
			`      └── MM - Mes/`,
			`          └── YYYY-MM-DD.md`,
			`${paths.calendarTemplatesFolder}/`,
			`${paths.eventNotesFolder}/`,
			`${paths.systemFolder}/`,
			`  ├── 00 - Manual.md`,
			`  └── ${paths.filesFolder}/`,
			"```", "",
			"## Caminhos configurados", "",
			`- Inbox: \`${paths.inboxFolder}\``,
			`- Calendário: \`${paths.calendarFolder}\``,
			`- Templates: \`${paths.calendarTemplatesFolder}\``,
			`- Notas de eventos: \`${paths.eventNotesFolder}\``,
			`- Sistema: \`${paths.systemFolder}\``,
			`- Arquivos: \`${paths.filesFolder}\``, "",
			"## Calendário", "",
			"- Clique em qualquer dia para abrir a nota diária existente ou criar uma nova.",
			"- Uma nota diária é única por data; templates criam notas adicionais sem substituir a diária.",
			"- Os indicadores ●, ●● e ●●● mostram a quantidade de notas do dia.",
			"- Eventos podem coexistir no mesmo horário e aparecem juntos no lembrete.", "",
			"## Templates", "",
			`- Templates são encontrados recursivamente em \`${paths.calendarTemplatesFolder}\`.`,
			"- Uma nota criada por regra nasce como incompleta; `concluido: true` marca como completa e a devolve à origem.",
			"- O template original nunca é alterado.", "",
			"## Estilos", "",
			"- O módulo Estilos oferece temas prontos, painel visual e editor CSS livre.",
			"- O onboarding usa a mesma interface de temas do módulo Estilos.", "",
			"## Configuração e módulos", "",
			"- O Lobby centraliza habilitação, configurações e diagnóstico dos módulos.",
			"- Caminhos derivados acompanham as raízes configuradas; caminhos personalizados são preservados.",
			"- Os dados do usuário não são migrados, movidos ou apagados automaticamente.", "",
			"## Comandos", "",
			"- `Abrir All-in-oNe` abre o Lobby.",
			"- `Calendário: Abrir nota de hoje` abre ou cria a nota diária de hoje.", "",
			"Este manual é regenerado a cada inicialização do plugin e reflete os caminhos configurados naquele momento.",
		].join("\n");
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) await this.app.vault.modify(existing, content);
		else await this.app.vault.create(path, content);
	}
}