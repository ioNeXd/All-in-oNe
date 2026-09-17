## O que este PR muda

## Módulo(s) afetado(s)

## Checklist
- [ ] Segue o contrato de módulo (`src/core/ModuleContract.ts`) sem alterá-lo, ou justifica a mudança de contrato como breaking change
- [ ] `npm run build` passa sem erros
- [ ] `npm test` passa
- [ ] Não introduz acesso direto de um módulo a outro (toda comunicação via `context.bus`)
- [ ] Caminhos novos de pasta são configuráveis, não hardcoded
