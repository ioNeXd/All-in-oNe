# Arquitetura do All iₙ oNe

## Visão geral

```
src/
  core/                  ← núcleo: nunca conhece um módulo específico
    ModuleContract.ts    ← a interface que todo módulo implementa
    EventBus.ts          ← comunicação entre módulos
    HubCore.ts           ← orquestrador: ciclo de vida, modo seguro, reset, histórico
    SettingsManager.ts   ← persistência, migração, validação de conflitos
    FileWriteQueue.ts    ← serialização de escritas por caminho de arquivo
    VaultEventBridge.ts  ← ponte vault→bus (dedupe, guard de listeners órfãos)
    CommandBridge.ts     ← ponte módulos→Command Palette (registro único + checkCallback)
    PathUtils.ts         ← regras puras de caminho (testadas sem vault)
    VaultPaths.ts        ← operações de vault: pastas recursivas, nome único
    NoteStatus.ts        ← regra pura: pendente/completo (testada) — compartilhada
                           por templates/calendar/Lobby, sem acoplamento entre módulos
    secureStore.ts       ← ofuscação de campos sensíveis (ex.: token MCP)
    types.ts             ← formato de HubSettings

  modules/               ← cada pasta é um módulo independente
    mcp/                 ← servidor MCP (Streamable HTTP)
      WriteRules.ts      ← regra pura: permissões de pasta (testada)
      ToolsApiVersion.ts ← regra pura: negociação da versão da API (testada)
    filelifecycle/       ← ciclo de vida de arquivos (nome na criação, confirmações)
    styles/              ← editor de estilos e temas
      CssHighlight.ts    ← tokenizador puro do realce do editor (testado)
    autoupdate/          ← auto-update via GitHub Releases
      ReleaseUtils.ts    ← regra pura: SemVer/assets/checksums (testada)
      SignatureUtils.ts  ← regra pura: decisão/parse da verificação GPG (testada)
    templates/           ← templates por pasta + fluxo Pendente
    calendar/            ← calendário, eventos recorrentes e lembretes
      IcsParser.ts       ← parser puro de iCalendar (testado)
    notifications/       ← pop-ups com som e não-perturbe
      NotificationList.ts← regras puras: filtro e agrupamento por dia (testadas)
    history/             ← histórico persistente com filtro e busca
      HistoryFilter.ts   ← regra pura: filtro combinado tipo + texto (testada)

  ui/
    LobbyRenderer.ts     ← toda a UI do Lobby (cascas finas: LobbyView/LobbyModal)
    OnboardingModal.ts   ← assistente de primeira execução
    ResetModal.ts        ← modal "Restaurar tudo" (3 níveis)
    OpenModeModal.ts     ← aba/janela/perguntar sempre
    ThemePreviewModal.ts ← preview de tema do Estilos
    FilterSuggest.ts     ← campo de texto com sugestão filtrada (reutilizável)
    interactiveRows.ts   ← linha clicável acessível (teclado/ARIA) reutilizável
    lobbyOrder.ts        ← regras puras da ordem de módulos no Lobby (testadas)

  main.ts                ← cola com a API real do Obsidian (Plugin)

tests/                   ← 23 suítes, 258 testes — todos importam código real
  mocks/obsidian.ts      ← stub do pacote "obsidian" (types-only), via alias no vitest
```

## Por que um "contrato de módulo"

O requisito original era: o plugin deve poder crescer com módulos novos no
futuro, sem reescrever o que já existe. A resposta técnica para isso é
inversão de dependência: em vez do núcleo conhecer os módulos, os módulos
conhecem o núcleo (via `ModuleContext`, injetado em `onRegister` — ver
"Por que onRegister é separado de onEnable" abaixo), e o núcleo só conhece
a **interface** `HubModule`.

Isso significa que `HubCore.ts` nunca precisa de um `if (moduleId === "mcp")`
em lugar nenhum. Ele itera sobre uma lista de `HubModule[]` e chama os
mesmos métodos (`onRegister`, `onEnable`, `onDisable`, `getHealthStatus`,
`onSettingsChange`, `onResetData`) em todos, sem saber o que cada um faz
por dentro.

O contrato na linha de base v0.1.0:

- `onRegister(context)` — roda sempre, no registro; guarda o context.
- `onEnable()` / `onDisable()` — ativação e desativação de fato (coisas
  "vivas": portas, listeners, timers).
- `onSettingsChange()` — dispara após **toda** gravação de configuração
  não bloqueada pela validação (o Estilos re-aplica o CSS aqui; o MCP
  reinicia sozinho quando a porta configurada deixa de ser a em escuta).
