import { readFileSync, writeFileSync } from "node:fs";

const FILE = "src/core/SplitPersistence.ts";
let code = readFileSync(FILE, "utf8");

// Find the FASE 4 section and replace everything from "FASE 4" to the end of the for-loop
// that processes SPLIT_MODULE_IDS (before "const { [VERSION_KEY]: _mainV")
const fase4Start = code.indexOf("// FASE 4: Reconstitui fatias");
const mainVLine = code.indexOf("const { [VERSION_KEY]: _mainV");

if (fase4Start < 0 || mainVLine < 0) {
  console.error("Could not find FASE 4 boundaries");
  process.exit(1);
}

// Get the indentation from the line before FASE 4
const lineBefore = code.lastIndexOf("\n", fase4Start);
const indent = code.substring(lineBefore + 1, fase4Start).replace(/\S.*/, "");

const newFase4 = `${indent}// FASE 4: Reconstitui fatias — aceita APENAS versão == máximo.\n` +
`${indent}const modules: Record<string, Record<string, unknown>> = {\n` +
`${indent}\t...(main.modules as Record<string, Record<string, unknown>> ?? {}),\n` +
`${indent}};\n` +
`\n` +
`${indent}for (const id of SPLIT_MODULE_IDS) {\n` +
`${indent}\tconst info = sliceData.get(id);\n` +
`${indent}\tconst sliceRaw = info?.raw;\n` +
`${indent}\tconst sliceVersion = info?.version ?? null;\n` +
`\n` +
`${indent}\t// Fix 15: distinguish missing, corrupted, and empty\n` +
`${indent}\tif (sliceRaw === null) {\n` +
`${indent}\t\t// File doesn't exist or couldn't be parsed\n` +
`${indent}\t\treadCorrupted = true;\n` +
`${indent}\t\tcorruptedPaths.push(absolute(moduleFilePath(id)));\n` +
`${indent}\t\tconsole.warn(\`[SplitPersistence] Módulo \${id}.json corrompido — usando stub do principal.\`);\n` +
`${indent}\t\tmodules[id] = (main.modules as Record<string, Record<string, unknown>>)?.[id] ?? {};\n` +
`${indent}\t\tcontinue;\n` +
`${indent}\t}\n` +
`\n` +
`${indent}\t// Fix 14: don't silently combine mismatched versions\n` +
`${indent}\tif (maxVersion != null && sliceVersion != null && sliceVersion < maxVersion) {\n` +
`${indent}\t\tconsole.warn(\n` +
`${indent}\t\t\t\`[SplitPersistence] Módulo \${id}.json obsoleto: _v=\${sliceVersion} < máximo=\${maxVersion}. \` +\n` +
`${indent}\t\t\t"Usando stub do principal."\n` +
`${indent}\t\t);\n` +
`${indent}\t\tmodules[id] = {};\n` +
`${indent}\t\tcontinue;\n` +
`${indent}\t}\n` +
`\n` +
`${indent}\tif (sliceVersion != null && mainVersion != null && sliceVersion > mainVersion) {\n` +
`${indent}\t\tdetectedVersion = sliceVersion;\n` +
`${indent}\t}\n` +
`\n` +
`${indent}\t// Remove _v antes de merge — campo é meta, não dado do módulo.\n` +
`${indent}\tconst { [VERSION_KEY]: _sv, ...cleanSlice } = sliceRaw;\n` +
`${indent}\tvoid _sv;\n` +
`${indent}\tmodules[id] = cleanSlice;\n` +
`${indent}}\n`;

code = code.substring(0, fase4Start) + newFase4 + code.substring(mainVLine);
writeFileSync(FILE, code, "utf8");
console.log("SplitPersistence FASE 4 rewritten cleanly");
