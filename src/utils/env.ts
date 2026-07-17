/**
 * Loads .env into process.env as an import side effect. Import this FIRST,
 * before any module that might read an API key:
 *
 *   import "../utils/env.js";   // must precede the imports below
 *   import { Command } from "commander";
 *
 * It is a side-effecting import rather than an exported function call on
 * purpose. ESM hoists imports, so a `loadEnv()` statement sitting between
 * import lines would still run *after* every imported module body — leaving
 * any module-level `process.env` read seeing nothing. Ordering the import
 * itself is the only placement the language actually guarantees.
 *
 * Why not `node --env-file`: the published bin runs via a bare
 * `#!/usr/bin/env node` shebang, which can't carry the flag, and Node rejects
 * --env-file inside NODE_OPTIONS. A flag on the npm scripts would only cover
 * `npm start` and leave an installed `cutcli` keyless.
 *
 * Real environment variables win — loadEnvFile does not overwrite a var that
 * is already set, so `GEMINI_API_KEY=... cutcli` still overrides the file and
 * CI secrets are unaffected.
 *
 * Resolution is CWD-relative: this finds ./.env, not an .env next to the
 * installed bin. Running `cutcli` from outside a directory containing .env
 * picks up nothing and each tool reports its own "not set". If cutcli grows
 * a global config (the arch doc sketches ~/.cutcli/), a fallback to
 * ~/.cutcli/.env belongs here.
 *
 * A missing or unreadable .env is not an error: each tool raises its own
 * "<KEY> is not set" message, which is more actionable than a loader stack
 * trace from a process that hasn't done anything yet.
 */
try {
  process.loadEnvFile();
} catch {
  // No .env (or unreadable) — fall through to the ambient environment.
}
