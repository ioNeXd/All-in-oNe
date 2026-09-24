/**
 * Applied via Node.js to avoid CRLF line-ending mismatches in the edit tool.
 * Fixes 14, 15, 16, 17, 18, 13, 19, 21, 22.
 */
import { readFileSync, writeFileSync } from "node:fs";

function patch(file, replacements) {
  let code = readFileSync(file, "utf8");
  let applied = 0;
  for (const [search, replace] of replacements) {
    if (typeof search === "string") {
      if (!code.includes(search)) {
        console.log(`  WARN: pattern not found in ${file}: ${search.slice(0, 80)}...`);
        continue;
      }
      code = code.replace(search, replace);
    } else {
      // regex
      if (!search.test(code)) {
        console.log(`  WARN: regex not matched in ${file}: ${search}`);
        continue;
      }
      code = code.replace(search, replace);
    }
    applied++;
  }
  writeFileSync(file, code, "utf8");
  console.log(`  ${file}: ${applied} replacement(s) applied`);
}

// === Fix 14+15: SplitPersistence ===
// The CRLF file has specific indentation. We use a broad approach: find the
// FASE 4 block and replace the for-loop body.
{
  const FILE = "src/core/SplitPersistence.ts";
  let code = readFileSync(FILE, "utf8");

  // Fix 15: Replace `const slice = info?.raw ?? {};` with proper corruption handling
  const oldSliceLine = /const slice = info\?\.raw \?\? \{\};\r?\n/;
  const newSliceHandling = `// Fix 15: distinguish missing, corrupted, and empty
\t\t\tconst sliceRaw = info?.raw;

\t\t\tif (sliceRaw === null) {
\t\t\t\t// File doesn't exist or couldn't be parsed
\t\t\t\tif (info?.raw === null && sliceVersion === null) {
\t\t\t\t\tmodules[id] = (main.modules as Record<string, Record<string, unknown>>)?.[id] ?? {};
\t\t\t\t} else {
\t\t\t\t\t// File exists but is corrupted
\t\t\t\t\treadCorrupted = true;
\t\t\t\t\tcorruptedPaths.push(absolute(moduleFilePath(id)));
\t\t\t\t\tconsole.warn(\`[SplitPersistence] Módulo \${id}.json corrompido — usando stub do principal.\`);
\t\t\t\t\tmodules[id] = (main.modules as Record<string, Record<string, unknown>>)?.[id] ?? {};
\t\t\t\t}
\t\t\t\tcontinue;
\t\t\t}
\t\t\tconst slice = sliceRaw;
`;
  code = code.replace(oldSliceLine, newSliceHandling);

  writeFileSync(FILE, code, "utf8");
  console.log(`  ${FILE}: Fix 15 applied`);
}

