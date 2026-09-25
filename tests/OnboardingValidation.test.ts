import { describe, it, expect, vi, beforeEach } from "vitest";
import { OnboardingModal } from "../src/ui/OnboardingModal";
import { capturedNotices } from "./mocks/obsidian";
import type { HubCore } from "../src/core/HubCore";

function makeCore(saveIssues: unknown[] = []) {
	const settings = {
		get: () => ({
			schemaVersion: 2,
			onboardingCompleted: false,
			modules: {},
			enabledModules: [],
			lobby: { openMode: "tab", theme: "match-obsidian" },
			paths: {
				calendarFolder: "01 - Calendario",
				calendarTemplatesFolder: "99 - Sistema/Templates/Calendário",
			},
			sync: { lastWrittenBy: "test", lastWrittenAt: 0 },
			telemetry: { enabled: false },
		}),
		validate: vi.fn(() => []),
		save: vi.fn(async () => saveIssues),
	};
	return {
		app: {
			vault: {
			getAbstractFileByPath: () => undefined,
			createFolder: vi.fn(async () => {}),
			create: vi.fn(async () => {}),
			modify: vi.fn(async () => {}),
			},
		},
		settings,
		getModules: () => [],
	};
}

async function finishViaButton(modal: OnboardingModal): Promise<void> {
	const finish = (modal as unknown as { finish: () => Promise<void> }).finish;
	await finish.call(modal);
}

beforeEach(() => {
	capturedNotices.length = 0;
});

describe("OnboardingModal", () => {
	it("não conclui quando a validação bloqueia os caminhos", async () => {
		const core = makeCore([{ field: "calendarFolder", level: "error", message: "caminho em conflito" }]);
		core.settings.validate.mockReturnValue([{ field: "calendarFolder", level: "error", message: "caminho em conflito" }]);
		const modal = new OnboardingModal({} as never, core as unknown as HubCore);

		await finishViaButton(modal);

		expect(core.settings.validate).toHaveBeenCalledTimes(1);
		expect(core.settings.save).not.toHaveBeenCalled();
		expect(capturedNotices[0].message).toContain("caminho em conflito");
	});

	it("valida, cria as pastas e salva onboardingCompleted=true", async () => {
		const core = makeCore();
		const modal = new OnboardingModal({} as never, core as unknown as HubCore);

		await finishViaButton(modal);

		expect(capturedNotices).toHaveLength(0);
		expect(core.settings.validate).toHaveBeenCalledTimes(1);
		expect(core.settings.save).toHaveBeenCalledTimes(1);
		const saved = core.settings.save.mock.calls[0][0];
		expect(saved.onboardingCompleted).toBe(true);
		expect(core.app.vault.createFolder).toHaveBeenCalled();
	});
});
