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
 *   - se o drain anterior FALHOU, o chamador usa `release()` para retirar os
 *     ids do estado "em voo"; o próximo drain então os tenta novamente —
 *     exatamente a janela que antes perdia entrada;
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
	 * Chame `confirm()` após o save persistir; em caso de falha, chame `release()`
	 * para permitir que o próximo drain faça retry dos ids.
	 */
	confirm: () => void;
	/** Libera o lote sem removê-lo da fila, permitindo retry após falha do save. */
	release: () => void;
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
		// Um id representa o mesmo registro lógico: uma regravação substitui
		// a versão anterior, inclusive quando a versão anterior está em voo.
		// O voo continua protegido por `inFlightIds`; a versão nova fica
		// pendente para o próximo drain após a confirmação/liberação do voo.
		this.items = [item, ...this.items.filter((existing) => existing.id !== item.id)];
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
	 * Seleciona o lote a gravar. Nada é removido: os itens passam a
	 * "em voo" e só SAEM da fila no `confirm()`. Itens com id igual a um
	 * em voo (re-record durante o save) são substituídos pela versão mais
	 * recente e ficam pendentes até o voo terminar.
	 *
	 * Há no máximo um lote em voo por id: enquanto um id estiver em voo,
	 * `takeBatch` o pula. Se o mesmo id for re-enfileirado, `enqueue` substitui
	 * a versão antiga pela mais recente e ela fica pendente até o voo terminar.
	 */
	takeBatch(max: number): DrainResult<T> {
		const batch: T[] = [];
		for (const item of this.items) {
			if (batch.length >= Math.max(0, max)) break;
			// Itens cujo id JÁ está em voo não entram num novo lote: a versão
			// mais recente permanece pendente até o voo ser confirmado/liberado.
			if (this.inFlightIds.has(item.id)) continue;
			batch.push(item);
		}
		for (const item of batch) this.inFlightIds.add(item.id);
		let confirmed = false;
		return {
			batch,
			confirm: () => {
				if (confirmed) return;
				confirmed = true;
				for (const item of batch) {
					this.inFlightIds.delete(item.id);
					// Remove apenas a mesma instância que foi persistida. Se houve
					// re-enfileiração do mesmo id durante o voo, a versão nova é
					// uma instância diferente e permanece pendente.
					const index = this.items.indexOf(item);
					if (index !== -1) this.items.splice(index, 1);
				}
			},
			release: () => {
				if (confirmed) return;
				confirmed = true;
				for (const item of batch) this.inFlightIds.delete(item.id);
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

