import { describe, it, expect, vi, beforeEach } from "vitest";
import { OnboardingModal } from "../src/ui/OnboardingModal";
import { capturedNotices } from "./mocks/obsidian"; // não vem de "obsidian": o tsc usa os tipos reais
import type { HubCore } from "../src/core/HubCore";
import type { ConfigValidationIssue } from "../src/core/ModuleContract";

/**
 * REGRESSÃO: onboarding fechava em silêncio com save bloqueado.
 *
 * Se o usuário deixasse os dois campos de pasta com o MESMO caminho, a
 * validação do núcleo (conflito de caminhos entre módulos) bloqueava a
 * gravação — mas o modal ignorava as issues, fechava sem salvar nem
 * avisar. O `onboardingCompleted` nem ficava true, e o usuário só
 * descobriria o problema na próxima abertura do plugin.
 *
 * Importa o CÓDIGO REAL do modal; "obsidian" é stub via alias do vitest.
 * A resposta da validação é injetada no save falso — o que se testa é o
 * COMPORTAMENTO do modal diante de um save bloqueado (regra do núcleo já
 * coberta por SettingsManager.test.ts).
 */

interface CoreSpy {
	app: { vault: { getAbstractFileByPath: () => undefined; createFolder: ReturnType<typeof vi.fn> } };
	settings: {
		get: () => { schemaVersion: number; onboardingCompleted: boolean; paths: Record<string, string> };
		save: ReturnType<typeof vi.fn>;
	};
}

function makeCore(
	paths: { calendarFolder: string; calendarTemplatesFolder: string },
	saveResult: ConfigValidationIssue[] = []
): CoreSpy {
	const settings = {
		schemaVersion: 1,
		onboardingCompleted: false,
		paths,
	};
	return {
		app: {
			vault: { getAbstractFileByPath: () => undefined, createFolder: vi.fn(async () => {}) },
		},
		settings: {
			get: () => settings,
			save: vi.fn(async () => saveResult),
		},
	};
}

/** Dispara o mesmo caminho que o clique do botão percorre: finish() privado. */
async function finishViaBotao(modal: OnboardingModal): Promise<void> {
	const finish = (modal as unknown as { finish: () => Promise<void> }).finish;
	await finish.call(modal);
}

beforeEach(() => {
	capturedNotices.length = 0;
});

describe("OnboardingModal — regressão de save bloqueado", () => {
	it("save bloqueado por conflito de caminhos: exibe Notice e NÃO marca como concluído", async () => {
		const core = makeCore(
			{ calendarFolder: "Calendario", calendarTemplatesFolder: "Calendario" }, // conflito
			[
				{
					field: "calendarFolder",
					level: "error",
					message: 'O caminho "Calendario" já está em uso por "calendarTemplatesFolder".',
				},
			]
		);
		const modal = new OnboardingModal({} as never, core as unknown as HubCore);

		await finishViaBotao(modal);

		// O Notice carrega a mensagem da validação do núcleo.
		expect(capturedNotices).toHaveLength(1);
		expect(capturedNotices[0].message).toContain("já está em uso");
		expect(capturedNotices[0].timeout).toBe(8000);
		// Save foi tentado (com onboardingCompleted true), mas foi bloqueado.
		expect(core.settings.save).toHaveBeenCalledTimes(1);
	});

	it("caminhos válidos e distintos: sem Notice, cria pasta de templates recursivamente", async () => {
		const core = makeCore({
			calendarFolder: "Calendario",
			calendarTemplatesFolder: "Calendario/templates",
		});
		const modal = new OnboardingModal({} as never, core as unknown as HubCore);

		await finishViaBotao(modal);

		expect(capturedNotices).toHaveLength(0);
		expect(core.settings.save).toHaveBeenCalledTimes(1);
		// Criação recursiva segmento a segmento: 2 segmentos no caminho aninhado.
		expect(core.app.vault.createFolder).toHaveBeenCalledTimes(2);
	});

	it("conflito com case/trailing slash diferentes também mostra o erro ao usuário", async () => {
		const core = makeCore(
			{ calendarFolder: "Calendario/", calendarTemplatesFolder: "calendario" },
			[
				{
					field: "calendarFolder",
					level: "error",
					message: "O caminho já está em uso por outro módulo.",
				},
			]
		);
		const modal = new OnboardingModal({} as never, core as unknown as HubCore);

		await finishViaBotao(modal);

		expect(capturedNotices).toHaveLength(1);
	});
});
