import { describe, it, expect } from "vitest";
import { FileWriteQueue } from "../src/core/FileWriteQueue";

describe("FileWriteQueue", () => {
	it("serializa operações no MESMO caminho, na ordem de chamada", async () => {
		const queue = new FileWriteQueue();
		const order: number[] = [];

		const op = (n: number, delay: number) => async () => {
			await new Promise((r) => setTimeout(r, delay));
			order.push(n);
		};

		await Promise.all([
			queue.run("nota.md", op(1, 20)),
			queue.run("nota.md", op(2, 5)),
			queue.run("nota.md", op(3, 1)),
		]);

		expect(order).toEqual([1, 2, 3]); // mesmo o 3 sendo o mais rápido, respeita a ordem de chegada
	});

	it("não bloqueia operações em caminhos diferentes", async () => {
		const queue = new FileWriteQueue();
		const order: string[] = [];

		await Promise.all([
			queue.run("a.md", async () => {
				await new Promise((r) => setTimeout(r, 20));
				order.push("a");
			}),
			queue.run("b.md", async () => {
				order.push("b");
			}),
		]);

		expect(order[0]).toBe("b"); // b termina antes por não esperar a fila de a.md
	});

	it("continua a fila mesmo se uma operação anterior falhar", async () => {
		const queue = new FileWriteQueue();
		const results: string[] = [];

		await queue
			.run("x.md", async () => {
				throw new Error("falhou");
			})
			.catch(() => results.push("erro-capturado"));

		await queue.run("x.md", async () => {
			results.push("segunda-operacao-rodou");
		});

		expect(results).toEqual(["erro-capturado", "segunda-operacao-rodou"]);
	});

	it("remove a chave quando a fila do caminho drena (sem vazamento)", async () => {
		const queue = new FileWriteQueue();
		await queue.run("a.md", async () => {});
		await queue.run("b.md", async () => {});

		// A limpeza roda no microtask após a resolução — cede um tick:
		await new Promise((r) => setTimeout(r, 0));

		// Reflexão sobre o Map privado, sem expor API só para o teste:
		const size = (queue as unknown as { queues: Map<string, unknown> }).queues.size;
		expect(size).toBe(0); // antes: 2 entradas para sempre por caminho tocado
	});

	it("NÃO remove a chave se um run novo encadeou antes do dreno", async () => {
		const queue = new FileWriteQueue();
		let releaseSecond!: () => void;
		const gate = new Promise<void>((r) => (releaseSecond = r));

		const first = queue.run("y.md", async () => {
			await gate; // segura a fila aberta
		});
		const second = queue.run("y.md", async () => {}); // encadeia atrás

		releaseSecond();
		await Promise.all([first, second]);
		await new Promise((r) => setTimeout(r, 0));

		// Nenhum dos dois removeu no meio: o 1º drena primeiro, mas a chave
		// já era do `chained` do 2º (que encadeou antes) — a conferência
		// `still === chained` só deixa o DONO ATUAL da chave remover, então a
		// serialização de um 3º run concorrente nunca é quebrada. Com a fila
		// inteira drenada, a chave saiu do Map.
		const size = (queue as unknown as { queues: Map<string, unknown> }).queues.size;
		expect(size).toBe(0);

		// E um run novo depois do dreno continua serializado normalmente
		// (recomeça uma fila nova, sem depender da entrada antiga):
		await queue.run("y.md", async () => {});
		await new Promise((r) => setTimeout(r, 0));
		expect((queue as unknown as { queues: Map<string, unknown> }).queues.size).toBe(0);
	});
	describe("runMany", () => {
		it("adquire locks de múltiplos paths na ordem canônica", async () => {
			const queue = new FileWriteQueue();
			const order: string[] = [];

			await queue.runMany(["b.md", "a.md"], async () => {
				order.push("op");
			});

			expect(order).toEqual(["op"]);
		});

		it("serializa com run concorrente em path diferente", async () => {
			const queue = new FileWriteQueue();
			const order: string[] = [];

			await Promise.all([
				queue.runMany(["a.md", "b.md"], async () => {
					await new Promise((r) => setTimeout(r, 15));
					order.push("many");
				}),
				queue.run("b.md", async () => {
					order.push("single");
				}),
			]);

			expect(order).toContain("many");
			expect(order).toContain("single");
			expect(order.length).toBe(2);
		});

		it("prevê deadlock em renames cruzados (A→B e B→A)", async () => {
			const queue = new FileWriteQueue();
			const order: number[] = [];

			await Promise.all([
				queue.runMany(["b.md", "a.md"], async () => {
					await new Promise((r) => setTimeout(r, 10));
					order.push(1);
				}),
				queue.runMany(["a.md", "b.md"], async () => {
					order.push(2);
				}),
			]);

			expect(order).toEqual([1, 2]); // sem deadlock
		});

		it("captura erro sem travar a fila dos paths", async () => {
			const queue = new FileWriteQueue();

			await queue
				.runMany(["x.md"], async () => {
					throw new Error("fail");
				})
				.catch(() => {});

			let ran = false;
			await queue.runMany(["x.md", "y.md"], async () => {
				ran = true;
			});
			expect(ran).toBe(true);
		});

		it("drena todas as chaves do Map", async () => {
			const queue = new FileWriteQueue();
			await queue.runMany(["a.md", "b.md"], async () => {});
			await new Promise((r) => setTimeout(r, 0));
			const size = (queue as unknown as { queues: Map<string, unknown> }).queues.size;
			expect(size).toBe(0);
		});
	});
});