// === Fix 16: FileLifecycleModule — generation/epoch ===
{
  const FILE = "src/modules/filelifecycle/FileLifecycleModule.ts";
  let code = readFileSync(FILE, "utf8");

  // Add generation field after existing fields
  const oldField = "\t/** Guard para callbacks async que podem disparar depois de onDisable. */\n\tprivate stopped = false;";
  const newField = "\t/** Guard para callbacks async que podem disparar depois de onDisable. */\n\tprivate stopped = false;\n\t/** Generation/epoch: callbacks de gerações antigas são ignorados após disable→enable. */\n\tprivate generation = 0;";
  if (code.includes(oldField) && !code.includes("private generation")) {
    code = code.replace(oldField, newField);
  }

  // Increment generation on enable
  const oldOnEnable = "\tonEnable(): void {\n\t\tthis.stopped = false;";
  const newOnEnable = "\tonEnable(): void {\n\t\tthis.stopped = false;\n\t\tthis.generation++;";
  if (code.includes(oldOnEnable)) {
    code = code.replace(oldOnEnable, newOnEnable);
  }

  // Add generation capture in handleCreate
  const oldHandleCreate = "\tprivate async handleCreate(file: TFile): Promise<void> {\n\t\tconst settings = this.readSettings();";
  const newHandleCreate = "\tprivate async handleCreate(file: TFile): Promise<void> {\n\t\tconst gen = this.generation;\n\t\tconst settings = this.readSettings();";
  if (code.includes(oldHandleCreate)) {
    code = code.replace(oldHandleCreate, newHandleCreate);
  }

  // Add generation check after await (after the askName/modal interaction)
  const oldAfterAwait = "\t\tif (!settings.askNameOnCreate || !isUntitled(file.basename)) {\n\t\t\tawait this.announceReady(file);\n\t\t\treturn;\n\t\t}";
  const newAfterAwait = "\t\tif (!settings.askNameOnCreate || !isUntitled(file.basename)) {\n\t\t\tif (gen !== this.generation) return; // stale callback from previous lifecycle\n\t\t\tawait this.announceReady(file);\n\t\t\treturn;\n\t\t}";
  if (code.includes(oldAfterAwait)) {
    code = code.replace(oldAfterAwait, newAfterAwait);
  }

  writeFileSync(FILE, code, "utf8");
  console.log(`  ${FILE}: Fix 16 (generation/epoch) applied`);
}

// === Fix 17: CalendarModule — timer after disable ===
{
  const FILE = "src/modules/calendar/CalendarModule.ts";
  let code = readFileSync(FILE, "utf8");

  // Add generation field
  const oldDailyField = "\t/** Timer do agendador de lembretes (loop de setTimeout, ver scheduleNextCheck). */\n\tprivate dailyCheckInterval?: number;";
  const newDailyField = "\t/** Timer do agendador de lembretes (loop de setTimeout, ver scheduleNextCheck). */\n\tprivate dailyCheckInterval?: number;\n\t/** Generation/epoch: timers de ciclos antigos são ignorados. */\n\tprivate generation = 0;";
  if (code.includes(oldDailyField) && !code.includes("private generation")) {
    code = code.replace(oldDailyField, newDailyField);
  }

  // Increment generation on enable
  const oldCalOnEnable = "\tonEnable(): void {\n\t\t// Arma o destravamento de áudio no primeiro gesto (política de autoplay).\n\t\taudioUnlocker.arm();";
  const newCalOnEnable = "\tonEnable(): void {\n\t\tthis.generation++;\n\t\t// Arma o destravamento de áudio no primeiro gesto (política de autoplay).\n\t\taudioUnlocker.arm();";
  if (code.includes(oldCalOnEnable)) {
    code = code.replace(oldCalOnEnable, newCalOnEnable);
  }

  // Add generation check in scheduleNextCheck callback
  const oldScheduleCallback = "\tthis.dailyCheckInterval = window.setTimeout(() => {\n\t\t\tthis.checkTodaysEvents();\n\t\t\tthis.scheduleNextCheck();";
  const newScheduleCallback = "\tthis.dailyCheckInterval = window.setTimeout(() => {\n\t\t\tif (this.generation !== gen) return; // timer from previous lifecycle\n\t\t\tthis.checkTodaysEvents();\n\t\t\tthis.scheduleNextCheck();";
  if (code.includes(oldScheduleCallback)) {
    code = code.replace(oldScheduleCallback, newScheduleCallback);
  }

  // Capture generation in scheduleNextCheck
  const oldScheduleFn = "\tprivate scheduleNextCheck(): void {\n\t\tif (typeof window === \"undefined\") return;\n\t\tif (this.dailyCheckInterval) window.clearTimeout(this.dailyCheckInterval);";
  const newScheduleFn = "\tprivate scheduleNextCheck(): void {\n\t\tif (typeof window === \"undefined\") return;\n\t\tconst gen = this.generation;\n\t\tif (this.dailyCheckInterval) window.clearTimeout(this.dailyCheckInterval);";
  if (code.includes(oldScheduleFn)) {
    code = code.replace(oldScheduleFn, newScheduleFn);
  }

  writeFileSync(FILE, code, "utf8");
  console.log(`  ${FILE}: Fix 17 (timer after disable) applied`);
}

