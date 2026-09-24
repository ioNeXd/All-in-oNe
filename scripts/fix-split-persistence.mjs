import { readFileSync, writeFileSync } from "node:fs";

const FILE = "src/core/SplitPersistence.ts";
let code = readFileSync(FILE, "utf8");

// Fix: move sliceVersion declaration BEFORE the null check, and fix the redundant check
// Current broken state has sliceVersion used before declaration

// Step 1: Fix the null check - use sliceVersion which is now declared first
code = code.replace(
  "if (sliceRaw === null && sliceVersion === null) {",
  "if (sliceVersion === null) {"
);

// Step 2: Move sliceVersion declaration before the null check
// Find the pattern: sliceRaw declared, then null check uses sliceVersion
const beforeNullCheck = `\t\t\t\t// Fix 15: distinguish missing, corrupted, and empty\n\t\t\t\tconst sliceRaw = info?.raw;\n\n\t\t\t\tif (sliceRaw === null) {`;
const afterFix = `\t\t\t\t// Fix 15: distinguish missing, corrupted, and empty\n\t\t\t\tconst sliceRaw = info?.raw;\n\t\t\t\tconst sliceVersion = info?.version ?? null;\n\n\t\t\t\tif (sliceRaw === null) {`;
code = code.replace(beforeNullCheck, afterFix);

// Step 3: Remove duplicate sliceVersion declaration
code = code.replace(
  "\t\t\t\tconst slice = sliceRaw;\n\t\t\t\tconst sliceVersion = info?.version ?? null;",
  "\t\t\t\tconst slice = sliceRaw;"
);

writeFileSync(FILE, code, "utf8");
console.log("SplitPersistence fix 15: variable ordering fixed");