- `onResetData()` — limpa dados gerados; roda para **todos** os módulos
  registrados, inclusive desligados (dado de módulo desligado não
  sobrevive ao reset). A fronteira dado × configuração é decisão de
  cada módulo: Histórico/Notificações limpam as listas e mantêm
  preferências (máximo, filtro); o Calendário remove só os eventos
  IMPORTADOS de .ics (ids `ics:<uid>`) e preserva os criados à mão
  (`evt-*`) — refazer é um clique, reimportar o arquivo; o Auto-update
  não expõe dado gerado a reset (a versão dispensada é preferência).
- `getHealthStatus()` — alimenta a aba de Diagnóstico (o MCP reporta a
  porta **em escuta**, não a configurada).
- `renderSettingsPanel()` — painel próprio no Lobby, usável mesmo com o
  módulo desligado.
- `updateModuleSettings()` retorna `ConfigValidationIssue[]` — vazio =
  gravado; o chamador decide o que fazer (o Onboarding mostra os erros e
  mantém o modal aberto, por exemplo).
- `settingsSchema` — metadado declarativo **opcional**; nada o lê (a UI
  real são os painéis manuais).

## Por que `onRegister` é separado de `onEnable`

Na primeira versão do contrato, só existia `onEnable(context)` — o módulo só
recebia acesso às configurações quando era efetivamente ligado. Isso criava
uma armadilha real: para mudar a porta do servidor MCP (por exemplo, por
conflito com outra ferramenta usando a mesma porta), era preciso primeiro
ligar o módulo — mas ligá-lo era exatamente o que falhava por causa da
porta errada. Sem conseguir configurar um módulo desligado, não havia saída
pela interface.

A solução: `onRegister(context)` roda **sempre**, assim que o módulo é
registrado no núcleo — independentemente de estar ligado ou desligado — e
serve só para o módulo guardar o `context` (usado por
`getSettings`/`updateSettings`/`renderSettingsPanel`). `onEnable()` (sem
parâmetro — o módulo já tem o `context` salvo) roda só quando o módulo é
de fato ativado, e é onde entra qualquer coisa "viva" (abrir uma porta,
registrar listeners do vault, criar timers). Isso é o que permite editar a
configuração de um módulo mesmo com ele desligado ou em modo seguro.

## Por que um Event Bus em vez de imports diretos entre módulos

Se `NotificationsModule` importasse `CalendarModule` diretamente para saber
quando um evento de calendário dispara, isso criaria uma dependência
explícita: `CalendarModule` não poderia mudar sua API interna sem checar se
quebra `NotificationsModule`, e adicionar um módulo novo que também precisa
saber de eventos de calendário significaria editar `CalendarModule` de novo
a cada novo interessado.

Com o Event Bus, `CalendarModule` só faz `bus.emit("calendar:event-fired",
...)` e não sabe (nem precisa saber) quem está ouvindo. Isso é o que permite
que o `NotificationsModule` reaja a eventos de módulos que talvez nem
existissem quando `NotificationsModule` foi escrito.

Cada módulo declara no seu manifest o que emite (`emits`) e o que escuta
(`listensTo`) — a Central de Eventos do Lobby documenta as conexões a
partir disso.

## Por que uma fila de escrita por arquivo (`FileWriteQueue`)

O vault do Obsidian é assíncrono. Dois módulos diferentes podem, em teoria,
mexer no mesmo arquivo dentro da mesma janela de tempo (ex.: o módulo de
Templates movendo uma nota para `Pendente` no exato momento em que uma
chamada MCP está editando essa nota a pedido de um cliente externo). Sem
serialização, a escrita que "chegar por último" no event loop pode
sobrescrever a outra silenciosamente.

`FileWriteQueue.run(path, operation)` garante que toda operação de escrita
para o MESMO `path` rode em sequência — nunca em paralelo — sem bloquear
operações em arquivos diferentes. Na linha de base, **todas** as escritas
de módulos e do MCP passam por ela.

## Por que uma ponte de eventos do vault (`VaultEventBridge`)

Eventos como `file:created` e `folder:deleted` precisam chegar ao bus para
Notificações e Histórico — mas quem emite `file:created` de uma nota deve
ser o módulo de Ciclo de Vida (só depois do nome definitivo, para o
Histórico não registrar "Untitled"). A ponte centraliza os listeners do
vault e resolve três sutilezas:

- **Dedupe**: o rename interno de "Untitled.md" → nome escolhido não emite
  evento próprio (a criação final já cobre).
- **Filtro**: notas em processo de nomeação pelo Ciclo de Vida são
  suprimidas na ponte (o módulo as emite na hora certa).
- **Guard de ciclo de vida**: todo o registro acontece dentro de
  `onLayoutReady`; se o plugin for descarregado antes do layout ficar
  pronto, o callback tardio não registra listener algum (sem órfãos).

