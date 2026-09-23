/**
 * WRITE-BEHIND GENÉRICO — PURO, SEM RELÓGIO E SEM PERSISTÊNCIA
 * -------------------------------------------------------------
 * O padrão write-behind do Histórico e das Notificações tinha uma janela
 * residual de corrida: `flushNow` tirava o lote de `pending*` ANTES do
 * `await updateSettings`. Uma entrada `record()` entre o `takeBatch()` e a
 * confirmação do save ficava SÓ em memória — e se o flush seguinte não
 * acontecesse (crash, disable logo após), ela se perdia antes do teto de
 * ~2s aceito por design. O `flushGeneration` cobria clear/reset, não o
 * caminho normal.
 *
 * Correção (opção "não zerar pending até o save confirmar", com backstop):
 *   - `enqueue` devolve uma lista NOVA cuja CABEÇA é o lote em voo — o
 *     `record` seguinte empurra atrás do que ainda está sendo salvo;
 *   - `takeBatch` aceita um conjunto `inFlightIds` do drain anterior: o lote
 *     novo nunca repete ids já em voo (o disco ainda vai recebê-los) —
 *     sem duplicata no merged;
 *   - se o drain anterior FALHOU, os ids em voo não são confirmados e o
 *     lote novo os recontém (retry natural) — exatamente a janela que
 *     antes perdia entrada;
 *   - `generation` protegendo clear/reset continua existindo, mas como
 *     detalhe do chamador — aqui só há fila e confirmação.
 *
 * Puro: relógio não entra (quem agenda o timer é o módulo, como antes).
 */

/** Espaço de id genérico: qualquer registro com id único estável. */
export interface Identified {
	id: string;
}

export interface DrainResult<T> {
	/** Lote a gravar (na ordem do módulo: mais recente primeiro). */
	batch: T[];
	/**
	 * Chame `confirm(ids)` após o save persistir; sem confirmação, o próximo
	 * drain re-inclui estes ids (retry — a janela de perda some).
	 */
	confirm: () => void;
}

export class WriteBehindQueue<T extends Identified> {
	private items: T[] = [];
	/** Ids do lote em voo (entre takeBatch e confirm). */
	private inFlightIds = new Set<string>();

	/**
	 * Adiciona um registro (na frente — mais recente primeiro) devolvendo a
	 * fila NOVA como array (o módulo mantém compat com o readSettings que
	 * concatenava o array). Imutável por fora: nenhum aliasing com o array
	 * que o chamador guardou antes.
	 */
	enqueue(item: T): T[] {
		this.items = [item, ...this.items];
		return this.pendingSnapshot();
	}

	/** Conteúdo pendente (inclusive o que está em voo) — para leitura/UI. */
	pendingSnapshot(): T[] {
		return [...this.items];
	}

	get size(): number {
		return this.items.length;
	}

	get hasInFlight(): boolean {
		return this.inFlightIds.size > 0;
	}

	/**
	 * Tira da fila o lote a gravar. Nada é removido: os itens passam a
	 * "em voo" e SAEM da fila só no `confirm()`. Itens com id igual a um
	 * em voo (re-record durante o save) ficam na fila para o drain seguinte
	 * — o batch corrente não os repete, e o próximo leva a diferença.
	 *
	 * Em voo é marcado com CONTADOR por id (dois drains em cascata podem
	 * carregar o mesmo id — ex.: save falhou sem confirm e o retry o pegou
	 * de novo). O confirm só solta de vez quando todos os voos do id acabam.
	 */
	takeBatch(max: number): DrainResult<T> {
		const batch: T[] = [];
		for (const item of this.items) {
			if (batch.length >= Math.max(0, max)) break;
			// Itens cujo id JÁ está em voo não entram num novo lote: a versão
			// mais recente (cabeça) é a que fica — se houver re-enfileiração,
			// a antiga sai no confirm e a nova segue pendente.
			if (this.inFlightIds.has(item.id)) continue;
			batch.push(item);
		}
		for (const item of batch) this.inFlightIds.add(item.id);
		return {
			batch,
			confirm: () => {
				for (const item of batch) {
					this.inFlightIds.delete(item.id);
					// Remove a ÚLTIMA ocorrência do id (a mais recente). Se o id
					// foi re-enfileirado durante o voo, a cópia mais nova
					// permanece na fila para o drain seguinte — versão correta.
					const index = this.items.findLastIndex?.((x) => x.id === item.id)
						?? fallbackFindLastIndex(this.items, item.id);
					if (index !== -1) this.items.splice(index, 1);
				}
			},
		};
	}

	/**
	 * Limpa tudo (clear/reset): fila e em-voo zerados. O drain em curso pode
	 * ainda gravar o lote antigo — invalidar essa gravação é papel do
	 * `flushGeneration` do módulo (como já era), não da fila.
	 */
	clear(): void {
		this.items = [];
		this.inFlightIds = new Set();
	}
}

/** findLastIndex para runtimes sem ES2023 (a fila roda dentro do Obsidian). */
function fallbackFindLastIndex<T extends Identified>(items: T[], id: string): number {
	for (let i = items.length - 1; i >= 0; i--) {
		if (items[i].id === id) return i;
	}
	return -1;
}
