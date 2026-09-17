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
});
