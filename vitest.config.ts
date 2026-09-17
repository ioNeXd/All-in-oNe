import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
	resolve: {
		alias: {
			// O pacote "obsidian" é types-only (sem entry executável — só existe
			// dentro do app). Nos testes que importam código real do plugin, este
			// stub o substitui em runtime; o tsc segue resolvendo os tipos
			// oficiais. Antes disto, os testes tinham que ESPELHAR as regras à
			// mão (ver comentários em McpValidation.test.ts e TemplateStatus.test.ts).
			obsidian: fileURLToPath(new URL("./tests/mocks/obsidian.ts", import.meta.url)),
		},
	},
});
