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

	async run<T>(path: string, operation: () => Promise<T>): Promise<T> {
		const previous = this.queues.get(path) ?? Promise.resolve();
		const current = previous.then(operation, operation); // roda mesmo se a anterior falhou
		// Encadeia a fila com a promise blindada (a falha de `operation` não
		// pode travar os runs seguintes do mesmo caminho).
		const chained = current.catch(() => undefined);
		this.queues.set(path, chained);
		// Limpeza da chave: quando ESTA promessa da fila resolver (sem nenhum
		// run novo encadeado na frente), o caminho drenou — apagar evita que
		// o Map cresça sem limite numa sessão longa (o plugin vive no
		// processo do Obsidian por horas; cada caminho tocado deixava uma
		// entrada para sempre). A conferência `still === chained` só permite
		// a remoção se NENHUM run novo assumiu a chave nesse meio-tempo: se
		// assumiu, a chave pertence à nova promessa da fila.
		void chained.then(() => {
			if (this.queues.get(path) === chained) this.queues.delete(path);
		});
		return current;
	}

	/**
	 * Serializa uma operação que toca múltiplos paths (ex.: rename A→B).
	 * Adquire locks de todos os paths em ordem canônica (sort) para evitar
	 * deadlock entre renames cruzados (A→B e B→A). A operação roda quando
	 * NENHUM dos paths tiver outra operação pendente.
	 */
	runMany<T>(paths: string[], operation: () => Promise<T>): Promise<T> {
		const keys = [...new Set(paths)].sort();

		let previous = Promise.resolve();
		for (const key of keys) {
			const queued = this.queues.get(key) ?? Promise.resolve();
			previous = Promise.all([previous, queued]).then(() => undefined);
		}

		const current = previous.then(operation, operation);
		const chained = current.catch(() => undefined);

		for (const key of keys) {
			this.queues.set(key, chained);
		}

		// Drena todas as chaves — só remove se NENHUM run novo assumiu.
		void chained.then(() => {
			for (const key of keys) {
				if (this.queues.get(key) === chained) this.queues.delete(key);
			}
		});

		return current;
	}
}
