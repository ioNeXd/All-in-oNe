import { readFileSync, writeFileSync } from "node:fs";

// === Fix 11: delete_note lookup inside lock ===
{
  const FILE = "src/modules/mcp/McpModule.ts";
  let code = readFileSync(FILE, "utf8");

  // The delete_note still has lookup before lock - fix it
  const deleteOld = `case "delete_note": {
\t\t\t\tconst path = validateVaultPath(String(args.path));
\t\t\t\tconst file = vault.getAbstractFileByPath(path);
\t\t\t\tif (!file) throw new Error("Nota não encontrada.");
\t\t\t\tawait write(path, () => vault.trash(file, true));`;
  const deleteNew = `case "delete_note": {
\t\t\t\tconst path = validateVaultPath(String(args.path));
\t\t\t\t// Lookup + exclusão DENTRO do lock.
\t\t\t\tawait write(path, async () => {
\t\t\t\t\tconst file = vault.getAbstractFileByPath(path);
\t\t\t\t\tif (!file) throw new Error("Nota não encontrada.");
\t\t\t\t\tawait vault.trash(file, true);`;

  if (code.includes(deleteOld)) {
    // Find the closing of the delete_note case and replace the whole thing
    const idx = code.indexOf(deleteOld);
    const after = code.substring(idx);
    // Find the return statement
    const returnIdx = after.indexOf('return { path };\n\t\t\t}');
    if (returnIdx >= 0) {
      const endIdx = idx + returnIdx + 'return { path };\n\t\t\t}'.length;
      const replacement = `case "delete_note": {
\t\t\t\tconst path = validateVaultPath(String(args.path));
\t\t\t\t// Lookup + exclusão DENTRO do lock.
\t\t\t\tawait write(path, async () => {
\t\t\t\t\tconst file = vault.getAbstractFileByPath(path);
\t\t\t\t\tif (!file) throw new Error("Nota não encontrada.");
\t\t\t\t\tawait vault.trash(file, true); // lixeira, nunca exclusão direta
\t\t\t\t});
\t\t\t\treturn { path };
\t\t\t}`;
      code = code.substring(0, idx) + replacement + code.substring(endIdx);
      console.log("Fix 11 (delete_note): applied");
    } else {
      console.log("Fix 11 (delete_note): could not find end marker");
    }
  } else {
    console.log("Fix 11 (delete_note): pattern not found (may already be fixed)");
  }

  // Fix 9: MCP output limit - add check after executeTool returns
  const outputLimitCode = `\t\t/** Limite de saída MCP: respostas acima deste valor são rejeitadas com erro seguro. */\n\tprivate static readonly MAX_OUTPUT_BYTES = 5 * 1024 * 1024;`;
  if (!code.includes("MAX_OUTPUT_BYTES")) {
    // Add it after MAX_INPUT_BASE64_BYTES
    code = code.replace(
      /static readonly MAX_INPUT_BASE64_BYTES = 10 \* 1024 \* 1024;/,
      `static readonly MAX_INPUT_BASE64_BYTES = 10 * 1024 * 1024;\n\t/** Limite de saída MCP: respostas acima deste valor são rejeitadas com erro seguro. */\n\tstatic readonly MAX_OUTPUT_BYTES = 5 * 1024 * 1024;`
    );
    console.log("Fix 9 (MCP output limit constant): applied");
  }

  // Fix 9: enforce output size limit in handleToolCall
  const resultSizeCheck = `// Fix 9: enforce output size limit
\t\tconst resultJson = JSON.stringify(result);
\t\tif (resultJson.length > McpModule.MAX_OUTPUT_BYTES) {
\t\t\treturn { ok: false, error: "Resposta da ferramenta excede o limite de tamanho permitido." };
\t\t}`;

  // Add size check after executeTool in handleToolCall
  const execPattern = `const result = await this.executeTool(toolName, args, settings);
\t\t\tthis.context?.log(\`Ferramenta MCP executada: \${toolName}\`, { path: args.path as string });`;
  if (code.includes(execPattern) && !code.includes("resultJson.length")) {
    code = code.replace(execPattern,
      `const result = await this.executeTool(toolName, args, settings);
\t\t\t// Enforce output size limit
\t\t\tconst resultJson = JSON.stringify(result);
\t\t\tif (resultJson.length > McpModule.MAX_OUTPUT_BYTES) {
\t\t\t\treturn { ok: false, error: "Resposta da ferramenta excede o limite de tamanho permitido." };
\t\t\t}
\t\t\tthis.context?.log(\`Ferramenta MCP executada: \${toolName}\`, { path: args.path as string });`
    );
    console.log("Fix 9 (MCP output limit enforcement): applied");
  }

  writeFileSync(FILE, code, "utf8");
}

// === Fix 12: server.ts - validate arguments as object ===
{
  const FILE = "src/modules/mcp/server.ts";
  let code = readFileSync(FILE, "utf8");

  // Replace the arguments extraction with proper validation
  const oldArgs = `const args = (message.params?.arguments ?? {}) as Record<string, unknown>;`;
  const newArgs = `// Fix 12: validate arguments is a proper object (not null, array, string, etc.)
\t\t\tconst rawArgs = message.params?.arguments;
\t\t\tif (rawArgs === null || rawArgs === undefined) {
\t\t\t\t// arguments ausente: permite (ferramentas sem args obrigatórios)
\t\t\t} else if (typeof rawArgs !== "object" || Array.isArray(rawArgs)) {
\t\t\t\trespondError(res, message.id, "O campo 'arguments' deve ser um objeto.", {
\t\t\t\t\tcode: "INVALID_PARAMS",
\t\t\t\t\tjsonRpcCode: JSONRPC_ERRORS.INVALID_PARAMS,
\t\t\t\t});\n\t\t\t\treturn;\n\t\t\t}
\t\t\tconst args = (rawArgs ?? {}) as Record<string, unknown>;`;

  if (code.includes(oldArgs) && !code.includes("Fix 12")) {
    code = code.replace(oldArgs, newArgs);
    console.log("Fix 12 (arguments validation): applied");
  } else {
    console.log("Fix 12: pattern not found or already applied");
  }

  writeFileSync(FILE, code, "utf8");
}

// === Fix 6: enforce MAX_ASSET_BYTES in download loop ===
{
  const FILE = "src/modules/autoupdate/AutoUpdateModule.ts";
  let code = readFileSync(FILE, "utf8");

  // Add size check after download
  const downloadPattern = `const content = await requestUrl({ url: asset.browser_download_url, method: "GET" });`;
  if (code.includes(downloadPattern) && !code.includes("MAX_ASSET_BYTES check")) {
    // Find the first occurrence (in the download loop)
    const idx = code.indexOf(downloadPattern);
    const endIdx = idx + downloadPattern.length;
    code = code.substring(0, endIdx) +
      `\n\t\t\t// Fix 6: enforce download size limit\n\t\t\tif (content.arrayBuffer.byteLength > MAX_ASSET_BYTES) {\n\t\t\t\tthrow new Error(\`Asset "${name}" excede o limite de ${MAX_ASSET_BYTES / 1024 / 1024} MB — download abortado por segurança.\`);\n\t\t\t}` +
      code.substring(endIdx);
    console.log("Fix 6 (download size limit): applied");
  } else {
    console.log("Fix 6: pattern not found or already applied");
  }

  writeFileSync(FILE, code, "utf8");
}

console.log("\nAll MCP + auto-update script fixes complete.");
