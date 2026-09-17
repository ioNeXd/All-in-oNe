# Checklist de validação manual — v0.1.0

O que os **103 testes automatizados** não cobrem é o runtime de verdade
dentro do Obsidian: ciclo de vida do plugin, interações de UI, portas,
arquivos e o comportamento sob uso real. Este checklist guia essa validação
no vault. Marque cada item só depois de ver o resultado com os próprios
olhos — o objetivo é gerar confiança para o primeiro bump de versão
(0.1.x) e, no caminho, achar bugs que análise estática não pega.

## Preparação

- [ ] Vault **de teste** (não o vault principal). Nada aqui destrói dados,
      mas reset e lixeira mexem em arquivos de verdade.
- [ ] Build atual: `npm run build` e copie `main.js`, `manifest.json` e
      `styles.css` para `<vault>/.obsidian/plugins/All-in-oNe/`.
- [ ] Habilite em **Configurações → Plugins da comunidade**.
- [ ] **Onboarding abre sozinho** (é a primeira execução):
  - [ ] Digitar a **mesma pasta** nos dois campos → o modal mostra erro em
        Notice e **não fecha** (validação do núcleo surfacing, não silêncio);
  - [ ] Corrigir para pastas diferentes → grava e conclui; pastas
        `Calendario/` e `Calendario/templates` são criadas (inclusive
        aninhadas, que é o caso que já quebrou: `vault.createFolder` não
        cria pastas-pai);
  - [ ] Reabrir o Obsidian → onboarding **não** abre de novo.

## 1. Lobby — abertura, toggles e diagnóstico

- [ ] Ícone da ribbon abre o Lobby (aba, com foco);
- [ ] Command Palette → "Abrir All iₙ oNe" também abre;
- [ ] Se `lobby.openMode = ask-each-time` (padrão): pergunta aba/janela;
      marcar "Lembrar desta escolha" grava a preferência (reabrir sem
      perguntar); mudar depois nas configurações gerais funciona;
- [ ] **Clicar em qualquer parte da linha** de um módulo abre o painel dele
      (não só no nome — regressão antiga);
- [ ] Busca filtra módulos pelo nome;
- [ ] **Desligar um módulo** pelo toggle: aviso de "desligado" no painel;
      **religar**: volta a funcionar (e sem duplicar seus comandos na
      Paleta — verificar buscando "MCP:" duas vezes);
- [ ] Aba **Diagnóstico**: cada módulo mostra resumo coerente (o MCP mostra
      a porta **em escuta**; módulo desligado aparece como "Desligado");
- [ ] **Central de Eventos**: eventos aparecendo conforme as ações abaixo;
      botão de teste dispara um evento visível; limpar funciona;
- [ ] Aba **Ajuda / Como funciona** abre com conteúdo.

## 2. Módulos ligados/desligados × comandos (ciclo de vida)

- [ ] Com o MCP **ligado**: Paleta mostra "MCP: Reiniciar servidor"
      **habilitado**;
- [ ] Desligue o módulo MCP no Lobby → o comando aparece **desabilitado**
      (cinza) na Paleta — *não* executável (era o furo de ciclo de vida:
      invocá-lo reabriria o servidor "fantasma");
- [ ] Religue o MCP → comando volta a funcionar, e a Paleta não acumula
      entradas duplicadas ao repetir o ciclo 2–3 vezes.

## 3. MCP — servidor, permissões e ferramentas

- [ ] Ligar o módulo: sem erro no console; **Diagnóstico** mostra porta
      `27931` (padrão — escolhida para não colidir com o "Local REST API");
- [ ] **Configurar um cliente MCP real** (Claude Desktop, Cursor ou
      `mcp-remote`) apontando para `http://127.0.0.1:27931` com o token do
      painel. O cliente conclui o **handshake** sozinho (`initialize` →
      `notifications/initialized` — implementado; antes disso, clientes
      reais falhavam no primeiro passo) e só depois lista as ferramentas;
      `read_note`, `list_folder`, `search_vault`, `describe_vault`,
      `get_note_metadata` funcionam no cliente;
- [ ] **Sem token** (requisição sem `Authorization`): cliente recebe erro —
      autenticação antes de qualquer leitura;
- [ ] Token errado: erro imediato; token certo: funciona;
- [ ] **Regenerar token** no painel: cliente antigo para de funcionar, novo
      token funciona; "Copiar token" e "Copiar comando de teste" colocam
      conteúdo correto na área de transferência (no Windows, o comando vem
      pronto para PowerShell — o `curl` de lá é alias de
      `Invoke-WebRequest`);
- [ ] **Somente leitura (global)**: `create_note`/`edit_note`/`delete_note`
      são **recusados** pelo cliente; leituras funcionam;
