import { readFileSync, writeFileSync } from "node:fs";

const FILE = "src/modules/mcp/McpModule.ts";
let code = readFileSync(FILE, "utf8");

// Fix 8: regex - [^s"'] → [^\\s"']
code = code.replace(
  /let safe = msg\.replace\(\[A-Z\]:\\\\\[\^s"\]\+/g,
  'let safe = msg.replace(/[A-Z]:\\\\[^\\s"\']+/g'
);

// Fix 7: sanitizeMcpError in error catch path
code = code.replace(
  /return \{ ok: false, error: String\(err\) \};\s*\}\s*\}\s*$/,
  'return { ok: false, error: sanitizeMcpError(String(err)) };\n\t\t}\n\t}'
);

// Fix 11: append_note - lookup inside lock
code = code.replace(
  /case "append_note": \{\s*const path = validateVaultPath\(String\(args\.path\)\);\s*const file = vault\.getAbstractFileByPath\(path\);\s*if \(\!\(file instanceof TFileClass\)\) throw new Error\("Nota não encontrada\."\);\s*await write\(path, \(\) => vault\.append\(file as TFile, String\(args\.content \?\? ""\)\)\);\s*return \{ path \};\s*\}/,
  `case "append_note": {
\t\t\t\tconst path = validateVaultPath(String(args.path));
\t\t\t\t// Lookup + mutação DENTRO do lock.
\t\t\t\tawait write(path, async () => {
\t\t\t\t\tconst file = vault.getAbstractFileByPath(path);
\t\t\t\t\tif (!(file instanceof TFileClass)) throw new Error("Nota não encontrada.");
\t\t\t\t\tawait vault.append(file as TFile, String(args.content ?? ""));
\t\t\t\t});
\t\t\t\treturn { path };
\t\t\t}`
);

// Fix 11: edit_note - lookup inside lock
code = code.replace(
  /case "edit_note": \{\s*const path = validateVaultPath\(String\(args\.path\)\);\s*const file = vault\.getAbstractFileByPath\(path\);\s*if \(\!\(file instanceof TFileClass\)\) throw new Error\("Nota não encontrada\."\);\s*await write\(path, \(\) => vault\.modify\(file as TFile, String\(args\.content \?\? ""\)\)\);\s*return \{ path \};\s*\}/,
  `case "edit_note": {
\t\t\t\tconst path = validateVaultPath(String(args.path));
\t\t\t\t// Lookup + mutação DENTRO do lock.
\t\t\t\tawait write(path, async () => {
\t\t\t\t\tconst file = vault.getAbstractFileByPath(path);
\t\t\t\t\tif (!(file instanceof TFileClass)) throw new Error("Nota não encontrada.");
\t\t\t\t\tawait vault.modify(file as TFile, String(args.content ?? ""));
\t\t\t\t});
\t\t\t\treturn { path };
\t\t\t}`
);

// Fix 11: delete_note - lookup inside lock
code = code.replace(
  /case "delete_note": \{\s*const path = validateVaultPath\(String\(args\.path\)\);\s*const file = vault\.getAbstractFileByPath\(path\);\s*if \(\!file\) throw new Error\("Nota não encontrada\."\);\s*await write\(path, \(\) => vault\.trash\(file, true\)\);.+\n\s*return \{ path \};\s*\}/,
  `case "delete_note": {
\t\t\t\tconst path = validateVaultPath(String(args.path));
\t\t\t\t// Lookup + exclusão DENTRO do lock.
\t\t\t\tawait write(path, async () => {
\t\t\t\t\tconst file = vault.getAbstractFileByPath(path);
\t\t\t\t\tif (!file) throw new Error("Nota não encontrada.");
\t\t\t\t\tawait vault.trash(file, true);
\t\t\t\t});
\t\t\t\treturn { path };
\t\t\t}`
);

// Fix 10: split_note - read inside lock (protect read+validate+create with lock)
const splitOld = /case "split_note": \{[\s\S]*?const file = vault\.getAbstractFileByPath\(path\);\s*if \(\!\(file instanceof TFileClass\)\) throw new Error\("Nota não encontrada\."\);\s*const level = Number\(args\.headingLevel \?\? 2\);\s*const marker = "#"\.repeat\(level\) \+ " ";\s*const content = await vault\.read\(file as TFile\);/;
const splitNew = `case "split_note": {
\t\t\t\t// Divide a nota em várias, quebrando nos headings do nível indicado.
\t\t\t\tconst path = validateVaultPath(String(args.path));
\t\t\t\tconst level = Number(args.headingLevel ?? 2);
\t\t\t\tconst marker = "#".repeat(level) + " ";`;
code = code.replace(splitOld, splitNew);

writeFileSync(FILE, code, "utf8");
console.log("McpModule.ts fixes applied.");
