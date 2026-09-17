# Status de implementação — v0.1.0

Este documento existe para ser honesto sobre o que está **funcional de
verdade** neste projeto versus o que é **esqueleto pronto para expandir**.
A v0.1.0 é a linha de base: a arquitetura está completa e auditada, cada
módulo está funcional na sua função principal, e as lacunas restantes estão
listadas aqui sem rodeio.

> Estado da validação nesta linha de base: typecheck estrito ✅ ·
> **103 testes em 14 arquivos** (todos importando código real, não cópias
> espelhadas) ✅ · build de produção ✅. O que os testes não cobrem é o
> runtime de verdade no Obsidian — para isso, siga `docs/MANUAL-VALIDATION.md`.

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

**Funciona:** servidor Streamable HTTP real (Node `http`), autenticação
por token, rate limiting, modo dry-run, permissões de escrita por pasta
com fronteira por segmento cobrindo todos os destinos de escrita (incluindo
renames e combines), split/combine de notas, liberação temporária de
escrita por tempo com revogação, todas as escritas pela fila do núcleo,
catch global no servidor, limite de 10 MB no streaming do corpo, restart
coalescido (paralelo não falha com EADDRINUSE fantasma; desligar durante
um restart não reabre o servidor), diagnóstico mostrando a porta **em
escuta** (não a configurada), reinício automático quando a porta configurada
muda, painel completo no Lobby (porta, somente-leitura, dry-run, listas de
permissão, regenerar token, reiniciar — tudo usável com o módulo desligado).

**Não implementado ainda:** ferramentas de backlinks/links, integração com
Dataview/Bases, manipulação de anexos, log de atividade dedicado além do
Histórico genérico, negociação formal de versão da API de ferramentas (o
campo existe, a lógica não).

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

**Funciona:** injeção de CSS em tempo real, 7 temas prontos gerados por
`buildTheme()` (~45 variáveis derivadas de cores-base), painel visual com
~40 variáveis editáveis (sliders/color pickers), preview de tema antes de
aplicar (`ThemePreviewModal`), undo, export/import de tema, detecção de
conflito com temas externos, re-aplicação reativa a mudanças de
configuração e reset (o `<style>` injetado é limpo ao "Restaurar tudo").

**Não implementado:** realce de sintaxe/autocomplete no editor livre (hoje
é campo de texto puro; o Painel visual cobre a edição guiada).

## Módulo Auto-update — funcional

**Funciona:** checagem manual e automática com throttle, canal estável/
beta, comparação SemVer real (pré-lançamento é mais antigo que o release
de mesmo número base), download de TODOS os assets antes de escrever
qualquer um (falha de checksum no meio não deixa instalação pela metade),
checksum SHA-256 quando o release declara, backup automático antes de
sobrescrever, rollback com tratamento de falha (Notice + log), "Ignorar"
persistindo a versão dispensada, mensagens de erro honestas.

**Não implementado:** assinatura GPG dos assets; interoperabilidade formal
com o fluxo do BRAT (documentado como alternativa, sem código específico).

## Módulo Templates por pasta — funcional no fluxo principal

**Funciona:** regras por pasta com herança e derivação automática de
`thema` pela hierarquia, template aplicado sem quebrar o frontmatter,
`status` como lista clicável `["Pendente","Completo"]` (com regra
centralizada em `NoteStatus.ts`, testada contra o código real), movimentação
para pasta Pendente por categoria com fallback, retorno automático ao
completar, proteção anti-loop, histórico de versões de regras, painel no
Lobby para criar/remover regras.

**Não implementado:** edição de regra existente pelo painel (hoje só criar
ou remover — editar exige recriar); sugestão de template por similaridade
emite evento mas não tem UI consumindo; validação de `allowedValues` por
campo (o tipo existe, a checagem não usa); seletor de "regra pai" para
herança no formulário.

## Módulo Calendário — funcional no essencial

**Funciona:** grade clicável com navegação entre meses (‹ › e "Hoje",
sem duplicar controles), indicadores por dia (nota existente, pendente,
evento) com tooltip, visões de semana e agenda, modal de escolha de
template (`DayActionModal`), eventos recorrentes com contagem ou "para
sempre", lembretes com timer de 10s, nota vinculada aberta em segundo
plano, vínculo por metadado (renomear/mover a nota não quebra), janela
espontânea desligada por padrão (opt-in), listagem de templates a partir
da pasta configurável, seletor filtrável de notas/pastas
(`FilterSuggest.ts`).

**Não implementado:** import `.ics`.

## Módulo Notificações — funcional

**Funciona:** pop-up com som via `Notice` (com `resume()` do
`AudioContext`), 11 gatilhos documentados no manifest do módulo, regras
globais (criação/renomeação/exclusão) ligadas de fábrica, modo
não-perturbe por horário, histórico persistente dentro do painel com
"Limpar histórico" e "marcar tudo como lido".

**Não implementado:** agrupamento/filtros dentro da lista (hoje é
cronológica simples).

## Módulo Histórico — funcional

**Funciona:** módulo independente (não vive no núcleo), persistente entre
sessões, filtro com autocomplete e rótulos em português, limite
configurável, integração com o dedupe da ponte de eventos (sem duplicar
"Untitled" e criação).

**Não implementado:** busca por texto livre (o filtro é por tipo/evento).

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

**Não implementado:** navegação 100% por teclado em todos os painéis;
painéis são funcionais mas simples (sem drag-and-drop).

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

1. **Validar o runtime num vault real** — o que os 103 testes não cobrem:
   Lobby completo, reset em 3 níveis, servidor MCP respondendo a um cliente
   de verdade, calendário navegando meses, update/rollback.
2. Pegar a lista de "não implementado" de **um módulo por vez**,
   implementar, testar, e só então passar ao próximo — em vez de tentar
   preencher todas as lacunas ao mesmo tempo.
3. Quando houver confiança no runtime, o primeiro bump de versão (0.1.x)
   inaugura o SemVer formal descrito no `CHANGELOG.md`.
