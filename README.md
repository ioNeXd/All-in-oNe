# All iₙ oNe — plugin pessoal e modular para o Obsidian

Um hub único dentro do Obsidian que reúne **8 módulos independentes** num só
plugin: servidor MCP embutido, ciclo de vida de arquivos, editor de estilos,
templates automáticos por pasta, calendário integrado, notificações,
histórico persistente e auto-update via GitHub — todos conectados por um
núcleo comum de eventos, e todos configuráveis pelo usuário.

> Este plugin nasceu como um projeto pessoal, então prioriza o fluxo de
> trabalho de quem o criou. Ainda assim, foi desenhado para outras pessoas
> conseguirem instalar, entender e usar sem contexto prévio.

## O que ele faz

| Módulo | O que faz |
|---|---|
| **Servidor MCP** | Expõe o vault (leitura e escrita) para clientes MCP como Claude Desktop, Cursor ou Claude Code, via HTTP POST (Streamable HTTP stateless), com suporte a MCP 2026-07-28 e compatibilidade com a era 2025, enquanto o Obsidian estiver aberto. Permissões por pasta, modo dry-run, rate limiting, split/combine de notas, liberação temporária de escrita, anexos (listar/ler/upload/excluir para a lixeira). |
| **Ciclo de vida de arquivos** | Pergunta o nome ao criar qualquer nota antes dos outros módulos reagirem; confirmação opcional para renomear/mover/excluir. |
| **Estilos** | Editor de CSS livre + painel visual (~40 variáveis), 7 temas prontos, preview antes de aplicar, undo, export/import — estiliza o próprio Obsidian e os outros módulos (ex.: o Calendário). |
| **Auto-update** | Verifica e aplica atualizações a partir dos Releases do repositório no GitHub (o plugin não está na loja oficial). Canal estável/beta, checksum SHA-256, verificação opcional de assinatura GPG, cedência automática ao BRAT, backup automático e rollback. |
| **Templates por pasta** | Ao criar uma nota numa pasta configurada, aplica o template certo e preenche metadados automaticamente. Notas incompletas vão para a pasta configurada de notas incompletas e voltam sozinhas quando completadas. |
| **Calendário** | Interface de calendário ligada ao sistema de templates: clique numa data, escolha um template (definido por você), a nota é criada e organizada automaticamente. Eventos recorrentes com lembrete, nota vinculada (que não quebra ao renomear) e importação de arquivos `.ics`. |
| **Notificações** | Pop-up com som para qualquer evento do plugin — configurável por tipo de evento, com modo não-perturbe e histórico persistente com filtro por tipo e agrupamento por dia. |
| **Histórico** | Registro persistente de tudo o que o plugin fez (criações, movimentos, ações MCP), com filtro por tipo, busca por texto e limite configurável. |

Todos os módulos podem ser ligados/desligados individualmente pelo **Lobby**
— o painel central do plugin, acessível pelo ícone na barra lateral ou pelo
Command Palette (`Ctrl/Cmd+P` → "Abrir All iₙ oNe"). O Lobby inclui aba de
**Diagnóstico** (saúde de cada módulo), **Histórico** filtrável e **Ajuda**,
e cada módulo tem um painel de configurações próprio — usável até com o
módulo desligado.

## Instalação

O All iₙ oNe **não está na loja oficial de plugins do Obsidian**. Duas formas
de instalar:

### Opção 1 — BRAT (recomendado)
1. Instale o plugin [BRAT](https://github.com/TfTHacker/obsidian42-brat) pela loja oficial do Obsidian.
2. No BRAT, adicione este repositório como plugin beta.
3. O BRAT cuida de manter o plugin atualizado — e o módulo de Auto-update
   deste plugin DETECTA isso e cede o controle: sem checagem automática e
   sem comandos, com aviso no painel (o BRAT fica como único dono do
   update, sem duas ferramentas escrevendo os mesmos arquivos).

### Opção 2 — Manual
1. Baixe `main.js`, `manifest.json` e `styles.css` do [Release mais recente](../../releases/latest).
2. Crie a pasta `<seu-vault>/.obsidian/plugins/All-in-oNe/` e coloque os três arquivos lá.
3. Recarregue o Obsidian e habilite o plugin em Configurações → Plugins da comunidade.
4. A partir daí, o módulo de Auto-update deste próprio plugin cuida das
   próximas atualizações (opcionalmente com verificação de assinatura GPG
   dos assets — ver o painel do módulo).

Na primeira execução, um assistente de configuração inicial (onboarding) vai
perguntar alguns caminhos básicos.

## Desenvolvimento

```bash
npm install
npm run dev     # build com watch, para desenvolvimento
npm run build   # build de produção
npm test        # suíte Vitest completa — todos os testes importam o código real
```

Veja `CONTRIBUTING.md` para o guia de como o projeto é organizado e como
adicionar um módulo novo sem tocar no núcleo.

## Arquitetura, em uma frase

Um **núcleo** (event bus + configuração + fila de escrita + helpers
compartilhados) e **8 módulos independentes** que seguem um **contrato
comum** — nenhum módulo conhece outro diretamente, toda comunicação passa
pelo núcleo. Isso é o que permite ligar/desligar cada feature sem afetar as
demais, e adicionar um nono módulo no futuro sem alterar o que já existe.

> **Versão:** o manifest.json mostra a versão do **plugin** (0.2.0).
> Alguns módulos possuem versão própria (ex.: Calendário em 0.3.0) —
> a versão do plugin reflete o pacote como um todo, não cada módulo.

Veja `docs/ARCHITECTURE.md` para o detalhamento completo de cada decisão,
`docs/STATUS.md` para o que está funcional de verdade (e o que não está),
`docs/MANUAL-VALIDATION.md` para o checklist de validação num vault real e
`CHANGELOG.md` para o histórico de versões.

## Privacidade

Este plugin não envia nenhum dado para fora do seu computador, exceto:
checagem de novas versões (API pública do GitHub) e, se você habilitar e
usar o módulo MCP, o que um cliente MCP que você mesmo autorizou ler/
escrever no seu vault. Não há telemetria.

## Licença

MIT — veja `LICENSE`.
