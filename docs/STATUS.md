# Status de implementação — v0.2.0

Este documento existe para ser honesto sobre o que está **funcional de
verdade** neste projeto versus o que é **esqueleto pronto para expandir**.
A v0.1.0 é a linha de base (v0.1.1 corrige 15 achados da primeira revisão
externa; v0.2.0 fecha as 8 partes do plano pós-auditoria — anexos do MCP,
.ics no Calendário, assinatura GPG + BRAT no Auto-update, realce de CSS,
filtros de Notificações/Histórico, teclado/drag-and-drop no Lobby — ver
CHANGELOG): a arquitetura está completa e auditada, cada
módulo está funcional na sua função principal, e as lacunas restantes estão
listadas aqui sem rodeio.

> Estado da validação nesta linha de base: typecheck estrito ✅ ·
> **426 testes em 34 arquivos** (todos importando código real, não cópias
> espelhadas) ✅ · build de produção ✅. O que os testes não cobrem é o
> runtime de verdade no Obsidian — para isso, siga `docs/MANUAL-VALIDATION.md`.

## Versões por módulo

Cada módulo carrega uma `version` independente no seu manifest, além da
versão do plugin em `manifest.json`. A regra é a mesma SemVer do plugin:
feature nova no módulo = bump minor, correção = patch, quebra de
contrato = major. A tabela mapeia cada versão com o que a produziu; as
seções seguintes detalham cada módulo em seu estado atual.

| Módulo | v0.1.0 (baseline) | v0.1.1 (2026-09-17) | v0.2.0 (2026-09-22) |
|---|---|---|---|
| MCP | `0.1.0` — ferramentas base de leitura e escrita | `0.1.0` | `0.2.0` — anexos completos (`put_attachment`/`delete_attachment`), log de atividade dedicado (`mcp:action-logged`), negociação de `toolsApiVersion` no handshake e `get_server_info` |
| Ciclo de vida de arquivos | `0.1.0` — nome ao criar, confirmação opcional de renome/mover/exclusão | `0.1.0` | `0.1.0` — sem mudanças |
| Estilos | `0.1.0` — temas, painel visual, preview/undo/export | `0.1.0` | `0.2.0` — realce de sintaxe no editor livre (overlay + `CssHighlight.ts`) |
| Templates por pasta | `0.1.0` — regras por pasta, herança, status, movimentação | `0.1.0` | `0.1.0` — sem mudanças de código (a Parte 0 do plano corrigiu apenas docs) |
| Calendário | `0.2.0`¹ — grade/semana/agenda, recorrentes, lembretes, `DayActionModal` | `0.2.0`¹ | `0.3.0` — importador `.ics` (`IcsParser.ts`), `onResetData` e diagnóstico da última importação |
| Notificações | `0.1.0` — 11 gatilhos, regras, não-perturbe, histórico no painel | `0.1.0` | `0.2.0` — filtro por gatilho persistido e agrupamento por dia (`NotificationList.ts`) |
| Histórico | `0.1.0` — registro persistente e filtro por tipo | `0.1.0` | `0.2.0` — busca por texto combinada ao filtro (`HistoryFilter.ts`) e consumidor de `mcp:action-logged` |
| Auto-update | `0.1.0` — checagem, SemVer, canal, backup/rollback, checksum | `0.1.0` | `0.2.0` — verificação de assinatura GPG opt-in (`SignatureUtils.ts`), cedência ao BRAT e validação da chave pública |

¹ O `0.2.0` do Calendário na baseline é herança do dev pré-baseline —
nunca correspondeu a um release do plugin. No ciclo 0.2.0 o módulo
ganhou features SEM bump; corrigido no `[Não lançado]` com bump para
`0.3.0`. As colunas de baseline e 0.1.1 apontam para o mesmo estado de
código, apenas com rótulos de versão diferentes.

## Núcleo — completo

- Contrato de módulo (`ModuleContract.ts`): `onRegister(context)` roda
  sempre no registro (configuração acessível mesmo desligado);
  `onEnable()` só ativa; `onSettingsChange` dispara em toda gravação não
  bloqueada pela validação; `onResetData` cobre reset de dados inclusive
  de módulos desligados; `getHealthStatus` alimenta o Diagnóstico;
  `renderSettingsPanel` é a UI real de cada módulo. `settingsSchema` é
  metadado opcional (nada o lê — documentado assim).
- Event bus com isolamento de falha, throttle por evento e histórico
  consolidado (`EventBus.ts`).
