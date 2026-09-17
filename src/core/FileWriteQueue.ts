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
 * Uso: `await fileWriteQueue.run(path, () => app.vault.modify(file, novoConteudo))`
 */
export class FileWriteQueue {
	private queues = new Map<string, Promise<unknown>>();

	async run<T>(path: string, operation: () => Promise<T>): Promise<T> {
		const previous = this.queues.get(path) ?? Promise.resolve();
		const current = previous.then(operation, operation); // roda mesmo se a anterior falhou
		// Evita vazamento de memória: guarda só a última promessa da fila.
		this.queues.set(
			path,
			current.catch(() => undefined)
		);
		return current;
	}
}