## Por que helpers de caminho no núcleo (`PathUtils` / `VaultPaths`)

`uniquePath` e `ensureFolder` estavam copiados em 4 módulos **com drift**
(uma versão filtrava segmentos vazios, as outras não). Regras puras foram
para `PathUtils.ts` (testáveis sem vault) e as operações de vault para
`VaultPaths.ts`, com o comportamento defensivo unificado — incluindo
criação recursiva de pastas (o `vault.createFolder` do Obsidian NÃO cria
pastas-pai) e nome único com extensão preservada.

O mesmo princípio gerou módulos puras ao lado dos módulos de vault:
`NoteStatus.ts` (pendente/completo), `WriteRules.ts` (permissões de pasta
do MCP) e `ReleaseUtils.ts` (SemVer). Na v0.2.0 o padrão virou a norma:
`ToolsApiVersion`, `SignatureUtils`, `IcsParser`, `NotificationList`,
`HistoryFilter`, `CssHighlight` e `lobbyOrder` — toda regra de decisão
nova nasce num arquivo puro com suíte própria. Regra de negócio sem I/O =
testável sem mock.

## Por que "modo seguro" (safe mode)

Com 8 módulos rodando dentro do mesmo processo do Obsidian, um bug em um
módulo (ex.: uma exceção não tratada no `onEnable` do módulo de Calendário)
não deveria conseguir impedir o Obsidian inteiro de abrir. `HubCore` conta
falhas consecutivas de `onEnable` por módulo; ao atingir o limite
(`CRASH_LIMIT_BEFORE_SAFE_MODE`), o módulo ofensor é desligado
automaticamente e um evento `core:safe-mode-entered` é emitido — os demais
módulos continuam funcionando normalmente.

## Por que validação de conflito de caminhos no núcleo, não em cada módulo

Como todos os caminhos são configuráveis pelo usuário (decisão de design),
existe risco real de dois módulos apontarem, sem querer, para a mesma pasta
(ex.: pasta de templates do calendário = pasta de Pendente do módulo de
Templates). Centralizar essa checagem em `SettingsManager.validate()`
garante que ela rode toda vez que QUALQUER configuração for salva, de
qualquer módulo, sem cada módulo precisar reimplementar essa lógica. A
fronteira é por **segmento** ("Secretas2" não casa com um bloqueio de
"Secretas") e as issues voltam ao chamador (`ConfigValidationIssue[]`) —
cabe à UI mostrá-las ou ao módulo reagir.

## Por que os comandos nativos passam por uma ponte com `checkCallback`

A API do Obsidian não tem `removeCommand`: um comando registrado vive
enquanto o plugin viver. Como os módulos registram comandos no
`onEnable` (ex.: "MCP: Reiniciar servidor"), desligar o módulo deixaria o
comando funcional na Paleta — um caminho fora do ciclo de vida. A ponte
(`CommandBridge.ts`, fiada ao plugin pelo `main.ts`) resolve dois problemas:

- **`checkCallback`**: o comando só é executável com o módulo ligado
  (desabilitado na Paleta quando desligado — o comportamento que o
  usuário espera).
- **Registro único**: religar um módulo não re-executa `addCommand` e o
  callback executado é sempre o mais recente (o closure vivo, não o da
  primeira ativação).

## Testes contra código real

O pacote `obsidian` é **types-only** (sem entry executável — só existe
dentro do app). Um alias no `vitest.config.ts` aponta `obsidian` para um
stub mínimo (`tests/mocks/obsidian.ts`) **apenas em runtime de teste**;
o `tsc` continua nos tipos oficiais e a build não muda. Com isso, as 23
suítes (258 testes) importam as implementações de verdade — regras como
`NoteStatus`, `WriteRules`, `pathMatchesFolder` e `validateMcpDraft` são
testadas contra o código real, e mudanças de comportamento quebram o
teste na hora, em vez de divergir em silêncio de uma cópia espelhada.

## Versionamento

O projeto segue SemVer a partir da v0.1.0. Dois versionamentos coexistem,
de propósito:

- **Versão do plugin** (`manifest.json`) — a versão que aparece para o
  usuário final e que o Auto-update compara (com SemVer real: pré-
  lançamento é mais antigo que o release de mesmo número base).
- **`contractVersion`** (dentro de `ModuleManifest`) — a versão do contrato
  (`ModuleContract.ts`) contra a qual aquele módulo específico foi escrito.
  Um breaking change no contrato (ex.: mudar a assinatura de `onEnable`)
  exige incrementar a major version do contrato — módulos antigos não
  atualizados para o contrato novo devem, na pior das hipóteses, logar um
  aviso (`HubCore.enableModule` já faz essa checagem), não quebrar
  silenciosamente.