- Fila de escrita por caminho (`FileWriteQueue.ts`) — todas as escritas de
  módulos e do MCP passam por ela.
- Ponte de eventos do vault (`VaultEventBridge.ts`) com dedupe, filtro de
  notas do Ciclo de Vida e guard contra listeners órfãos (testado).
- Configuração com migração de schema, validação centralizada de conflito
  de caminhos (fronteira por segmento), issues retornadas ao chamador,
  detecção de conflito de sync (`SettingsManager.ts`).
- Reset em 3 níveis com semântica real e reconciliação do runtime
  (`enabledModuleIds`) com o disco.
- Modo seguro por módulo (limite de falhas consecutivas de `onEnable`).
- Helpers compartilhados (`PathUtils.ts`, `VaultPaths.ts`) — zero
  duplicação de lógica de caminho entre módulos.
- Ciclo de vida do `main.ts`: comandos nativos registrados uma única vez,
  executáveis só com o módulo ligado (`checkCallback`), callback sempre o
  mais recente (ponte testável em `CommandBridge.ts`); descarregamento sem
  listeners órfãos.

## Módulo MCP — funcional

**Versão do módulo:** `0.2.0` — anexos completos, log de atividade
dedicado e negociação de versão são os marcos desta versão do módulo
(ver tabela acima).

**Funciona:** servidor Streamable HTTP real (Node `http`), autenticação
por token, rate limiting, modo dry-run, permissões de escrita por pasta
com fronteira por segmento cobrindo todos os destinos de escrita (incluindo
renames e combines), split/combine de notas, liberação temporária de
escrita por tempo com revogação, anexos completos: listagem, leitura,
gravação (criar/sobrescrever via base64 com validação estrita e criação de
pastas-pai) e exclusão só para a lixeira (`list_attachments`,
`get_attachment`, `put_attachment`, `delete_attachment`), log de atividade
dedicado (`mcp:action-logged`, um evento por ação executada — incluindo as
que falham — com resultado ou erro — e COM consumidor real: o Histórico
escuta o evento e registra o desfecho: ok, simulado ou FALHOU), negociação formal da versão da API de
ferramentas (`toolsApiVersion` exposta no `initialize` e na ferramenta
`get_server_info`; cliente pedindo major incompatível é rejeitado no
handshake com código dedicado), todas as escritas pela fila do
núcleo, catch global no servidor, limite de 10 MB no streaming do corpo,
restart coalescido (paralelo não falha com EADDRINUSE fantasma; desligar durante
um restart não reabre o servidor), diagnóstico mostrando a porta **em
escuta** (não a configurada), reinício automático quando a porta configurada
muda, painel completo no Lobby (porta, somente-leitura, dry-run, listas de
permissão, regenerar token, reiniciar — tudo usável com o módulo desligado).

**Não implementado ainda:** ferramentas de backlinks/links; integração com
Dataview/Bases — dependência externa, não implementável dentro do plugin:
`dataview_query` exige o plugin Dataview instalado e habilitado; sem ele,
a ferramenta responde com erro que aponta o pré-requisito em vez de falhar
em silêncio.

## Módulo Ciclo de vida de arquivos — funcional

**Funciona:** pergunta o nome ao criar qualquer nota antes dos outros
módulos reagirem (emite `lifecycle:note-ready`); o Histórico não registra
"Untitled"; confirmação opcional para renomear/mover/excluir via itens
próprios no menu de contexto e comandos no painel do módulo; leitura de
status via `metadataCache` (sem corrida com o cache do Obsidian).

**Limitação de plataforma:** ações nativas do Obsidian (clique-direito,
arrastar) não têm gancho cancelável na API — a confirmação cobre os
caminhos que o plugin controla. A intercepção do menu nativo usa um campo
interno do `Menu` e pode deixar de funcionar num update futuro do Obsidian
(nesse caso, nada quebra — os itens nativos voltam a aparecer).

## Módulo Estilos — funcional

**Versão do módulo:** `0.2.0` — o realce de sintaxe no editor livre é o
que distingue esta versão da `0.1.0` da baseline.

**Funciona:** injeção de CSS em tempo real, 7 temas prontos gerados por
`buildTheme()` (~45 variáveis derivadas de cores-base), painel visual com
~40 variáveis editáveis (sliders/color pickers), preview de tema antes de
aplicar (`ThemePreviewModal`), undo, export/import de tema, detecção de
conflito com temas externos, realce de sintaxe no editor livre (overlay
colorido atrás do textarea — tokenizador puro em `CssHighlight.ts`, com
garantia testada de round-trip exato do texto; autocomplete Ctrl+Espaço e
inserção pela referência continuam funcionando; realce pode ser
ligado/desligado no próprio editor), re-aplicação reativa a mudanças de
configuração e reset (o `<style>` injetado é limpo ao "Restaurar tudo").

