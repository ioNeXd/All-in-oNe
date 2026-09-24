/**
 * FILA DE ESCRITA POR ARQUIVO
 * ----------------------------
 * O vault do Obsidian é assíncrono, e mais de um módulo pode tentar mexer no
 * mesmo arquivo ao "mesmo tempo" (ex.: o módulo de Templates movendo uma nota
 * para "Pendente" exatamente quando o servidor MCP está editando essa mesma
 * nota a pedido de um cliente externo). Sem serialização, isso é uma race
 * condition clássica — a escrita que "chegar por último" pode sobrescrever
 * ou corromper o resultado da outra.
 *
 * Esta fila garante que todas as operações de escrita para um MESMO caminho
 * rodem em sequência, nunca em paralelo — sem bloquear operações em arquivos
 * diferentes, que continuam concorrentes normalmente.
 *
 * `runMany(paths, operation)` serializa uma operação que toca MÚLTIPLOS
 * caminhos simultaneamente (rename/move A→B adquire ambos os locks).
 * Chaves são ordenadas para evitar deadlock entre renames cruzados.
 *
 * Uso: `await fileWriteQueue.run(path, () => app.vault.modify(file, novoConteudo))`
 */
export class FileWriteQueue {
	private queues = new Map<string, Promise<unknown>>();

	/**
	 * Serializa uma operação num caminho único. Delega a runMany para
	 * compartilhar o mecanismo de locking — a aquisição é atômica porque
	 * todas as .set() no Map são síncronas (sem await) antes do return.
	 */
	run<T>(path: string, operation: () => Promise<T>): Promise<T> {
		return this.runMany([path], operation);
	}

	/**
	 * Serializa uma operação que toca múltiplos paths (ex.: rename A→B).
	 *
	 * LOCKING ATÔMICO: todas as leituras (.get) e escritas (.set) no Map
	 * de filas ocorrem no mesmo tick síncrono — sem await entre elas.
	 * Qualquer chamada concorrente (run ou runMany) que execute no próximo
	 * microtask já vê os locks registrados e espera a resolução.
	 *
	 * Chaves ordenadas (sort) para deadlock-free entre renames cruzados.
	 * Duplicatas removidas (Set) para não encadear a mesma fila duas vezes.
	 */
	runMany<T>(paths: string[], operation: () => Promise<T>): Promise<T> {
		const keys = [...new Set(paths)].sort();

		// 1) Leitura atômica: coleta o estado atual das filas para todas as chaves.
		//    Tudo síncrono — nenhum await aqui.
		let previous = Promise.resolve();
		for (const key of keys) {
			const queued = this.queues.get(key) ?? Promise.resolve();
			previous = Promise.all([previous, queued]).then(() => undefined);
		}

		// 2) Encadeia a operação: só roda quando TODAS as filas anteriores drenaram.
		const current = previous.then(operation, operation);
		const chained = current.catch(() => undefined);

		// 3) Escrita atômica: registra os locks ANTES de qualquer coisa observar.
		//    Mesmo tick síncrono das leituras — impossível interleaving.
		for (const key of keys) {
			this.queues.set(key, chained);
		}

		// 4) Limpeza: remove do Map quando ESTA promessa drenar e ninguém mais
			//    assumiu a chave. Condição `still === chained` garante que um run
		//    novo encadeado na frente não é apagado acidentalmente.
		void chained.then(() => {
			for (const key of keys) {
				if (this.queues.get(key) === chained) this.queues.delete(key);
			}
		});

		return current;
	}
}
