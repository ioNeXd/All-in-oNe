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

## Adicionando um módulo novo

1. Crie uma pasta em `src/modules/<seu-modulo>/`.
2. Implemente a interface `HubModule` (contrato em `ModuleContract.ts`).
3. Declare, no `manifest` do módulo, todo evento que ele emite (`emits`) e
   todo evento que escuta (`listensTo`) — isso é o que documenta as conexões
   entre módulos automaticamente na Central de Eventos do Lobby.
4. Registre a instância do módulo em `src/main.ts`, dentro do array `modules`.
5. Não é necessário alterar `HubCore`, `EventBus`, `SettingsManager` ou
   `LobbyView` para adicionar um módulo — se você sentir necessidade de
   alterar algum desses arquivos, é sinal de que o contrato pode estar
   faltando algo, e vale abrir uma discussão antes de um PR grande.

## Rodando localmente

```bash
npm install
npm run dev      # build com watch
npm test         # testes unitários (core/contrato)
```

Para testar dentro do Obsidian de verdade, copie a pasta do repositório
(ou os arquivos `main.js`, `manifest.json`, `styles.css` já buildados) para
`<seu-vault>/.obsidian/plugins/All-in-oNe/`, e habilite o plugin.

## Versionamento

O projeto segue SemVer. Uma mudança que quebra o contrato de módulo
(`ModuleContract.ts`) é sempre um bump de major version — módulos escritos
contra a versão anterior do contrato podem parar de funcionar.