## Módulo Auto-update — funcional

**Versão do módulo:** `0.2.0` — assinatura GPG e interoperabilidade com
o BRAT são os marcos desta versão do módulo.

**Funciona:** checagem manual e automática com throttle, canal estável/
beta, comparação SemVer real (pré-lançamento é mais antigo que o release
de mesmo número base), download de TODOS os assets antes de escrever
qualquer um (falha de checksum ou assinatura no meio não deixa instalação
pela metade), checksum SHA-256 quando o release declara, verificação de
assinatura GPG dos assets (OPT-IN em `SignatureUtils.ts`, regra pura
testada): assets `.sig`/`.asc` verificados com o binário `gpg` num keyring
temporário ISOLADO (nunca toca o keyring do usuário); verificação ligada
+ assinatura ausente + gpg indisponível ⇒ instalação ABORTA (falha
fechada — habilitar cria a obrigação); sem assinatura no release e opção
desligada ⇒ como sempre (checksum); o Diagnóstico reflete a ÚLTIMA
verificação (verificada/reprovada/sem chave) e `validateSettings`
bloqueia chave pública que não é armadura OpenPGP. Interoperabilidade com o BRAT: lê o
data.json do BRAT (campo `pluginList`) e, se ele gerencia este plugin, o
módulo CEdE o controle — sem checagem automática, sem comando e com aviso
no painel e no Diagnóstico (duas ferramentas escrevendo main.js é corrida
de escrita). Backup automático antes de sobrescrever, rollback com
tratamento de falha (Notice + log), "Ignorar" persistindo a versão
dispensada, mensagens de erro honestas.

## Módulo Templates por pasta — funcional

**Funciona:** regras por pasta com herança e derivação automática de
`thema` pela hierarquia, template aplicado sem quebrar o frontmatter,
`status` como lista clicável `["Pendente","Completo"]` (com regra
centralizada em `NoteStatus.ts`, testada contra o código real), movimentação
para pasta Pendente por categoria com fallback, retorno automático ao
completar, proteção anti-loop, histórico de versões de regras, painel no
Lobby para criar, editar e remover regras (formulário único de criação e
edição, com dropdown "Herdar de (regra pai)" gravando `extendsRuleId` e
trava contra ciclos de herança via `wouldCreateInheritanceLoop`), e seção
"Sugestões de template" no painel consumindo as sugestões por similaridade
(`pendingSuggestions`) com botões Aplicar/Dispensar.

## Módulo Calendário — funcional

**Versão do módulo:** `0.3.0` — a importação `.ics` e o reset de dados
importado são os marcos desta versão; o número `0.2.0` visto entre a
baseline e o ciclo 0.2.0 do plugin era herança do dev pré-baseline (ver
tabela acima).

**Funciona:** grade clicável com navegação entre meses (‹ › e "Hoje",
sem duplicar controles), indicadores por dia (nota existente, pendente,
evento) com tooltip, visões de semana e agenda, modal de escolha de
template (`DayActionModal`), eventos recorrentes com contagem ou "para
sempre", lembretes com timer de 10s, nota vinculada aberta em segundo
plano, vínculo por metadado (renomear/mover a nota não quebra), janela
espontânea desligada por padrão (opt-in), listagem de templates a partir
da pasta configurável, seletor filtrável de notas/pastas
(`FilterSuggest.ts`), importação de arquivos `.ics` (parser puro em
`IcsParser.ts`, testado contra o código real): VEVENT → evento do projeto
com dedupe por UID (importar o mesmo arquivo de novo substitui os eventos
anteriores em vez de duplicar; eventos criados à mão ficam intactos),
RRULE `FREQ=YEARLY` → recorrência anual, frequências sem suporte no modelo
(MONTHLY, WEEKLY…) viram evento único COM aviso — nunca aproximação
silenciosa —, .ics malformado mantém o painel aberto com Notice do
motivo, e o reset nível "data" remove só os eventos importados
(`ics:<uid>`), preservando os criados à mão (`evt-*`), e a última importação de .ics
aparece no Diagnóstico (falha deixa o módulo não-saudável até a próxima
boa).

## Módulo Notificações — funcional

**Versão do módulo:** `0.2.0` — filtro e agrupamento entraram nesta
versão do módulo.

