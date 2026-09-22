# Contribuindo com o All iₙ oNe

Obrigado pelo interesse! Este é, na origem, um plugin pessoal — então a
prioridade de design sempre será o fluxo de trabalho de quem o criou — mas
contribuições que sigam a arquitetura existente são bem-vindas.

## Antes de começar

1. Leia `src/core/ModuleContract.ts` inteiro. É o documento mais importante
   do repositório: define como qualquer módulo (existente ou novo) deve se
   comportar.
2. Um módulo nunca importa outro módulo diretamente. Toda comunicação
   acontece pelo `EventBus` (`src/core/EventBus.ts`), via `context.bus`.
3. Caminhos de pasta são sempre configuráveis pelo usuário — nunca hardcode
   um caminho dentro de um módulo.
4. Regras de negócio puras (sem I/O de vault) vivem em arquivos próprios
   ao lado do módulo (ex.: `templates/NoteStatus.ts`, `mcp/WriteRules.ts`)
   e têm suíte de teste própria que importa o código real.

## Adicionando um módulo novo

1. Crie uma pasta em `src/modules/<seu-modulo>/`.
2. Implemente a interface `HubModule` (contrato em `ModuleContract.ts`).
3. Declare, no `manifest` do módulo, todo evento que ele emite (`emits`) e
   todo evento que escuta (`listensTo`) — isso é o que documenta as conexões
   entre módulos automaticamente na Central de Eventos do Lobby.
4. Registre a instância do módulo em `src/main.ts`, dentro do array `modules`.
5. Não é necessário alterar `HubCore`, `EventBus`, `SettingsManager` ou
   `LobbyRenderer` para adicionar um módulo — se você sentir necessidade de
   alterar algum desses arquivos, é sinal de que o contrato pode estar
   faltando algo, e vale abrir uma discussão antes de um PR grande.
6. Se o módulo registrar comandos nativos, use `context.registerCommand` —
   a ponte do núcleo (`src/core/CommandBridge.ts`: registro único +
   `checkCallback`) cuida do ciclo de vida. Não chame `addCommand`
   diretamente no `onEnable`.

## Rodando localmente

```bash
npm install
npm run dev      # build com watch
npm test         # 258 testes em 23 arquivos (vitest)
```

Os testes importam o **código real** do plugin: o pacote `obsidian` é
substituído em runtime de teste por um stub (`tests/mocks/obsidian.ts`,
via alias no `vitest.config.ts`). Ao escrever testes novos, importe as
implementações de verdade em vez de reimplementar regras à mão — cópias
espelhadas divergem do código sem ninguém perceber.

Para testar dentro do Obsidian de verdade, copie a pasta do repositório
(ou os arquivos `main.js`, `manifest.json`, `styles.css` já buildados) para
`<seu-vault>/.obsidian/plugins/All-in-oNe/`, e habilite o plugin.

## Convenções do projeto

- **Erros nunca ficam silenciosos em caminhos de UI**: falha de gravação,
  validação bloqueada ou rollback mantêm o contexto aberto (modal/painel)
  e mostram `Notice` com o motivo.
- **Escritas no vault passam por `FileWriteQueue`** (`context.queue`).
- **Criação de pastas usa `VaultPaths`** (o `vault.createFolder` do
  Obsidian não cria pastas-pai).
- **`TFile.path` é mutado pelo Obsidian ao renomear** — capture o caminho
  original numa constante ANTES de qualquer rename.
- Todo texto de UI está em português (i18n é uma decisão futura, não
  dívida).

## Versionamento

O projeto segue SemVer a partir da v0.1.0 (baseline — veja
`CHANGELOG.md`). Uma mudança que quebra o contrato de módulo
(`ModuleContract.ts`) é sempre um bump de major version — módulos escritos
contra a versão anterior do contrato podem parar de funcionar.
