import { describe, it, expect } from "vitest";
import { isNormalizedComplete, decideCompletionAction, STATUS_PENDING_INITIAL, STATUS_COMPLETE_NORMALIZED } from "../src/core/NoteStatus";

describe("regras de conclusão de templates", () => {
	it("usa Incompleto como status inicial", () => {
		expect(STATUS_PENDING_INITIAL).toEqual(["Incompleto"]);
	});

	it("usa Completo como status normalizado", () => {
		expect(STATUS_COMPLETE_NORMALIZED).toEqual(["Completo"]);
		expect(isNormalizedComplete(["Completo"])).toBe(true);
		expect(isNormalizedComplete(["completo"])).toBe(true);
		expect(isNormalizedComplete("Completo")).toBe(false);
		expect(isNormalizedComplete(["Incompleto"])).toBe(false);
	});

	it("sem origem não move nem altera a nota", () => {
		expect(decideCompletionAction(undefined, "Estudos/Pendente/nota.md")).toEqual({
			rewriteStatus: false,
			move: false,
		});
	});

	it("concluída fora da origem normaliza e move", () => {
		expect(decideCompletionAction("Estudos/Matematica/nota.md", "Estudos/Pendente/nota.md")).toEqual({
			rewriteStatus: true,
			move: true,
		});
	});

	it("concluída já na origem só normaliza de forma idempotente", () => {
		expect(decideCompletionAction("Estudos/Matematica/nota.md", "Estudos/Matematica/nota.md")).toEqual({
			rewriteStatus: true,
			move: false,
		});
	});
});