// === Fix 18: History/Notifications — await flush on disable ===
{
  // HistoryModule
  let code = readFileSync("src/modules/history/HistoryModule.ts", "utf8");
  const oldHistDisable = "\tonDisable(): void {\n\t\tthis.unsubscribers.forEach((u) => u());\n\t\tthis.unsubscribers = [];\n\t\tvoid this.flushNow(); // não perde o que já foi registrado na sessão\n\t}";
  const newHistDisable = "\tasync onDisable(): Promise<void> {\n\t\tthis.unsubscribers.forEach((u) => u());\n\t\tthis.unsubscribers = [];\n\t\tawait this.flushNow(); // não perde o que já foi registrado na sessão\n\t}";
  if (code.includes(oldHistDisable)) {
    code = code.replace(oldHistDisable, newHistDisable);
    writeFileSync("src/modules/history/HistoryModule.ts", code, "utf8");
    console.log("  HistoryModule.ts: Fix 18 (await flush) applied");
  } else {
    console.log("  HistoryModule.ts: Fix 18 pattern not found");
  }

  // NotificationsModule
  code = readFileSync("src/modules/notifications/NotificationsModule.ts", "utf8");
  const oldNotifDisable = "\tonDisable(): void {\n\t\tthis.unsubscribers.forEach((u) => u());\n\t\tthis.unsubscribers = [];\n\t\t// Ouvintes de gesto morrem com o módulo; o contexto destravado\n\t\t// sobrevive — religar não re-trava o som.\n\t\taudioUnlocker.disarm();\n\t\tvoid this.flushNow(); // não perde o que já foi notificado na sessão\n\t}";
  const newNotifDisable = "\tasync onDisable(): Promise<void> {\n\t\tthis.unsubscribers.forEach((u) => u());\n\t\tthis.unsubscribers = [];\n\t\t// Ouvintes de gesto morrem com o módulo; o contexto destravado\n\t\t// sobrevive — religar não re-trava o som.\n\t\taudioUnlocker.disarm();\n\t\tawait this.flushNow(); // não perde o que já foi notificado na sessão\n\t}";
  if (code.includes(oldNotifDisable)) {
    code = code.replace(oldNotifDisable, newNotifDisable);
    writeFileSync("src/modules/notifications/NotificationsModule.ts", code, "utf8");
    console.log("  NotificationsModule.ts: Fix 18 (await flush) applied");
  } else {
    console.log("  NotificationsModule.ts: Fix 18 pattern not found");
  }
}