## Por que a verificação GPG do auto-update falha fechada

O checksum SHA-256 confere integridade do download; a assinatura GPG
confere **origem**. Como a verificação é opt-in (`verifySignature` nas
settings do Auto-update), ela cria uma obrigação assim que é ligada:
release sem asset `.sig`/`.asc`, `gpg` indisponível na máquina ou chave
pública não configurada **abortam** a instalação com Notice — "não
consegui verificar" nunca pode virar "verificado". O parse decide por
linhas de status `[GNUPG:]` do gpg (a saída humana varia por locale),
num **keyring temporário isolado** (`GNUPGHOME` efêmero) — o keyring do
usuário nunca é tocado. A verificação roda junto do download, ANTES de
escrever qualquer arquivo (mesma filosofia do checksum: falha no meio
do caminho não deixa instalação pela metade). A regra de decisão é
pura (`SignatureUtils.ts`); quem assina os assets em produção é o
`release.yml` — com os secrets ausentes, o passo de assinatura é pulado
e o release sai só com checksums (o recurso opt-in continua honesto:
aborta, não finge que verificou).

## Por que o parser de .ics é conservador

`IcsParser.ts` (puro, sem I/O) prefere **sub-representar a importar mal**:
`FREQ=YEARLY` mapeia para a recorrência anual do modelo de eventos;
frequências que o modelo não representa (MONTHLY, WEEKLY, DAILY…)
chegam como evento ÚNICO com aviso explícito — aproximar em silêncio
mentiria sobre quando o lembrete dispara. VEVENT sem DTSTART é
descartado com warning; arquivo truncado conta o evento aberto em vez
de derrubar o resto; texto que nem é iCalendar lança erro com mensagem
clara (a UI mantém o painel e mostra o Notice). A desdobra de linhas
segue a semântica literal da RFC 5545 (o espaço do marcador fica no
FIM da linha física anterior). A mescla é por UID determinístico
(`ics:<uid>`): reimportar o mesmo arquivo substitui os eventos
anteriores em vez de duplicar, e eventos criados à mão ficam intactos.

## Por que o realce do editor de CSS é overlay (e não CodeMirror)

CodeMirror com modo CSS real exigiria dependência nova
(`@codemirror/lang-css`) e a substituição do textarea por um editor
distinto — reescrevendo por cima o autocomplete, o undo e a integração
com preview/export já existentes. Ficou na técnica clássica de overlay:
um `<pre>` colorizado posicionado ATRÁS do `<textarea>`, cujo texto
vira transparente (caret e seleção visíveis). O textarea permanece a
fonte do valor, então autocomplete Ctrl+Espaço, inserção pela
referência, undo, preview e export/import ficam intactos por
construção. O tokenizador (`CssHighlight.ts`, puro, sem DOM) tem um
invariante testado: a concatenação dos tokens reproduz o texto byte a
byte — se um caractere se movesse, o overlay desalinha do caret.
Rende via `textContent`, nunca `innerHTML` com conteúdo do usuário.

## O que fica de fora, deliberadamente

- **Segredo forte para o token do MCP** (`secureStore.ts`) — o que existe
  lá é OFUSCAÇÃO (XOR com chave fixa + base64), documentada como tal no
  código, não criptografia. O ambiente de um plugin (sandbox do Electron
  renderer, sem acesso a keychain do SO por API estável) não oferece cofre
  seguro multiplataforma; o objetivo é só o token não ficar em texto plano
  no `data.json` (sync acidental, print, relatório de bug). Quem tem acesso
  de leitura ao vault OU ao código do plugin consegue reverter. A
  consequência de segurança real: o token MCP protege um servidor que só
  escuta em `127.0.0.1` e cujas permissões de escrita são configuradas no
  próprio vault (blocklist/allowlist/somente-leitura) — o modelo de ameaça
  é processo local, não rede. Segredo de verdade exigiria segredo vindo de
  fora do plugin (keychain via código nativo do Electron), troca que não
  cabe neste projeto.
- **Modo "Obsidian fechado"** (acesso cru a arquivos `.md` sem o app aberto)
  não é responsabilidade deste plugin — é responsabilidade de um adaptador
  dentro do projeto separado de gateway MCP do usuário, que pode ler os
  mesmos arquivos diretamente do disco.
- **Suporte ao transporte HTTP+SSE legado do MCP** não foi implementado de
  propósito — está deprecated; o servidor usa Streamable HTTP.
- **Repo de update fixo** (`ioNeXd/All-in-oNe`), nunca configurável —
  superfície de segurança: o auto-update só escreve código vindo do
  repositório do próprio plugin, e o caminho de instalação
  (`plugins/All-in-oNe/`) está amarrado por documentação ao `id` do
  manifest (os dois precisam mudar juntos).
