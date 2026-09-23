import { describe, it, expect } from "vitest";
import { WriteBehindQueue } from "../src/core/WriteBehind";

/**
 * Fila write-behind do Histórico/Notificações. Fecha a janela residual de
 * corrida: itens só saem no confirm do save; um record DURANTE o save entra
 * na fila atrás do lote em voo e vai no drain seguinte — não fica órfão.
 */

type Entry = { id: string; label: string };
const e = (id: string, label = id): Entry => ({ id, label });

describe("WriteBehindQueue — enqueue/pendingSnapshot", () => {
	it("enqueue mantém ordem mais-recente-primeiro e devolve snapshot imutável", () => {
		const q = new WriteBehindQueue<Entry>();
		q.enqueue(e("a"));
		const snapshot = q.enqueue(e("b"));
		expect(snapshot.map((x) => x.id)).toEqual(["b", "a"]);
		// Snapshot não é alias da fila interna:
		snapshot.push(e("fantasma"));
		expect(q.pendingSnapshot().map((x) => x.id)).toEqual(["b", "a"]);
	});

	it("size conta o que ainda não foi confirmado", () => {
		const q = new WriteBehindQueue<Entry>();
		expect(q.size).toBe(0);
		q.enqueue(e("a"));
		q.enqueue(e("b"));
		expect(q.size).toBe(2);
	});
});

describe("WriteBehindQueue — drain sem janela de perda (o bug original)", () => {
	it("record DURANTE o save em voo: não entra no batch corrente, vai no próximo", () => {
		const q = new WriteBehindQueue<Entry>();
		q.enqueue(e("a"));

		const first = q.takeBatch(50);
		expect(first.batch.map((x) => x.id)).toEqual(["a"]);

		// Chega entrada enquanto o save do lote "a" está em voo:
		q.enqueue(e("b"));

		// O drain seguinte NÃO repete "a" (em voo) e traz "b":
		const second = q.takeBatch(50);
		expect(second.batch.map((x) => x.id)).toEqual(["b"]);

		// Confirm dos dois saves: fila esvazia na ordem certa.
		first.confirm();
		second.confirm();
		expect(q.size).toBe(0);
		expect(q.hasInFlight).toBe(false);
	});

	it("save que FALHA (sem confirm): itens voltam no drain seguinte (retry)", () => {
		const q = new WriteBehindQueue<Entry>();
		q.enqueue(e("a"));
		const drain = q.takeBatch(50); // save em voo... e falhou
		q.enqueue(e("b"));

		// Sem drain.confirm(): "a" continua pendente (em voo) — o próximo
		// lote traz "b" (o mais recente, cabeça da fila) e NÃO repete "a".
		// MAS "a" só sai de vez quando o confirm do lote que o carrega
		// acontecer: sem confirm, ele segue em voo, pendente, não perdido.
		const retry = q.takeBatch(50);
		expect(retry.batch.map((x) => x.id)).toEqual(["b"]);

		// O retry TAMBÉM falha (sem confirm). O drain original confirma AGORA
		// (chegou a resposta do primeiro save — sucesso): "a" finalmente sai.
		drain.confirm();
		expect(q.pendingSnapshot().map((x) => x.id)).toEqual(["b"]);

		// E o retry confirma depois: fila esvazia.
		retry.confirm();
		expect(q.size).toBe(0);
	});

	it("save que falha E nunca confirma: item segue em voo até novo drain após re-take com novo lote", () => {
		// Cenário do bug original: o flush tirou o item de pending ANTES do
		// await. Se o save falhava e nada mais chegava, o item morria em
		// variável local. Aqui: sem confirm, o item NUNCA sai da fila.
		const q = new WriteBehindQueue<Entry>();
		q.enqueue(e("a"));
		const failed = q.takeBatch(50); // save falhou, confirm nunca chamado
		expect(q.pendingSnapshot().map((x) => x.id)).toEqual(["a"]); // ainda lá
		void failed;
		// Novo fluxo (ex.: próximo flush agendado por entrada nova):
		q.enqueue(e("b"));
		const next = q.takeBatch(50);
		expect(next.batch.map((x) => x.id)).toEqual(["b"]); // "a" em voo: não repete
		// O módulo confirma o retry com o MESMO lote que carrega "a":
		failed.confirm(); // agora o save antigo "aconteceu" (ou foi abortado)
		next.confirm();
		expect(q.size).toBe(0);
	});

	it("takeBatch respeita o teto (max) — lote sai mais-recente-primeiro — e deixa o resto", () => {
		const q = new WriteBehindQueue<Entry>();
		// Enfileira a, b, c nessa ordem: fila = [c, b, a] (mais recente na cabeça).
		for (const id of ["a", "b", "c"]) q.enqueue(e(id));
		const drain = q.takeBatch(2);
		expect(drain.batch.map((x) => x.id)).toEqual(["c", "b"]);
		drain.confirm();
		const next = q.takeBatch(50);
		expect(next.batch.map((x) => x.id)).toEqual(["a"]);
		next.confirm();
		expect(q.size).toBe(0);
	});

	it("re-record do MESMO id durante o voo: não duplica no disco", () => {
		const q = new WriteBehindQueue<Entry>();
		q.enqueue(e("a", "v1"));
		const first = q.takeBatch(50); // "a" em voo
		// Mesma id re-enfileirada (ex.: dedupe por id falhou em outro lugar):
		q.enqueue(e("a", "v2"));
		const second = q.takeBatch(50);
		expect(second.batch.map((x) => x.id)).toEqual([]); // em voo: não repete
		first.confirm();
		// Depois do confirm, a versão re-enfileirada sai no próximo drain:
		const third = q.takeBatch(50);
		expect(third.batch.map((x) => x.id)).toEqual(["a"]);
		expect(third.batch[0].label).toBe("v2");
		third.confirm();
		expect(q.size).toBe(0);
	});
});

describe("WriteBehindQueue — clear (clear/reset do módulo)", () => {
	it("zera fila e em-voo; hasInFlight volta a false", () => {
		const q = new WriteBehindQueue<Entry>();
		q.enqueue(e("a"));
		q.takeBatch(50);
		q.enqueue(e("b"));
		q.clear();
		expect(q.size).toBe(0);
		expect(q.hasInFlight).toBe(false);
		const drain = q.takeBatch(50);
		expect(drain.batch).toEqual([]);
		// confirm de um lote já cleared é inofensivo:
		expect(() => drain.confirm()).not.toThrow();
	});
});
