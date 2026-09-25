import { TFile } from "obsidian";
import type { App } from "obsidian";
import type { HubSettings } from "./types";
import { ensureVaultFolder } from "./VaultPaths";

export class ManualManager {
	constructor(private app: App) {}

	async update(settings: HubSettings): Promise<void> {
		const system = settings.paths.systemFolder || "99 - Sistema";
		const path = system + "/00 - Manual.md";
		await ensureVaultFolder(this.app, system);
		const p = settings.paths;
		const eventFolder = (settings.modules.calendar?.eventNotesFolder as string) || "01 - Calendario/Notas-Eventos";
		const content = [
			"---", "title: Manual All-in-oNe", "type: system", "---", "",
			"# All-in-oNe", "", "## Estrutura atual do vault", "",
			"```text", "00 - Inbox/", p.calendarFolder + "/", "  └── YYYY/", "      └── MM - Mes/", "          ├── YYYY-MM-DD.md", "          └── <Template>-YYYY-MM-DD.md", "99 - Sistema/", "  ├── 00 - Manual.md", "  ├── templetes/", "  └── arquivos/", "```", "",
			"## Caminhos configurados", "",
			"- Inbox: `" + (p.inboxFolder || "00 - Inbox") + "`", "- Calendário: `" + p.calendarFolder + "`", "- Templates: `" + p.calendarTemplatesFolder + "`", "- Notas de eventos: `" + eventFolder + "`", "- Sistema: `" + system + "`", "- Arquivos: `" + (p.filesFolder || "99 - Sistema/arquivos") + "`", "",
			"## Calendário", "",
			"- Clique em qualquer dia para abrir a nota existente, criar a Nota diária ou escolher um template.", "- A Nota diária usa `" + p.calendarTemplatesFolder + "/calendario/Nota diaria.md` quando disponível.", "- Os indicadores `●`, `●●`, `●●●` representam a quantidade de notas do dia.", "- Dias do mês anterior e seguinte também são clicáveis.", "- Eventos podem coexistir no mesmo horário e são agrupados numa única janela de lembrete quando disparam juntos.", "",
			"## Eventos", "", "- Eventos podem ter descrição, horário, recorrência, lembrete e nota vinculada.", "- Um evento com nota vinculada pode abrir essa nota ou entrar no editor para selecionar/criar outra.", "- Eventos existentes são listados por data e podem ser editados.", "",
			"## Templates", "", "- Templates são encontrados recursivamente em `" + p.calendarTemplatesFolder + "`.", "- A pesquisa de template permite filtrar por nome ou subpasta.", "- O template original nunca é alterado.", "",
			"## Comandos", "", "- `Calendário: Abrir nota de hoje` abre/cria a Nota diária de hoje.", "- Use o Lobby para acessar os módulos e configurações.", "",
			"## Observação", "", "Este manual é regenerado na inicialização do plugin para refletir os caminhos configurados atualmente.",
		].join("\n");
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) await this.app.vault.modify(existing, content);
		else await this.app.vault.create(path, content);
	}
}
