import type { ModuleId } from "./ModuleContract";

/**
 * PONTE DE COMANDOS NATIVOS
 * -------------------------
 * Resolve dois problemas da integração módulo × Command Palette do Obsidian:
 *
 * 1. **A API não tem `removeCommand`.** Um comando registrado via addCommand
 *    vive enquanto o plugin viver. Como os módulos registram seus comandos
 *    no onEnable, eles SOBREVIVERIAM ao desligar o módulo pelo Lobby: invocar
 *    "MCP: Reiniciar servidor" com o módulo desligado reabriria o servidor
 *    FORA do ciclo de vida (servidor vivo, módulo "Desligado", invisível no
 *    diagnóstico). O checkCallback abaixo fecha esse furo para TODOS os
 *    módulos, presentes e futuros: o comando só é executável com o módulo
 *    ligado — com ele desligado, aparece desabilitado na Paleta (o
 *    comportamento que o usuário espera).
 *
 * 2. **Religar um módulo re-executa o registro.** O onEnable roda de novo a
 *    cada liga/desliga pelo Lobby e o módulo chama registerCommand outra
 *    vez. Guardando por chave, o addCommand real só roda UMA vez por comando
 *    (sem acúmulo de entradas duplicadas no array interno do plugin) e o
 *    callback executado é sempre o MAIS RECENTE — o closure vivo, não o da
 *    primeira ativação.
 *
 * Quem consome é o main.ts: injeta `register` (o addCommand do plugin) e
 * `isModuleEnabled` (o estado de verdade do núcleo); os módulos chegam aqui
 * via `context.registerCommand` (HubCore.buildContext).
 */
export class CommandBridge {
	/** Chave "moduleId-cmdId" -> callback mais recente registrado pelo módulo. */
	private callbacks = new Map<string, () => void>();

	constructor(
		/**
		 * Registra o comando no Obsidian (na prática: plugin.addCommand).
		 * Retorna o id completo usado no registro — para o main.ts montar o
		 * objeto do comando e para os testes conferirem o que foi registrado.
		 */
		private register: (cmd: {
			id: string;
			name: string;
			checkCallback: (checking: boolean) => boolean;
		}) => unknown,
		private isModuleEnabled: (moduleId: ModuleId) => boolean
	) {}

	/** Chamado pelo HubCore via context.registerCommand(id, name, callback). */
	registerCommand(moduleId: ModuleId, cmdId: string, name: string, callback: () => void): void {
		const key = `${moduleId}-${cmdId}`;
		const isNew = !this.callbacks.has(key);
		this.callbacks.set(key, callback);
		if (!isNew) return; // re-registro: só o callback é atualizado, sem duplicar entrada

		this.register({
			id: key,
			name,
			checkCallback: (checking: boolean) => {
				if (!this.isModuleEnabled(moduleId)) return false;
				if (!checking) this.callbacks.get(key)?.();
				return true;
			},
		});
	}

	/** Número de comandos efetivamente registrados no Obsidian (p/ diagnóstico e testes). */
	get size(): number {
		return this.callbacks.size;
	}

	has(moduleId: ModuleId, cmdId: string): boolean {
		return this.callbacks.has(`${moduleId}-${cmdId}`);
	}
}