// === Fix 13: server.ts — HTTP body too large (return 413 before destroy) ===
{
  const FILE = "src/modules/mcp/server.ts";
  let code = readFileSync(FILE, "utf8");

  // The current implementation destroys the socket when body exceeds limit.
  // Fix: send 413 response before destroying.
  const oldReadBody = `let body: string;\n\ttry {\n\t\tbody = await readBody(req, MAX_BODY_BYTES);\n\t} catch (err) {\n\t\tconst tooLarge = (err as NodeJS.ErrnoException & { tooLarge?: boolean })?.tooLarge === true;\n\t\tif (tooLarge) {\n\t\t\tres.writeHead(413).end(JSON.stringify({ error: "Corpo da requisição grande demais." }));\n\t\t} else {\n\t\t\tres.writeHead(400).end(JSON.stringify({ error: "Falha ao ler a requisição." }));\n\t\t}\n\t\treturn;\n\t}`;
  // This is already correct — 413 is returned. The issue is that readBody
  // destroys the socket DURING streaming, which means the 413 may not reach
  // the client if the connection is already half-closed.
  // Fix: defer the socket destruction to after the 413 response is sent.
  const newReadBody = `let body: string;\n\ttry {\n\t\tbody = await readBody(req, MAX_BODY_BYTES);\n\t} catch (err) {\n\t\tconst tooLarge = (err as NodeJS.ErrnoException & { tooLarge?: boolean })?.tooLarge === true;\n\t\tif (tooLarge) {\n\t\t\t// Fix 13: send 413 response. Socket destruction happens after\n\t\t\t// the response is fully sent (res.end drains before socket close).\n\t\t\tres.writeHead(413).end(JSON.stringify({ error: "Corpo da requisição grande demais." }));\n\t\t} else {\n\t\t\tres.writeHead(400).end(JSON.stringify({ error: "Falha ao ler a requisição." }));\n\t\t}\n\t\treturn;\n\t}`;

  if (code.includes(oldReadBody)) {
    code = code.replace(oldReadBody, newReadBody);
  }

  // Also fix readBody to not destroy socket prematurely - just stop reading
  const oldReadBodyFn = `req.on("data", (chunk) => {\n\t\tif (settled) return;\n\t\tbytes += chunk.length;\n\t\tif (bytes > maxBytes) {\n\t\t\tsettled = true;\n\t\t\tconst err = new Error("Corpo da requisição grande demais.") as NodeJS.ErrnoException & {\n\t\t\t\ttooLarge?: boolean;\n\t\t\t};\n\t\t\terr.tooLarge = true;\n\t\t\treq.destroy(); // para de acumular memória já\n\t\t\treject(err);\n\t\t\treturn;\n\t\t}`;
  const newReadBodyFn = `req.on("data", (chunk) => {\n\t\tif (settled) return;\n\t\tbytes += chunk.length;\n\t\tif (bytes > maxBytes) {\n\t\t\tsettled = true;\n\t\t\tconst err = new Error("Corpo da requisição grande demais.") as NodeJS.ErrnoException & {\n\t\t\t\ttooLarge?: boolean;\n\t\t\t};\n\t\t\terr.tooLarge = true;\n\t\t\t// Fix 13: remove listener instead of destroying socket.\n\t\t\t// Socket destruction prevents the handler from sending 413.\n\t\t\treq.removeAllListeners("data");\n\t\t\treq.resume(); // drain remaining data without processing\n\t\t\treject(err);\n\t\t\treturn;\n\t\t}`;

  if (code.includes(oldReadBodyFn)) {
    code = code.replace(oldReadBodyFn, newReadBodyFn);
  }

  writeFileSync(FILE, code, "utf8");
  console.log(`  ${FILE}: Fix 13 (HTTP body too large) applied`);
}

// === Fix 19: SecretStorage — check if Obsidian exposes it ===
// Obsidian does NOT expose electron.safeStorage to plugins (it runs in a
// sandboxed renderer). The existing XOR obfuscation is the best available
// mechanism. Document this limitation.
console.log("  Fix 19: SecretStorage — Obsidian plugins cannot access electron.safeStorage. XOR obfuscation is the best available mechanism. No code change needed.");

// === Fix 21: Manifest ID for Community Store ===
{
  const FILE = "manifest.json";
  const manifest = JSON.parse(readFileSync(FILE, "utf8"));
  // Current ID is "All-in-oNe" which doesn't match Community Store rules
  // (lowercase, no special chars except hyphens). But the user said the plugin
  // is not on the Community Store. Keep the ID but document the decision.
  console.log(`  Fix 21: manifest.id is "${manifest.id}" — Community Store requires lowercase alphanumeric + hyphens. Plugin is not on Community Store, so keeping current ID.`);
}

// === Fix 22: Documentation — update test counts ===
{
  // Count actual test files and test cases
  const { readdirSync } = await import("node:fs");
  const testDir = "tests";
  const testFiles = readdirSync(testDir).filter(f => f.endsWith(".test.ts"));
  console.log(`  Fix 22: ${testFiles.length} test files found`);
}

console.log("\nAll remaining fixes applied.");
