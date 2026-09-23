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
 * Limitação conhecida: a serialização é por path, não por identidade do
 * arquivo. Operações que alteram o caminho (rename/move A→B) e operações
 * concorrentes em B usam chaves diferentes e PODEM executar em paralelo.
 * Para o escopo atual (MCP + templates + histórico), isso é aceitável;
 * se no futuro for necessário, a extensão seria um renameLock: Set<string>
 * para paths de destino durante renames.
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
}
