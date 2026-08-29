import { createHash } from "node:crypto";

export function redactSensitiveText(value) {
  let text = String(value || "");
  const replacements = [
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi, "[private key redacted]"],
    [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+=*/gi, "$1 [redacted]"],
    [/\b(?:ya29\.[A-Za-z0-9._-]+|1\/\/[A-Za-z0-9._-]+)\b/g, "[oauth token redacted]"],
    [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[jwt redacted]"],
    [/\b(?:sk|rk|pk|ghp|gho|github_pat|xox[baprs])-[_A-Za-z0-9-]{12,}\b/gi, "[credential redacted]"],
    [/\bAIza[0-9A-Za-z_-]{20,}\b/g, "[google api key redacted]"],
    [/((?:"|')?(?:authorization|proxy-authorization|cookie|set-cookie|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|password|passwd|secret|client[-_]?secret|credential|contractorAuthorizationToken)(?:"|')?\s*[:=]\s*)((?:"[^"]*")|(?:'[^']*')|[^\s,;}]+)/gi, "$1[redacted]"],
    [/([?&](?:access_token|refresh_token|id_token|api_key|key|code|client_secret)=)[^&#\s]+/gi, "$1[redacted]"],
  ];
  for (const [pattern, replacement] of replacements) {
    text = text.replace(pattern, replacement);
  }
  return text;
}

export function sanitizePersistedValue(value, depth = 0) {
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return redactSensitiveText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizePersistedValue(item, depth + 1));
  }
  if (typeof value === "object") {
    const safe = {};
    for (const [key, child] of Object.entries(value)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        continue;
      }
      if (/token|secret|password|credential|api[-_]?key|authorization|cookie/i.test(key)) {
        continue;
      }
      if (/^(task|prompt|messages|input)$/i.test(key)) {
        const raw = String(child || "");
        safe[`${key}Sha256`] = createHash("sha256").update(raw).digest("hex");
        safe[`${key}Chars`] = raw.length;
        continue;
      }
      safe[key] = sanitizePersistedValue(child, depth + 1);
    }
    return safe;
  }
  return redactSensitiveText(String(value));
}

export function sanitizeLogValue(value, depth = 0) {
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const redacted = redactSensitiveText(value);
    return redacted.length > 1000 ? `${redacted.slice(0, 1000)}...` : redacted;
  }

  if (Array.isArray(value)) {
    if (depth > 2) {
      return `[${value.length} items]`;
    }
    return value.map((item) => sanitizeLogValue(item, depth + 1));
  }

  if (typeof value === "object") {
    if (depth > 2) {
      return "[object]";
    }

    const safe = {};
    for (const [key, childValue] of Object.entries(value)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        continue;
      }
      if (/prompt|stdout|stderr|env|token|secret|password|api[-_]?key/i.test(key)) {
        continue;
      }
      safe[key] = sanitizeLogValue(childValue, depth + 1);
    }
    return safe;
  }

  return String(value);
}
