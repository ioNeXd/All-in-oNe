import { describe, it, expect } from "vitest";
import { moveModuleId, orderedModules } from "../src/ui/lobbyOrder";

/**
 * Regras puras da ordem dos módulos no Lobby (drag-and-drop e Alt+↑/↓).
 * Importam o código real — sem reimplementar regras (padrão do projeto).
 */
describe("lobbyOrder — ordem dos módulos", () => {
	const NATURAL = ["a", "b", "c", "d"];

	it("sem ordem salva, mantém a ordem natural (default é hoje)", () => {
		const mods = NATURAL.map((id) => ({ manifest: { id } }));
		expect(orderedModules(mods, undefined)).toEqual(mods);
		expect(orderedModules(mods, [])).toEqual(mods);
	});

	it("ordem salva reordena; não muta a lista de entrada", () => {
		const mods = NATURAL.map((id) => ({ manifest: { id } }));
		const result = orderedModules(mods, ["d", "a"]);
		expect(result.map((m) => m.manifest.id)).toEqual(["d", "a", "b", "c"]);
	});

	it("id inexistente na ordem salva é ignorado (nunca vira linha fantasma)", () => {
		const mods = NATURAL.map((id) => ({ manifest: { id } }));
		const result = orderedModules(mods, ["fantasma", "c", "a"]);
		expect(result.map((m) => m.manifest.id)).toEqual(["c", "a", "b", "d"]);
	});

	it("módulo novo (não citado) entra no fim, na ordem natural", () => {
		const mods = [...NATURAL, "e"].map((id) => ({ manifest: { id } }));
		const result = orderedModules(mods, ["b", "a"]);
		expect(result.map((m) => m.manifest.id)).toEqual(["b", "a", "c", "d", "e"]);
	});

	it("move para cima e para baixo; nas bordas não move", () => {
		expect(moveModuleId(undefined, "b", -1, NATURAL)).toEqual(["b", "a", "c", "d"]);
		expect(moveModuleId(undefined, "b", 1, NATURAL)).toEqual(["a", "c", "b", "d"]);
		expect(moveModuleId(undefined, "a", -1, NATURAL)).toEqual(NATURAL);
		expect(moveModuleId(undefined, "d", 1, NATURAL)).toEqual(NATURAL);
	});

	it("move sobre uma ordem salva existente (não zera a preferência)", () => {
		const result = moveModuleId(["c", "a", "b", "d"], "a", -1, NATURAL);
		expect(result).toEqual(["a", "c", "b", "d"]);
	});

	it("normaliza ordem defasada ao mover: novo entra no fim, removido sai", () => {
		// "e" é módulo novo ausente da ordem; "x" é id morto na ordem.
		const result = moveModuleId(["x", "a", "c"], "b", 1, ["a", "b", "c", "e"]);
		// normalizada: [a, c, b, e]; mover b +1 → [a, c, e, b]
		expect(result).toEqual(["a", "c", "e", "b"]);
	});

	it("não muta a lista de entrada", () => {
		const order = ["b", "a"];
		moveModuleId(order, "b", 1, NATURAL);
		expect(order).toEqual(["b", "a"]);
	});
});
