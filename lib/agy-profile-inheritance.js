// AGY accounts share native customization under the real Windows user home.
// API-key selection stays in agy-profiles; no credentials or global files are copied.
import path from "node:path";

export function agyUserContextRoots(userHome) {
  return {
    instructions: [path.join(userHome, ".gemini", "GEMINI.md")],
    skills: ["config/skills", "skills", "antigravity-cli/skills"].map(entry => path.join(userHome, ".gemini", entry)),
    plugins: [path.join(userHome, ".gemini", "config", "plugins")],
  };
}
