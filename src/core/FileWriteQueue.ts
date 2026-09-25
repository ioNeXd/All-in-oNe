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
 * MECANISMO: chain + publish + delegate.
 *
 *   run(path, op) delega a runMany([path], op) — mecanismo idêntico.
 *   runMany(paths, op):
 *     1. Dedup + sort das chaves (deadlock-free, determinístico).
 *     2. LÊ as filas existentes e monta uma cadeia determinística por chave.
 *     3. PUBLICA os claims no Map em uma única sequência síncrona.
 *        Como JavaScript não intercala outra chamada durante este trecho,
 *        nenhuma chamada concorrente observa um estado parcialmente publicado.
 *     4. operation() roda só quando TODA fila anterior + a cadeia interna termina.
 *     5. Limpeza automática quando a fila termina sem novo claim.
 *
 * Uso: await fileWriteQueue.run(path, () => app.vault.modify(file, content))
 */
export class FileWriteQueue {
	private queues = new Map<string, Promise<unknown>>();

	/**
	 * Serializa uma operação num caminho único. Delega a runMany —
	 * mesmo mecanismo de locking, sem código duplicado.
	 */
	run<T>(path: string, operation: () => Promise<T>): Promise<T> {
		return this.runMany([path], operation);
	}

	/**
	 * Serializa uma operação que toca múltiplos paths (ex.: rename A→B).
	 *
	 * CLAIM-FIRST: o Map é atualizado ANTES de ler filas existentes.
	 * Isso garante que chamadas concorrentes veem os claims e se encadeiam.
	 *
	 * Dedup + sort: [B, A] e [A, B] produzem a mesma ordem → sem deadlock.
	 */
	runMany<T>(paths: string[], operation: () => Promise<T>): Promise<T> {
		const keys = [...new Set(paths)].sort();

		// --- FASE 1-2: CHAIN + PUBLISH ---
		// Monta claims encadeando na ordem das chaves, depois registra no Map.
		// Cada claim aguarda: (a) a fila existente da chave E (b) o claim
		// anterior dentro do mesmo conjunto. Isso serializa internamente.
		const claimPromises: Promise<unknown>[] = [];
		let chainHead: Promise<unknown> = Promise.resolve();
		for (const key of keys) {
			const existing = this.queues.get(key);
			const base = existing ?? Promise.resolve();
			chainHead = chainHead.then(() => base).then(() => undefined);
			claimPromises.push(chainHead);
		}

		// Publica os claims depois de montar toda a cadeia. O trecho é síncrono,
		// portanto outra chamada não pode intercalar uma leitura parcial do Map.
		for (let i = 0; i < keys.length; i++) {
			this.queues.set(keys[i], claimPromises[i]);
		}

		// --- FASE 3: OPERAÇÃO ---
		// chainHead aguarda todas as filas existentes + claims anteriores.
		const current = chainHead.then(operation, operation);
		const chained = current.catch(() => undefined);

		// Substitui claims pela promise final (inclui a operação).
		// Qualquer run/runMany futuro encontra chained e se encadeia.
		for (const key of keys) {
			this.queues.set(key, chained);
		}

		// --- FASE 4: CLEANUP ---
		// Remove do Map quando ESTA promessa terminou e ninguém mais assumiu.
		void chained.then(() => {
			for (const key of keys) {
				if (this.queues.get(key) === chained) this.queues.delete(key);
			}
		});

		return current;
	}
}