- [ ] Desligar "somente leitura" e testar **permissões por pasta**: com
      allowlist `Trabalho`, escrever em `Trabalho/...` funciona; escrever
      em outra pasta é recusado; com `Secretas` na **blocklist**, uma
      subpasta `Secretas2` **continua acessível** (a fronteira é por
      segmento — `Secretas2` não casa com bloqueio de `Secretas`);
- [ ] `rename_note` movendo nota de pasta permitida para bloqueada: recusado
      (destino também é verificado);
- [ ] **Modo dry-run**: com o toggle ligado, `create_note` responde
      `simulated: true` e **nada é criado**;
- [ ] **Liberação temporária**: "15 minutos" habilita escrita com contador;
      "Revogar" volta a bloquear na hora;
- [ ] **Split/combine**: `split_note` divide uma nota grande por headings
      (verificar se as partes nascem certas); `combine_notes` junta de
      volta; nota não fica corrompida nem duplicada;
- [ ] **Trocar a porta** (ex.: 27932) e aplicar: diagnóstico passa a mostrar
      a porta nova **em escuta** e o servidor responde nela (reinício
      automático via `onSettingsChange`);
- [ ] **Reiniciar servidor** pelo painel: funciona; clicar em seguida
      novamente **não** dá erro fantasma de porta ocupada (restarts
      paralelos são coalescidos);
- [ ] **Desligar o módulo** com o servidor rodando: porta para de responder
      (verificar com o cliente ou `curl`); religar: volta.

## 4. Calendário — notas, eventos e lembretes

- [ ] Grade do mês atual no painel do módulo: dias clicáveis; indicadores
      coerentes (nota existente, pendente, evento) com tooltip;
- [ ] Navegação ‹ › e "Hoje" entre meses **sem duplicar controles** (regressão
      antiga: a grade se aninhava a cada troca);
- [ ] Clicar num dia → `DayActionModal` pergunta: nota com template / nota
      vazia / evento;
- [ ] **Nota com template**: escolhe um template da pasta configurada; a
      nota nasce em `Calendario/2026/09 - Setembro/` (número para ordenar,
      nome para ler) com `date`, `thema`, `origem` e `status`;
- [ ] **Eventos recorrentes**: criar evento anual com horário e lembrete;
      nota vinculada abre **em segundo plano** (sem roubar o foco do
      formulário); editar/remover/testar cada evento da lista funciona;
- [ ] **Lembrete**: "Testar lembrete agora" dispara som + pisca ícone; a
      janela do Obsidian **não é trazida para frente** por padrão (opt-in
      nas configurações do módulo);
- [ ] Renomear a nota vinculada a um evento: vínculo **não quebra** (é por
      metadado `origem_evento`, não por caminho);
- [ ] **Visões** semana/agenda: alternam e mostram conteúdo coerente.

## 5. Templates — fluxo Pendente de ponta a ponta

- [ ] Criar regra para uma pasta (ex.: `Projetos`) pelo painel do módulo;
- [ ] Criar nota nessa pasta: pergunta o nome (módulo de Ciclo de Vida), e
      depois o template é aplicado — **frontmatter intacto** (o corpo entra
      primeiro; o frontmatter é gravado via `processFrontMatter`);
- [ ] A nota nasce com `status: ["Pendente", "Completo"]` — chip clicável no
      painel de Propriedades;
- [ ] Mover a nota para fora / remover o chip "Pendente" → nota vai para a
      pasta Pendente (por categoria, com fallback);
- [ ] Apagar o campo `status` por inteiro (o Obsidian às vezes remove a
      propriedade toda) → nota **volta** para a pasta de origem;
- [ ] Escrever "Completo" à mão → também devolve à origem;
- [ ] **Histórico** (aba Histórico do Lobby): criação aparece **uma** vez
      com o nome definitivo — sem "Untitled" duplicado (regressão antiga);
- [ ] `Ctrl+N` seguidas vezes: a pergunta de nome funciona em **todas** as
      notas (regressão da travagem de `Untitled.md` no Set).

## 6. Estilos e temas

- [ ] Aba "Temas prontos": aplicar cada um dos 7 (Claude, Dracula, VS Code
      Dark+, Nord, Gruvbox, Solarized Light, alto contraste) → sem áreas
      "esquecidas" (Configurações, busca, toggles, checkboxes mudam de cor);
- [ ] **Preview antes de aplicar** (`ThemePreviewModal`): mostrar preview →
      aplicar → confirmar;
- [ ] Painel visual: mexer em ~5 variáveis → aplicar → efeito imediato;
      **Editor livre** e painel visual **concordam** (aplicar tema atualiza
      os seletores do painel — regressão antiga);
