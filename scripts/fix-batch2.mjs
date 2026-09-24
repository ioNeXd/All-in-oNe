import { readFileSync, writeFileSync } from "node:fs";

// === Fix 6: enforce MAX_ASSET_BYTES in download loop ===
{
  const FILE = "src/modules/autoupdate/AutoUpdateModule.ts";
  let code = readFileSync(FILE, "utf8");

  const downloadPattern = 'const content = await requestUrl({ url: asset.browser_download_url, method: "GET" });';
  if (code.includes(downloadPattern) && !code.includes("MAX_ASSET_BYTES check")) {
    const idx = code.indexOf(downloadPattern);
    const endIdx = idx + downloadPattern.length;
    const sizeCheck = '\n\t\t\t// Fix 6: enforce download size limit\n' +
      '\t\t\tif (content.arrayBuffer.byteLength > MAX_ASSET_BYTES) {\n' +
      '\t\t\t\tthrow new Error(`Asset "' + '${name}' + '" excede o limite de ' + '${MAX_ASSET_BYTES / 1024 / 1024}' + ' MB — download abortado por segurança.`);\n' +
      '\t\t\t}';
    code = code.substring(0, endIdx) + sizeCheck + code.substring(endIdx);
    console.log("Fix 6 (download size limit): applied");
  } else {
    console.log("Fix 6: pattern not found or already applied");
  }

  writeFileSync(FILE, code, "utf8");
}

// === Fix 11: delete_note lookup inside lock ===
{
  const FILE = "src/modules/mcp/McpModule.ts";
  let code = readFileSync(FILE, "utf8");

  // Check if delete_note still has lookup before lock
  const deletePattern = 'case "delete_note": {\n\t\t\t\tconst path = validateVaultPath(String(args.path));\n\t\t\t\tconst file = vault.getAbstractFileByPath(path);\n\t\t\t\tif (!file) throw new Error("Nota não encontrada.");';
  if (code.includes(deletePattern)) {
    // Find the full delete_note case
    const idx = code.indexOf(deletePattern);
    // Find closing of the case (return { path }; })
    const rest = code.substring(idx);
    const returnIdx = rest.indexOf('return { path };\n\t\t\t}');
    if (returnIdx >= 0) {
      const endIdx = idx + returnIdx + 'return { path };\n\t\t\t}'.length;
      const replacement = 'case "delete_note": {\n' +
        '\t\t\t\tconst path = validateVaultPath(String(args.path));\n' +
        '\t\t\t\t// Lookup + exclusão DENTRO do lock.\n' +
        '\t\t\t\tawait write(path, async () => {\n' +
        '\t\t\t\t\tconst file = vault.getAbstractFileByPath(path);\n' +
        '\t\t\t\t\tif (!file) throw new Error("Nota não encontrada.");\n' +
        '\t\t\t\t\tawait vault.trash(file, true); // lixeira, nunca exclusão direta\n' +
        '\t\t\t\t});\n' +
        '\t\t\t\treturn { path };\n' +
        '\t\t\t}';
      code = code.substring(0, idx) + replacement + code.substring(endIdx);
      console.log("Fix 11 (delete_note): applied");
    }
  } else {
    console.log("Fix 11 (delete_note): already fixed or pattern not found");
  }

  writeFileSync(FILE, code, "utf8");
}

console.log("\nBatch 2 fixes complete.");
