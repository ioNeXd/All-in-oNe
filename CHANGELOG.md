# Changelog

Todas as mudanças notáveis deste plugin são documentadas neste arquivo. O
formato segue [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e
o versionamento segue [SemVer](https://semver.org/lang/pt-BR/), conforme
`docs/ARCHITECTURE.md`.

## [Não lançado]

## [0.2.0] — 2026-09-22

### Adicionado

**Lobby**

- Navegação por teclado em todos os controles: linhas da Central de
  Eventos (copiam o evento como JSON), dias do calendário, visões de
  semana/agenda, notas pendentes e referência de CSS agora têm tabIndex,
  role/aria-label e Enter/Espaço; abas internas movem o foco com ←/→
  (modo manual ARIA) e ativam com Enter/Espaço; foco visível padronizado
  (`ione-hub-focusable`)
- Reordenação dos módulos na barra lateral: arrastar pela alça ⠿ ou
  Alt+↑/Alt+↓ com a alça focada; ordem persistida em
  `settings.lobby.moduleOrder` (campo novo opcional, sem migração de
  schema), tolerante a módulos novos/removidos — regras puras em
  `lobbyOrder.ts`, com suíte própria. Reordenar não muda quais módulos
  estão ligados

**Módulo Histórico**

- Consumidor real do log dedicado do MCP: o Histórico escuta
  `mcp:action-logged` (TRACKED_EVENTS e listensTo do manifest) e registra
  cada ação executada com o DESFECHO — "— ok", "— simulado (dry-run)" ou
  "— FALHOU: <motivo>" — fechando o circuito emitir→consumir (antes, o
  evento era emitido e ninguém ouvia)
- Busca por texto livre no registro de atividade: substring em message e
  path, case-insensitive e sem acento ("reuniao" encontra "Reunião"),
  combinável com o filtro por tipo de evento (E lógico). Regra pura em
  `HistoryFilter.ts` (filtro + normalização, testada contra o código
  real). A lista re-renderiza com debounce sem recarregar o painel — o
  foco não salta do campo no meio da digitação — e o estado vazio agora
  distingue "nada registrado" de "nenhuma entrada corresponde aos filtros"

**Módulo Notificações**

- Filtro por tipo de gatilho na central de notificações: dropdown com
  contagem por tipo; gatilhos sem ocorrências não poluem a lista de
  opções, mas o filtro PERSISTIDO entra mesmo com zero (a preferência
  salva não some do controle); gatilho removido degrada para "Todas" em
  vez de devolver lista vazia sem explicação
- Agrupamento da central por dia (Hoje / Ontem / data por extenso em
  pt-BR), com toggle para voltar à lista cronológica; regras puras em
  `NotificationList.ts` (filtro, contagem, agrupamento com `now`
  injetável — determinístico em teste) e preferências `viewFilter` /
  `groupByDay` persistidas na fatia do módulo (default novo, sem
  migração de schema)

**Módulo Estilos**

- Realce de sintaxe no editor livre de CSS: overlay colorido atrás do
  textarea (texto do input transparente, caret e seleção visíveis), com
  tokenizador puro em `CssHighlight.ts` — propriedade testada de round-trip
  EXATO (a concatenação dos tokens reproduz o texto byte a byte, senão o
  overlay desalinha do caret), incluindo strings com `{ : ; }`, comentários
  multi-linha e não fechados, tabs e unicode. Contexto léxico: fora de
  chaves `palavra:` é seletor (`a:hover`), dentro é propriedade
  (`color: red`); parênteses de `@media()`/`@supports()` contam como
  contexto de valor. Sem dependência nova (o `@codemirror/lang-css` não
  está disponível no bundle do Obsidian); autocomplete Ctrl+Espaço,
  inserção pela referência, undo, preview, export/import e o Painel visual
  seguem intactos; o realce pode ser ligado/desligado no próprio editor

**Módulo Calendário**

- Importação de arquivos `.ics` (iCalendar, RFC 5545): parser puro em
  `IcsParser.ts` (sem I/O de vault, com suíte própria) converte VEVENT →
  `CalendarEvent` — SUMMARY/DESCRIPTION (com desdobramento de linhas longas
  e escapes), DTSTART em data, data-hora local, UTC (Z) e com TZID;
  RRULE `FREQ=YEARLY` mapeia para a recorrência anual do modelo;
  frequências não representáveis (MONTHLY, WEEKLY, DAILY…) viram evento
  único com aviso explícito, em vez de aproximação silenciosa
- Botão "Importar .ics" na aba de Eventos: falha de leitura/validação
  mantém o painel aberto com Notice do motivo; eventos importados entram
  na fatia de settings via `updateSettings`, mesclados por UID — importar
  o mesmo arquivo de novo substitui os eventos anteriores (dedupe por id
  determinístico `ics:<uid>`) e eventos criados à mão ficam intactos
- Reset de dados do Calendário (`onResetData`): "Restaurar tudo → Data"
  remove os eventos IMPORTADOS de .ics (dado derivado de um arquivo —
  refazer é um clique) e preserva os criados à mão (configuração do
  usuário), com a fronteira decidida pelo prefixo do id (`ics:` × `evt-`)
- Diagnóstico: o resumo de saúde do Calendário reflete a ÚLTIMA
  importação de .ics — arquivo malformado deixa o módulo "não-saudável"
  até a próxima importação bem-sucedida, em vez de sempre "ok"

**Módulo Auto-update**

- Verificação de assinatura GPG dos assets (opt-in, desligada de fábrica):
  quando o release publica `.sig`/`.asc`, a assinatura é verificada com o
  binário `gpg` do sistema contra a chave pública configurada pelo usuário
  (colada no painel, armazenada apenas no vault local), num keyring
  TEMPORÁRIO isolado — o keyring do usuário nunca é tocado. Falha fechada:
  com a verificação ligada, release sem assinatura ou gpg indisponível
  ABORTA a instalação com Notice honesto (mesma filosofia do checksum
  SHA-256). Regras de decisão/parse em `SignatureUtils.ts` (puro, testado):
  só linhas de status `[GNUPG:]` decidem (saída humana varia por locale);
  `NO_PUBKEY` é falha, não sucesso; `GOODSIG`+`BADSIG` juntos = inválida
- Diagnóstico reflete o estado da ÚLTIMA verificação de assinatura
  (verificada / reprovada / sem chave configurada) em vez de sempre "ok"
- `validateSettings` bloqueia na gravação uma chave pública que não
  parece armadura OpenPGP (erro de colagem vira issue de validação, não
  falha silenciosa na hora de instalar)
- Interoperabilidade formal com o BRAT: o módulo detecta se o
  TfTHacker/obsidian42-brat gerencia este plugin (lê `pluginList` do
  data.json do BRAT) e, em caso positivo, CEdE o controle de atualização —
  sem checagem automática, sem comando nativo e com aviso no painel e no
  Diagnóstico. Instalar via BRAT deixa de competir (e correr) com o
  auto-update próprio

**Módulo MCP**

- `put_attachment`: cria ou sobrescreve anexos binários (conteúdo em
  base64 com validação estrita — base64 truncado/inválido falha ANTES de
  tocar o vault, em vez de virar binário corrompido); cria pastas-pai que
  não existem; toda escrita pela fila do núcleo, respeitando readOnly,
  dry-run e as permissões por pasta (`WriteRules`)
- `delete_attachment`: move o anexo para a lixeira (nunca exclusão
  direta) e recusa caminhos `.md` apontando para `delete_note`
- `get_server_info`: versão do plugin, versão da API de ferramentas e
  contagens do vault
- Log de atividade dedicado do MCP: cada ação executada emite
  `mcp:action-logged` no bus (`{ tool, path, dryRun, isWrite, result }`) —
  falhas também entram no log, com `error` em vez de `result`. Sem
  acoplamento com o módulo Histórico: apenas emissão declarada no manifest
- Negociação formal da versão da API de ferramentas: o campo
  `toolsApiVersion` (antes inerte) agora é exposto no `initialize` e
  negociado — cliente pedindo major maior que o suportado é rejeitado no
  handshake com erro claro e código `TOOLS_API_INCOMPATIBLE`; major menor
  ou igual é aceito (minor/patch além do suportado são tolerados — falha
  por ferramenta, nunca no handshake). Regra pura em
  `mcp/ToolsApiVersion.ts`, com suíte própria
- Ferramentas novas declaradas no `tools/list`: `put_attachment`,
  `delete_attachment`, `get_server_info`

### Decisões de design documentadas

- **Assinatura GPG opt-in, com chave pública fornecida pelo usuário**
  (colada no painel, guardada apenas no vault local) — decidido assim
  porque o projeto ainda não tem chave de assinatura própria. Quando os
  releases passarem a sair assinados estavelmente pelo workflow, a chave
  pública do projeto deve ser EMBUTIDA no plugin (decisão de superfície
  de segurança, na mesma linha do "repo de update fixo") e o campo
  configurável vira ponte/exceção. Já é parte da decisão: verificação
  ligada cria a obrigação — falha fechada, nunca "verificar" de mentira

### Corrigido

- Classe `.ione-hub-notification-list__day` (cabeçalho dos grupos de dia
  do agrupamento da central de Notificações) agora estilizada no
  `styles.css` — era usada pelo painel mas não tinha estilo, e o
  `styles.css` é um dos três assets do release
- `dataview_query`: erro de pré-requisito agora aponta o caminho
  (instalar/habilitar o plugin Dataview) e declara que é dependência
  externa, em vez de um "não" seco
- `docs/STATUS.md` atualizado para refletir o código real: a seção do
  módulo Templates por pasta descrevia como "não implementado" recursos
  que já existem (edição de regra pelo painel, UI consumindo as sugestões
  por similaridade, seletor de regra pai para herança) e citava uma
  validação de `allowedValues` que nunca existiu; a seção do módulo MCP
  agora distingue o que falta de anexos (upload/edição) do que já existe
  (leitura/listagem via `list_attachments` e `get_attachment`).

> **Nota sobre esta entrada.** A v0.1.0 é o **ponto de partida oficial** do
> projeto: a linha de base abaixo descreve o plugin como ele existe hoje,
> após um ciclo intenso de desenvolvimento interno em que o código foi
> auditado por completo (todas as rodadas de correção foram colapsadas
> nesta entrada — o histórico detalhado delas não é mantido). A partir da
>qui, cada release nova acrescenta a própria seção acima desta, com
> `Adicionado` / `Corrigido` / `Alterado` / `Removido`, e o SemVer passa a
> valer formalmente: quebra de contrato de módulo = major, feature nova =
> minor, correção = patch.

## [0.1.1] — 2026-09-17

Correções da primeira revisão externa pós-baseline — lista de 22 itens,
todos verificados contra o código: **15 implementados** (abaixo) e 7
refutados por descreverem estado anterior a correções já aplicadas
(itens 12, 14, 16, 17, 18, 20 e 22).

### Corrigido

**Servidor MCP**

- Handshake JSON-RPC: `initialize` responde `protocolVersion` (ecoa a
  versão pedida pelo cliente; default `2025-06-18`), `capabilities`
  e `serverInfo`; notificações (sem `id`) recebem `202 Accepted` sem
  corpo — clientes reais (Claude Desktop, Cursor) morriam no primeiro
  passo, antes de qualquer listagem de ferramentas
- `stop()` fecha conexões keep-alive (`closeAllConnections`): desligar
  ou reiniciar o servidor não espera mais clientes pendentes; o
  diagnóstico mostra a porta REAL em escuta, lida de `server.address()`

**Configurações**

- Lost update de disco: gravações concorrentes disparavam persists fora
  de ordem — o persist lento do save antigo sobrescrevia o novo e a
  perda só aparecia ao reiniciar o Obsidian. A persistência agora é
  serializada numa fila de promises (validação síncrona fora da fila;
  falha de disco propaga ao chamador sem envenenar a fila)
- `SettingsManager.reset()` sem parâmetro: a assinatura aceitava
  `"config" | "all"` executando o mesmo código; a semântica real dos 3
  níveis de reset vive no `HubCore.resetAll`

**Núcleo de eventos**

- Throttle de `file:created` AGRUPA em vez de descartar: emissões
  dentro da janela saem no fim dela como `{ coalesced: [...] }` — uma
  rajada de 200 notas perdia 199 registros de Histórico/Notificações;
  agora perde zero. Histórico registra um por ocorrência; Notificações
  toca popup/som só no 1º da rajada
- Fonte única de verdade de "módulo ligado": novo
  `context.isModuleEnabled` (estado de RUNTIME, não config persistida);
  o fallback do Templates lia a config e calava quando o Ciclo de Vida
  falhava ao habilitar — templates paravam de aplicar em silêncio
- `context.log` emite `core:log` no bus (a promessa do contrato volta a
  valer); conflito de sync vira evento `core:sync-conflict`; falha de
  `onEnable`, `core:module-error`

**Histórico e Notificações**

- Write-behind (janela de 2s): N eventos = 1 escrita de disco em vez de
  N — o data.json inteiro era gravado a cada evento (dezenas de
  escritas/min em vault ativo), com flush no desligar e invalidação por
  geração para reset/limpeza não ressuscitarem entradas
- Histórico: leitura (painel, diagnóstico) inclui as pendentes na hora
  (dedupe por id) — sem esperar a janela de flush
- Histórico: ids com `cryptoRandomId` (mesmo gerador do núcleo,
  Notificações e MCP) — o padrão anterior colidia no mesmo milissegundo

**Memória e limpeza**

- `FileWriteQueue` remove a chave do Map quando a fila do caminho drena
  (guarda por dono-atual) — antes crescia a cada caminho tocado na
  sessão
- Removido código morto: buffer de histórico do HubCore (zero leitores
  em produção), `uniquePath` privado do Templates, campo
  `CalendarEvent.done` (nunca lido nem escrito)

### Alterado

- `ModuleContract`: união `ModuleId` completa com os 8 módulos reais;
  `isModuleEnabled` documentado como estado de runtime
- Comentários alinhados ao comportamento real (rotina do calendário:
  10s com dedupe por minuto; throttle ATRASA, não descarta)

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
- *(nota da v0.2.0)* A limitação "painéis simples, sem drag-and-drop e sem
  navegação 100% por teclado" citada nesta época foi resolvida nesta
  versão (reordenação por arrastar/Alt+setas e teclado em todos os
  controles) — mantida aqui apenas como registro histórico.
- Intercepção do menu nativo de renomear/mover/excluir usa um campo interno
  do `Menu` (técnica comum na comunidade); pode parar de funcionar num
  update futuro do Obsidian — nesse caso os itens nativos apenas voltam a
  aparecer, nada quebra. Arrastar com o mouse não tem cobertura (a API não
  expõe evento para isso).
- Confirmação de ações nativas do Obsidian (clique-direito, arrastar) é
  limitação de plataforma: não existe gancho cancelável "antes de
  renomear".

[0.2.0]: https://github.com/ioNeXd/All-in-oNe/releases/tag/0.2.0
[0.1.0]: https://github.com/ioNeXd/All-in-oNe/releases/tag/0.1.0
