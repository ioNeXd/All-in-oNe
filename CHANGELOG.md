# Changelog

Todas as mudanças notáveis deste plugin são documentadas neste arquivo. O
formato segue [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e
o versionamento segue [SemVer](https://semver.org/lang/pt-BR/), conforme
`docs/ARCHITECTURE.md`.

> **Nota sobre esta entrada.** A v0.1.0 é o **ponto de partida oficial** do
> projeto: a linha de base abaixo descreve o plugin como ele existe hoje,
> após um ciclo intenso de desenvolvimento interno em que o código foi
> auditado por completo (todas as rodadas de correção foram colapsadas
> nesta entrada — o histórico detalhado delas não é mantido). A partir da
>qui, cada release nova acrescenta a própria seção acima desta, com
> `Adicionado` / `Corrigido` / `Alterado` / `Removido`, e o SemVer passa a
> valer formalmente: quebra de contrato de módulo = major, feature nova =
> minor, correção = patch.

## [0.1.0] — 2026-09-17

Primeira versão pública da linha de base.

### Visão geral

Um hub único dentro do Obsidian que reúne **8 módulos independentes**
(servidor MCP embutido, ciclo de vida de arquivos, editor de estilos,
templates automáticos por pasta, calendário integrado, notificações,
histórico persistente e auto-update via GitHub), todos conectados por um
núcleo comum de eventos e configuráveis pelo **Lobby** — o painel central
do plugin. Nenhum módulo conhece outro diretamente; toda comunicação passa
pelo núcleo.

### Adicionado

**Núcleo**

- Contrato de módulo (`ModuleContract.ts`) com `onRegister` separado de
  `onEnable`: qualquer módulo é configurável mesmo desligado (inclusive em
  modo seguro) — a porta do MCP pode ser trocada com o módulo desligado,
  por exemplo. O contrato inclui `onSettingsChange` (dispara em toda
  gravação de configuração não bloqueada pela validação), `onResetData`
  (reset de dados alcança também módulos desligados), `getHealthStatus`
  (aba de Diagnóstico) e `renderSettingsPanel` (painel próprio por módulo
  no Lobby). `settingsSchema` é metadado declarativo opcional.
- Event bus com isolamento de falha (uma exceção num handler não derruba
  os outros), throttle por evento e histórico consolidado (`EventBus.ts`).
- Fila de escrita por caminho de arquivo (`FileWriteQueue.ts`): toda
  escrita no MESMO arquivo roda em sequência — é o que resolve a corrida
  entre o módulo de Templates movendo uma nota e uma chamada MCP editando
  o mesmo arquivo.
- Ponte de eventos do vault (`VaultEventBridge.ts`): centraliza os
  listeners do Obsidian e emite `file:created/deleted/modified/renamed` e
  `folder:created/deleted`, com dedupe (o rename interno de "Untitled" não
  emite evento próprio), filtro de notas do Ciclo de Vida (quem emite é o
  módulo, depois do nome definitivo) e guard contra listeners órfãos
  (descarregar o plugin antes do layout ficar pronto não vaza listener).
- Configuração com migração de schema, **validação centralizada de
  conflito de caminhos** (fronteira por segmento — "Secretas2" não colide
  com "Secretas"), retorno de issues de validação ao chamador, detecção de
  conflito de sync (`SettingsManager.ts`).
- Modo seguro: falhas consecutivas de `onEnable` num módulo desligam o
  módulo ofensor automaticamente e emitem `core:safe-mode-entered` — um
  bug num módulo não impede o Obsidian de abrir.
- Reset em 3 níveis de verdade (modal "Restaurar tudo"): `config` = só a
  configuração volta ao padrão (dados intactos, runtime reconciliado com
  o disco); `data` = só dados gerados são limpos, via `onResetData`;
  `all` = ambos.
- Helpers compartilhados: `PathUtils.ts` (regras puras de caminho) e
  `VaultPaths.ts` (operações de vault: criação recursiva de pastas,
  nome único sem colisão).
- Ofuscação de campos sensíveis no disco (`secureStore.ts`).
- Onboarding de primeira execução com validação honesta: conflito de
  caminhos ou falha de disco mantém o modal aberto com o erro visível.
- Infraestrutura de testes contra **código real**: stub do pacote
  `obsidian` via alias no `vitest.config.ts` (só em runtime de teste) —
  as suítes importam as implementações de verdade, não cópias espelhadas.
  103 testes em 14 arquivos, incluindo o núcleo (`HubCore`): reset em 3
  níveis, reconciliação de módulos habilitados, ciclo de vida com isolamento
  de falha e modo seguro, e a ponte de comandos nativos (`CommandBridge`).

**Módulos**

- **Servidor MCP** (`modules/mcp/`): servidor Streamable HTTP real
  (Node `http`), autenticação por token, rate limiting, modo dry-run,
  permissões de escrita por pasta com fronteira por segmento cobrindo
  todos os destinos (incluindo `newPath` de renames), todas as escritas
  passando pela fila do núcleo, split/combine de notas, liberação
  temporária de escrita por tempo com revogação, catch global no servidor,
  limite de 10 MB no streaming do corpo (413 real), restart coalescido
  (restarts paralelos esperam o mesmo em voo; desligar durante um restart
  não reabre o servidor), diagnóstico mostrando a porta **em escuta** e
  restart automático quando a porta configurada muda.
- **Ciclo de vida de arquivos** (`modules/filelifecycle/`): pergunta o
  nome ao criar qualquer nota antes dos outros módulos reagirem; emite
  `lifecycle:note-ready`; confirmação opcional (desligada por padrão)
  para renomear/mover/excluir via itens próprios no menu de contexto;
  comandos nativos só executáveis com o módulo ligado.
- **Estilos** (`modules/styles/`): injeção de CSS em tempo real, 7 temas
  prontos gerados por `buildTheme()` (~45 variáveis derivadas), painel
  visual com ~40 variáveis editáveis, preview de tema antes de aplicar,
  undo, export/import de tema, detecção de conflito com temas externos,
  re-aplicação reativa a mudanças de configuração e reset.
- **Templates por pasta** (`modules/templates/`): regras por pasta com
  herança e derivação automática de `thema`, template aplicado sem quebrar
  o frontmatter, `status` como lista clicável `["Pendente","Completo"]`,
  movimentação para pasta Pendente e retorno automático ao completar
  (regra centralizada em `NoteStatus.ts`, com proteção anti-loop e leitura
  via `metadataCache` — sem corrida com o cache do Obsidian).
- **Calendário** (`modules/calendar/`): grade clicável com navegação entre
  meses (‹ › e "Hoje"), indicadores por dia (nota existente, pendente,
  evento) com tooltip, visões de semana e agenda, modal de escolha de
  template, eventos recorrentes com lembrete (timer de 10s, nota aberta
  em segundo plano, janela espontânea desligada por padrão), vínculo de
  nota por metadado (renomear não quebra), seletor filtrável de notas/
  pastas.
- **Notificações** (`modules/notifications/`): pop-up com som por tipo de
  evento (11 gatilhos documentados no manifest do módulo), regras ligadas
  de fábrica para eventos globais, modo não-perturbe por horário,
  histórico persistente com "marcar tudo como lido" e limpeza.
- **Histórico** (`modules/history/`): módulo independente (não vive no
  núcleo), persistente entre sessões, filtro com autocomplete de
  sintaxe/labels em português, limite configurável.
- **Auto-update** (`modules/autoupdate/`): checagem manual e automática
  com throttle, canal estável/beta, comparação SemVer real (pré-lançamento
  é mais antigo que o release de mesmo número base), download de TODOS os
  assets antes de escrever qualquer um, checksum SHA-256 quando o release
  declara, backup automático antes de sobrescrever, rollback com tratamento
  de falha, "Ignorar" persiste a versão dispensada, e mensagens de erro
  honestas (falha de IO no meio da escrita aponta o backup, não promete
  integridade).

**Lobby e UI**

- Aba interna (`LobbyView`) ou janela (`LobbyModal`), com modal real de
  "perguntar toda vez" e opção de lembrar escolha; linhas inteiramente
  clicáveis; busca por nome; toggles por módulo com aviso claro quando a
  ativação falha (Notice com o motivo).
- Painel de configurações funcional para **cada** módulo, usável mesmo
  com o módulo desligado.
- Abas de Diagnóstico (saúde por módulo), Histórico (filtro) e Ajuda.
- Ações rápidas funcionais (emitem eventos de workspace que os módulos
  escutam de verdade).
- Comandos nativos registrados UMA vez por módulo (religar não duplica) e
  só executáveis com o módulo ligado (`checkCallback`) — desligar o módulo
  desabilita o comando na Paleta em vez de deixá-lo operar fora do ciclo
  de vida. A lógica vive em `CommandBridge.ts`, no núcleo, com suíte
  própria; o `main.ts` fica só com a fiação.
- CI com workflow de release (`release.yml`), templates de issue/PR.

### Corrigido

Correções incorporadas durante o desenvolvimento interno anterior à linha
de base (as principais, para registro):

- Pendência invisível: o indicador de pendente comparava `status` com uma
  string, mas o formato real é a lista `["Pendente","Completo"]` — a regra
  vivia errada em 3 lugares antes de virar `NoteStatus.ts`.
- Fronteira de segurança do MCP: bloqueio de pasta por `startsWith` aceitava
  `Secretas2/...` como estando em `Secretas`.
- `TFile.path` é mutado no próprio objeto pelo Obsidian ao renomear —
  capturar o caminho ANTES de qualquer rename (a causa de travamentos de
  reprocessamento e de histórico duplicado).
- Escritas do MCP fora da fila do núcleo e `patch_note` corrompendo texto
  com `$&`/`$1` via `String.replace`.
- Auto-update comparando versões lexicograficamente (`"0.10.0" < "0.9.0"`).
- Porta padrão do MCP alterada para `27931` (a 27123 colidia com o plugin
  "Local REST API").
- `onboarding` criando pastas aninhadas (`Calendario/templates`) à prova de
  `vault.createFolder` não-recursivo.
- Template inserido acima do frontmatter, corrompendo os metadados.
- Notificações sem som (o `AudioContext` nasce suspenso até haver
  interação) e eventos globais que ninguém emitia antes da ponte existir.
- Falha de `onEnable` e bloqueio pelo modo seguro deixam o Set de módulos
  habilitados coerente com a realidade (antes, um módulo que falhava ao
  ativar permanecia como "ligado" em memória — o Lobby e o `checkCallback`
  dos comandos leriam estado falso).
- Caminhos de erro silenciosos em UI (onboarding, reset, rollback de
  update, "lembrar escolha") agora sempre avisam e mantêm o contexto aberto.
- `manifest.json` com `isDesktopOnly: true` (o MCP usa `http`/`Buffer` do
  Node) e CI rodando corretamente em push para `main`.

### Decisões de design documentadas

- **Repo de update fixo** (`ioNeXd/All-in-oNe`), nunca configurável —
  superfície de segurança.
- **Sem telemetria.** Nada sai da máquina exceto a checagem de releases
  (API pública do GitHub) e o tráfego MCP que você mesmo autorizar.
- **Transporte HTTP+SSE legado do MCP** não implementado de propósito
  (deprecated); só Streamable HTTP.
- **Id do plugin `All-in-oNe`** — a pasta de instalação é
  `.obsidian/plugins/All-in-oNe/`; mudar id de plugin sempre perde a
  instalação anterior (inerente ao Obsidian).
- **Strings inline em português** — a extração para i18n ficou de
  propósito para depois do primeiro release estável.

### Limitações conhecidas

- A varredura estática está exaurida (typecheck estrito, 103 testes, zero
  `as any`), mas o **runtime real no Obsidian** é o próximo passinho:
  validar Lobby, reset em 3 níveis, servidor MCP respondendo e calendário
  num vault de verdade.
- Intercepção do menu nativo de renomear/mover/excluir usa um campo interno
  do `Menu` (técnica comum na comunidade); pode parar de funcionar num
  update futuro do Obsidian — nesse caso os itens nativos apenas voltam a
  aparecer, nada quebra. Arrastar com o mouse não tem cobertura (a API não
  expõe evento para isso).
- Confirmação de ações nativas do Obsidian (clique-direito, arrastar) é
  limitação de plataforma: não existe gancho cancelável "antes de
  renomear".

[0.1.0]: https://github.com/ioNeXd/All-in-oNe/releases/tag/0.1.0
