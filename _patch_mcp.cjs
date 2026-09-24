const fs = require('fs');
const file = String.raw`C:\Users\ionem\Documents\VisualStudioCode\obsidian-plugin\src\modules\mcp\McpModule.ts`;
let c = fs.readFileSync(file, 'utf8');

// 1. Import validateVaultPath
if (!c.includes('import { validateVaultPath }')) {
  c = c.replace(
    'import { createRateLimiter, wouldAllow, reserve } from "./RateLimit";',
    'import { createRateLimiter, wouldAllow, reserve } from "./RateLimit";\nimport { validateVaultPath } from "../../core/PathUtils";'
  );
}

// 2. Add size limits after temporaryWriteUntil
if (!c.includes('MAX_INPUT_CONTENT_CHARS')) {
  c = c.replace(
    '\tprivate temporaryWriteUntil = 0;',
    '\tprivate temporaryWriteUntil = 0;\n\n\t/** Limites centralizados para entrada e saída de ferramentas MCP. */\n\tstatic readonly MAX_INPUT_CONTENT_CHARS = 1_000_000;\n\tstatic readonly MAX_INPUT_BASE64_BYTES = 10 * 1024 * 1024;\n\tstatic readonly MAX_OUTPUT_BYTES = 5 * 1024 * 1024;'
  );
}

// 3. Replace normalizePath(String(args.path)) with validateVaultPath in executeTool
// Only inside executeTool method, not in isWriteAllowed or elsewhere
c = c.replace(/const path = normalizePath\(String\(args\.path\)\);/g, 'const path = validateVaultPath(String(args.path));');
c = c.replace(/const newPath = normalizePath\(String\(args\.newPath\)\);/g, 'const newPath = validateVaultPath(String(args.newPath));');

// 4. Add output limit to read_note
c = c.replace(
  /case "read_note": \{[\s\S]*?return \{ content: await vault\.read\(file as TFile\) \};\n\t\t\}/,
  `case "read_note": {
\t\t\t\tconst readPath = validateVaultPath(String(args.path));
\t\t\t\tconst file = vault.getAbstractFileByPath(normalizePath(readPath));
\t\t\t\tif (!(file instanceof TFileClass)) throw new Error("Nota não encontrada.");
\t\t\t\tconst readContent = await vault.read(file as TFile);
\t\t\t\tif (readContent.length > McpModule.MAX_OUTPUT_BYTES) throw new Error("Nota excede o limite de tamanho para leitura.");
\t\t\t\treturn { content: readContent };
\t\t\t}`
);

// 5. Add output limit to get_attachment
c = c.replace(
  /const buffer = await vault\.readBinary\(file as TFile\);\n\t\t\t\treturn \{\n\t\t\t\t\tpath,\n\t\t\t\t\tsizeBytes: buffer\.byteLength,/,
  'const buffer = await vault.readBinary(file as TFile);\n\t\t\t\tif (buffer.byteLength > McpModule.MAX_OUTPUT_BYTES) throw new Error("Anexo excede o limite de tamanho para download.");\n\t\t\t\treturn {\n\t\t\t\t\tpath,\n\t\t\t\t\tsizeBytes: buffer.byteLength,'
);

// 6. Add input limit to put_attachment
c = c.replace(
  /const bytes = decodeBase64\(args\.base64\);\n\t\t\t\t\/\/ Decisão/,
  'const bytes = decodeBase64(args.base64);\n\t\t\t\tif (bytes.byteLength > McpModule.MAX_INPUT_BASE64_BYTES) throw new Error("Anexo excede o limite de tamanho para upload.");\n\t\t\t\t// Decisão'
);

// 7. Add input content limits to create_note, append_note, edit_note
// create_note
c = c.replace(
  /case "create_note": \{\n\t\t\t\tconst path = validateVaultPath\(String\(args\.path\)\);\n\t\t\t\tawait write\(path, \(\) => vault\.create\(path, String\(args\.content ?? ""\)\)\);/,
  'case "create_note": {\n\t\t\t\tconst path = validateVaultPath(String(args.path));\n\t\t\t\tconst createContent = String(args.content ?? "");\n\t\t\t\tif (createContent.length > McpModule.MAX_INPUT_CONTENT_CHARS) throw new Error("Conteúdo excede o limite de tamanho.");\n\t\t\t\tawait write(path, () => vault.create(normalizePath(path), createContent));'
);

// append_note
c = c.replace(
  /await write\(path, \(\) => vault\.append\(file as TFile, String\(args\.content ?? ""\)\)\);/,
  'const appendContent = String(args.content ?? "");\n\t\t\t\tif (appendContent.length > McpModule.MAX_INPUT_CONTENT_CHARS) throw new Error("Conteúdo excede o limite de tamanho.");\n\t\t\t\tawait write(path, () => vault.append(file as TFile, appendContent));'
);

// edit_note
c = c.replace(
  /await write\(path, \(\) => vault\.modify\(file as TFile, String\(args\.content ?? ""\)\)\);/,
  'const editContent = String(args.content ?? "");\n\t\t\t\tif (editContent.length > McpModule.MAX_INPUT_CONTENT_CHARS) throw new Error("Conteúdo excede o limite de tamanho.");\n\t\t\t\tawait write(path, () => vault.modify(file as TFile, editContent));'
);

// 8. Sanitize error message in catch block
c = c.replace(
  'return { ok: false, error: String(err) };\n\t\t\t}',
  'const safeMsg = err instanceof Error ? sanitizeMcpError(err.message) : "Erro interno na execução da ferramenta.";\n\t\t\t\treturn { ok: false, error: safeMsg };\n\t\t\t}'
);

// 9. Add sanitizeMcpError function before the class
if (!c.includes('sanitizeMcpError')) {
  c = c.replace(
    'export class McpModule implements HubModule {',
    `/** Sanitiza mensagem de erro: remove caminhos internos, stack traces, detalhes de implementação. */
function sanitizeMcpError(msg: string): string {
\t// Remove qualquer path que pareça caminho de arquivo
\tlet safe = msg.replace(/[A-Z]:\\\\[^\s"']+/gi, "[caminho interno]");
\tsafe = safe.replace(/\\/[^\\s"']+/g, "[caminho interno]");
\t// Remove stack traces (linhas que começam com "at " ou "Error:")
\tsafe = safe.split("\\n").filter(l => !l.trim().startsWith("at ") && !l.trim().startsWith("Error:")).join(" ");
\t// Trunca se ainda muito longo
\tif (safe.length > 200) safe = safe.slice(0, 200) + "...";
\treturn safe || "Erro interno na execução da ferramenta.";
}

export class McpModule implements HubModule {`
  );
}

fs.writeFileSync(file, c, 'utf8');
console.log('McpModule.ts patched successfully');