**Funciona:** pop-up com som via `Notice` (com `resume()` do
`AudioContext`), 11 gatilhos documentados no manifest do módulo, regras
globais (criação/renomeação/exclusão) ligadas de fábrica, modo
não-perturbe por horário, histórico persistente dentro do painel com
"Limpar histórico" e "marcar tudo como lido", filtro por tipo de gatilho
(com contagens no dropdown) e agrupamento por dia (Hoje/Ontem/data por
extenso) — regras puras em `NotificationList.ts`, testadas contra o código
real, com preferências (filtro e agrupar por dia) persistidas na fatia do
módulo; filtro de gatilho removido degrada para "Todas" em vez de esconder
tudo.

## Módulo Histórico — funcional

**Versão do módulo:** `0.2.0` — a busca por texto e o consumo do log do
MCP são os marcos desta versão do módulo.

**Funciona:** módulo independente (não vive no núcleo), persistente entre
sessões, filtro com autocomplete e rótulos em português, busca por texto
livre (substring em message/path, case-insensitive e sem acento —
"reuniao" encontra "Reunião") combinável com o filtro de tipo (E lógico;
regra pura em `HistoryFilter.ts`, testada contra o código real), limite
configurável, integração com o dedupe da ponte de eventos (sem duplicar
"Untitled" e criação).

## Lobby — completo

**Funciona:** abertura como aba (`LobbyView`) ou janela (`LobbyModal`),
com modal real de "perguntar toda vez" e opção de lembrar escolha
(gravada com proteção de erro); linhas inteiramente clicáveis; busca por
nome; liga/desliga por módulo com aviso claro quando a ativação falha;
painel de configurações funcional para cada módulo (usável mesmo
desligado); aba de Diagnóstico (porta em escuta do MCP, saúde por módulo);
aba de Histórico com filtro; aba de Ajuda; reset em 3 níveis com
descrição honesta; ações rápidas funcionais (emitem eventos que os
módulos escutam); toggles com navegação por teclado e `aria-label`.

Navegação por teclado em todos os controles: linhas da Central de Eventos
(copiam o evento como JSON), dias do calendário (com aria-label descritivo),
visões de semana/agenda, notas pendentes e referência de CSS têm `tabIndex`,
`role`/`aria-label` e Enter/Espaço; abas internas movem o foco com ←/→
(modo manual ARIA) e ativam com Enter/Espaço; foco visível padronizado.
Reordenação dos módulos na barra lateral: arrastar pela alça ⠿ ou
Alt+↑/Alt+↓ com a alça focada; ordem persistida em
`settings.lobby.moduleOrder`, tolerante a módulos novos (entram no fim) e
removidos (somem) — regras puras em `lobbyOrder.ts`, testadas; reordenar
equivale a apresentação e NÃO muda quais módulos estão ligados
(`enabledModules` intocado).

## Coisas deliberadamente fora do escopo

- **Modo "Obsidian fechado"** (acesso cru a `.md` sem o app aberto) — é
  responsabilidade de um gateway MCP externo, que pode ler os mesmos
  arquivos do disco.
- **i18n** — strings inline em português; a extração para arquivo de
  strings ficou para depois do primeiro release estável.
- **Multi-vault / importador de config** de outros plugins (Templater,
  Dataview) — sem código.
- **Sandboxing real entre módulos** — hoje é isolamento de exceção
  (try/catch + modo seguro), não isolamento de memória; watchdog de
  CPU/memória por módulo é complexo demais no runtime do Electron e
  precisaria de uma decisão própria antes de virar código.

## Como continuar a partir daqui

1. **Validar o runtime num vault real** - o que os 426 testes não cobrem:
   Lobby completo, reset em 3 níveis, servidor MCP respondendo a um cliente
   de verdade, calendário navegando meses, update/rollback.
2. Pegar a lista de "não implementado" de **um módulo por vez**,
   implementar, testar, e só então passar ao próximo — em vez de tentar
   preencher todas as lacunas ao mesmo tempo.
3. O bump 0.1.1 já inaugurou o SemVer formal descrito no `CHANGELOG.md`:
   a partir daqui, quebra de contrato de módulo = major, feature nova =
   minor, correção = patch.
4. **Bump da `version` do módulo junto da feature** — cada módulo tem
   versão própria no manifest (tabela no topo deste doc); feature que
   entra no módulo exige bump minor ali, além da versão do plugin. Ao
   fechar release, conferir a tabela: toda coluna de release nova deve
   mostrar cada módulo sem mudanças OU com bump justificado.
