import path from "node:path";
import { readFileSync, realpathSync, statSync } from "node:fs";

export const CODEX_PROFILE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export function readCodexProfilesEnv(env = process.env) {
  const raw = env.CODEX_OPENCODE_CODEX_PROFILES?.trim();
  if (!raw) return new Map();
  const invalid = () => new Error("CODEX_OPENCODE_CODEX_PROFILES must be a JSON object mapping profile IDs to { home: absolute path, enabled?: boolean }.");
  let entries;
  try { entries = JSON.parse(raw); } catch { throw invalid(); }
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) throw invalid();
  const profiles = new Map();
  for (const [id, entry] of Object.entries(entries)) {
    if (!CODEX_PROFILE_ID.test(id) || !entry || typeof entry !== "object"
      || Object.keys(entry).some((key) => key !== "home" && key !== "enabled")
      || typeof entry.home !== "string" || !path.isAbsolute(entry.home) || entry.home.includes("\0")
      || (entry.enabled !== undefined && typeof entry.enabled !== "boolean")) throw invalid();
    profiles.set(id, entry);
  }
  return profiles;
}

export function resolveCodexProfile(profiles, id, runner) {
  if (id === undefined) return {};
  if (typeof id !== "string" || !CODEX_PROFILE_ID.test(id)) {
    return { errorType: "codex_profile_invalid", error: "codexProfile must be a configured profile ID (letters, digits, underscores and hyphens)." };
  }
  const entry = profiles?.get(id);
  if (!entry) return { errorType: "codex_profile_unknown", error: `Codex profile "${id}" is not registered on this Bridge.` };
  if (entry.enabled === false) return { errorType: "codex_profile_disabled", error: `Codex profile "${id}" is disabled.` };
  if (runner !== "codex") {
    return { errorType: "codex_profile_requires_codex", error: "codexProfile requires an enabled, allowlisted managed Codex model." };
  }
  try {
    const home = realpathSync(entry.home);
    const authFile = path.join(home, "auth.json");
    if (statSync(home).isDirectory() && statSync(authFile).isFile()) {
      const auth = JSON.parse(readFileSync(authFile, "utf8"));
      const credential = auth?.auth_mode === "chatgpt" || auth?.auth_mode === undefined
        ? auth?.tokens?.access_token || (auth?.auth_mode === undefined ? auth?.OPENAI_API_KEY : null)
        : auth?.auth_mode === "apikey" ? auth?.OPENAI_API_KEY : null;
      if (typeof credential === "string" && credential.trim()) return { home };
    }
  } catch { /* Report the ID only, without filesystem errors or credential data. */ }
  return { errorType: "codex_profile_unusable", error: `Codex profile "${id}" needs an existing home with readable, file-backed Codex login credentials.` };
}