- [ ] Undo desfaz; export copia JSON; import lê de volta;
- [ ] Aplicar CSS quebrado → erro tratado, sem derrubar o plugin;
- [ ] **Restaurar tudo (nível "all")** → o `<style>` injetado é removido
      (nenhum CSS órfão).

## 7. Auto-update — canal, backup e rollback

> A validação completa depende de **um release real publicado pelo
> workflow** (`release.yml` com checksums SHA-256 no corpo). Sem release
> novo, valide só o caminho "sem atualização".

- [ ] "Verificar agora" com plugin na última versão: aviso coerente
      ("nenhuma atualização"), sem popup em loop (throttle respeitado);
- [ ] Colocar o canal em **beta**: um release `v0.2.0-beta.1` publicado vira
      candidato; canal **estável** o ignora (filtra `prerelease`);
- [ ] Popup de atualização mostra **changelog** e botões Atualizar/Ignorar;
      "Ignorar" persiste a versão dispensada (popup não volta a cada 6h);
- [ ] **Atualizar**: baixa TODOS os assets, verifica checksums contra o
      corpo do release, faz backup, aplica, pede recarregar o Obsidian;
      após recarregar, `manifest.json` da instalação mostra a versão nova;
- [ ] **Reverter**: volta para a versão anterior com Notice de sucesso;
      falha simulada (permissão do SO na pasta do plugin) mostra **erro**
      em vez de engolir;
- [ ] Comparação de versão: release `v0.2.0` é considerado mais novo que
      `v0.10.0` (SemVer real — não lexicográfico).

## 8. Reset em 3 níveis (modal "Restaurar tudo")

> Use após os testes acima, quando houver config custom e dados gerados —
> a semântica é o que está em teste, não o conteúdo.

- [ ] **Config**: fatias por módulo e caminhos voltam ao default; toggles
      do Lobby refletem o default (todos ligados) **imediatamente** — sem
      precisar reiniciar (reconciliação em memória); módulo que estava
      desligado é religado; dados (histórico etc.) intactos;
- [ ] **Data**: histórico do módulo History e preferências de Notificações
      são limpos conforme os hooks `onResetData`; **configuração intocada**
      (portas, regras, temas continuam como estavam); toggles NÃO mudam;
- [ ] **All**: config padrão + dados limpos; CSS injetado some; estado do
      Lobby coerente na hora;
- [ ] Desligar um módulo, resetar "config", religar: nada de estado fantasma
      (era o furo da divergência Set × disco);
- [ ] Nenhum nível fecha o modal silenciosamente se a gravação falhar.

## 9. Notificações e Histórico (módulos)

- [ ] Som dispara nos eventos habilitados (criação, MCP, lembretes) — o
      `AudioContext` precisa de interação prévia na página (clicar no
      Obsidian antes resolve; regressão antiga);
- [ ] Não-perturbe no horário atual: pop-ups silenciados (som desligado);
- [ ] "Marcar tudo como lido" e "Limpar histórico" funcionam; IDs de
      notificação não colidem (duas ações rápidas seguidas ficam **duas**
      entradas no histórico);
- [ ] Histórico do módulo: filtro por tipo com autocomplete em português;
      persiste entre recargas do plugin (desabilitar/habilitar o Obsidian);
- [ ] **Rajada de criação** (selecionar 20+ notas e criar): o Histórico do
      módulo registra **todas** as ocorrências (throttle do bus agrupa, não
      descarta); Notificações toca popup/som apenas no 1º item da rajada;
- [ ] **Leitura fresca**: registrar um evento e abrir o diagnóstico do
      Histórico na sequência — a contagem inclui a entrada na hora, sem
      esperar a janela de gravação de 2s (write-behind);

## 10. Estabilidade de sessão e desligamento

- [ ] Desabilitar/habilitar o **plugin** inteiro 3× seguidas: sem erros no
      console (guard de listeners órfãos da ponte do vault; sem portas
      duplicadas; sem timers sobrando);
- [ ] Abrir/fechar o Obsidian **rápido** antes do layout estabilizar: sem
      listeners de vault órfãos (histórico para de receber eventos com o
      plugin desligado);
- [ ] Console limpo de erros após uma sessão completa (warnings conhecidos
      do Electron/Obsidian não contam);
- [ ] `data.json` do plugin: sem campos sensíveis em claro (token MCP
      ofuscado via `secureStore`).

## Critério de saída

Tudo marcado = baseline validada em runtime. Bugs achados: registrar em
issue com passo a passo e console anexado, corrigir, e reexecutar **só** a
seção afetada + a seção 10 (estabilidade). Com isso, o projeto está pronto
para o primeiro bump `0.1.1` e para usar o fluxo `npm version` + tag do
`release.yml` com confiança.
