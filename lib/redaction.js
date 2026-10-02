// Secret redaction and log sanitization.
// Extracted from server.js in modularization round M-001.

import { createHash } from "node:crypto";

// Body of a key block whose END line is missing (a truncated answer): base64 runs of 16+
// characters, at any wrap width, separated by blank space or by real or escaped line breaks
// (a key inside a JSON string carries the two characters \n, or \\n one level deeper, instead
// of a newline). Every scan is sticky and bounded, so it stays linear.
const PEM_BODY_GAP = /(?:[ \t\r\n]|\\{1,8}[rn])*/y;
const PEM_BODY_RUN = /[A-Za-z0-9+\/=]{16,}/y;
function pemBodyEnd(text, from) {
  let end = from;
  for (;;) {
    PEM_BODY_GAP.lastIndex = end;
    PEM_BODY_GAP.exec(text);
    PEM_BODY_RUN.lastIndex = PEM_BODY_GAP.lastIndex;
    if (!PEM_BODY_RUN.exec(text)) return end;
    end = PEM_BODY_RUN.lastIndex;
  }
}

// Private key blocks are cut in one forward pass: a lazy BEGIN...END regex rescanned the
// rest of the text from every unterminated BEGIN line, which is quadratic on agent output.
// An unterminated block (a truncated answer) loses its header and base64 body lines.
function redactPrivateKeyBlocks(text) {
  const begin = /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----/gi;
  const endMarker = /-----END [A-Z ]{0,40}PRIVATE KEY-----/gi;
  let output = "";
  let cursor = 0;
  let endSearchExhausted = false;
  for (let match = begin.exec(text); match; match = begin.exec(text)) {
    let blockEnd = -1;
    if (!endSearchExhausted) {
      endMarker.lastIndex = begin.lastIndex;
      const end = endMarker.exec(text);
      if (end) blockEnd = endMarker.lastIndex;
      else endSearchExhausted = true;
    }
    if (blockEnd < 0) blockEnd = pemBodyEnd(text, begin.lastIndex);
    output += `${text.slice(cursor, match.index)}[private key redacted]`;
    cursor = blockEnd;
    begin.lastIndex = cursor;
  }
  return output + text.slice(cursor);
}

// Gate for integration previews. redactSensitiveText() is deliberately greedy because it
// scrubs logs, where over-redaction is harmless; used as a patch gate it rejected ordinary
// code ("// Basic usage", "password = getpass()"), and a rejected preview gets no receipt,
// so the patch could never be integrated. This only matches values shaped like real
// credentials: key material, well-known token formats, and literal secrets assigned to
// credential-named keys.
const PRIVATE_KEY_HEADER = /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----/;
// Every repeat is bounded and every token pattern refuses to start inside a longer run:
// unbounded runs rescanned the rest of an agent answer from each position (seconds per
// answer, which freezes the bridge event loop). Key names need a digit+letter value and a
// real credential word, so lexer code such as token_type = TokenType.INT64 still passes.
export const LIKELY_SECRET_PATTERNS = [
  PRIVATE_KEY_HEADER,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{20,4096}=*/,
  // Base64 credentials almost always contain a digit; "Basic auth/authorization" does not.
  /\bBasic\s+(?=[A-Za-z0-9+\/]{0,512}[0-9])[A-Za-z0-9+\/]{12,4096}={0,2}(?![A-Za-z0-9+\/=])/,
  /(?<![A-Za-z0-9._-])(?:ya29\.[A-Za-z0-9._-]{20,4096}|1\/\/0[A-Za-z0-9._-]{20,4096})/,
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]{8,4096}(?![A-Za-z0-9_-])/,
  // sk-proj-..., sk-ant-...: dash form with a digit (CSS names like sk-spinner-plane pass).
  /(?<![A-Za-z0-9_-])(?:sk|rk|pk)-(?=[A-Za-z0-9_-]{0,256}[0-9])[A-Za-z0-9_-]{20,256}(?![A-Za-z0-9_-])/,
  // Stripe sk_live_/pk_test_...; plain identifiers like pk_index_for_table_1 pass.
  /(?<![A-Za-z0-9_])(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,256}(?![A-Za-z0-9])/,
  /(?<![A-Za-z0-9-])xox[baprs]-[A-Za-z0-9-]{10,512}(?![A-Za-z0-9-])/,
  /(?<![A-Za-z0-9_])(?:gh[pousr]_|github_pat_)[_A-Za-z0-9]{20,512}(?![A-Za-z0-9_])/,
  /(?<![A-Za-z0-9_])npm_[A-Za-z0-9]{36}(?![A-Za-z0-9])/,
  /(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{30,512}(?![A-Za-z0-9_-])/,
  /(?<![A-Z0-9])AKIA[0-9A-Z]{16}(?![A-Z0-9])/,
  // B-117: GitLab, Hugging Face, Google OAuth client secret, Slack app, SendGrid and PyPI tokens,
  // and Azure storage / Service Bus keys in a connection string. Each needs its prefix at a
  // boundary and a token-sized body.
  /(?<![A-Za-z0-9_-])glpat-[A-Za-z0-9_-]{20,256}(?![A-Za-z0-9_-])/,
  /(?<![A-Za-z0-9_])hf_[A-Za-z0-9]{30,256}(?![A-Za-z0-9_])/,
  /(?<![A-Za-z0-9_-])GOCSPX-[A-Za-z0-9_-]{20,256}(?![A-Za-z0-9_-])/,
  /(?<![A-Za-z0-9-])xapp-[A-Za-z0-9-]{10,512}(?![A-Za-z0-9-])/,
  /(?<![A-Za-z0-9_-])SG\.[A-Za-z0-9_-]{16,256}\.[A-Za-z0-9_-]{16,256}(?![A-Za-z0-9_-])/,
  /(?<![A-Za-z0-9_-])pypi-AgEI[A-Za-z0-9_-]{20,4096}(?![A-Za-z0-9_-])/,
  /(?<![A-Za-z0-9])(?:AccountKey|SharedAccessKey)=[A-Za-z0-9+\/]{40,1024}={0,2}(?![A-Za-z0-9+\/=])/i,
  /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]{1,64}\/B[A-Z0-9]{1,64}\/[A-Za-z0-9]{16,256}/,
  // scheme://user:password@host with a password that has a digit (not user:user@localhost).
  /\b[a-z][a-z0-9+.-]{0,30}:\/\/[^\s:\/@]{1,256}:(?=[^\s\/@]{0,256}[0-9])[^\s\/@]{6,256}@/i,
  // Quoted literal assigned to a credential-named key (not a suffix of a longer word such as
  // invalid_token); the value needs a letter and a digit, so "test-password" passes.
  /(?<![A-Za-z0-9])(?:authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|auth[-_]?token|password|passwd|secret|client[-_]?secret|credential|account[-_]?key|shared[-_]?access[-_]?key)["']?\s*[:=]\s*(["'])(?=[^"'\s]{0,256}[0-9])(?=[^"'\s]{0,256}[A-Za-z])[^"'\s]{8,256}\1/i,
  // Unquoted .env / YAML value that is the whole rest of the line (DB_PASSWORD=..., password:
  // ...). No dots in the value, so attribute access such as settings.API_KEY passes. The tail
  // is [ \t]* rather than \s*;?\s*: two adjacent \s* backtrack quadratically on a long run of
  // blanks, and every redactor applies this pattern to whole patches and logs (G-05 review).
  /(?:^\+?|\s)(?:export\s+)?[A-Za-z0-9_]{0,40}(?:password|passwd|secret|api_?key|access_?key|private_?key|auth_?token|access_?token|refresh_?token|credential)[A-Za-z0-9_]{0,40}\s*[:=]\s*(?=[^\s"'#]{0,256}[0-9])(?=[^\s"'#]{0,256}[A-Za-z])[^\s"'#(){}\[\].$,;]{8,256}[ \t]*(?:;[ \t]*)?(?:#.{0,256})?$/im,
];

// Agent answers quote code back to the coordinator. The greedy log redaction turned
// "password = getpass.getpass()" into "password = [redacted]", which misreports what the
// agent wrote. Only values shaped like real credentials are masked here; persisted
// records and logs keep the greedy redactSensitiveText().
const LIKELY_SECRET_GLOBAL_PATTERNS = LIKELY_SECRET_PATTERNS.map((pattern) => new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`));
export function redactLikelySecrets(value) {
  // Whole key blocks first: the header pattern alone left the base64 body in the answer.
  let text = redactPrivateKeyBlocks(String(value || ""));
  for (const pattern of LIKELY_SECRET_GLOBAL_PATTERNS) text = text.replace(pattern, "[credential redacted]");
  return text;
}

// Logs, diagnostics, stored results and stored patch previews. The broad rules below catch
// credential-named keys and short token forms the gate ignores; every shape the gate flags is
// then masked from the same LIKELY_SECRET_PATTERNS list, so a line the preview flags (or an
// operator accepts with acceptFlaggedSecretLines) cannot reach a log or a stored record.
const BROAD_LOG_REDACTIONS = [
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+=*/gi, "$1 [redacted]"],
  [/\b(?:ya29\.[A-Za-z0-9._-]+|1\/\/[A-Za-z0-9._-]+)\b/g, "[oauth token redacted]"],
  [/(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{1,8192}\.[A-Za-z0-9_-]{1,8192}\.[A-Za-z0-9_-]{1,8192}/g, "[jwt redacted]"],
  [/\b(?:sk|rk|pk|xox[baprs])-[_A-Za-z0-9-]{12,}\b/gi, "[credential redacted]"],
  [/\b(?:gh[pousr]_|github_pat_)[_A-Za-z0-9-]{12,}\b/g, "[github credential redacted]"],
  [/\bAIza[0-9A-Za-z_-]{20,}\b/g, "[google api key redacted]"],
  // B-117: kept in step with CLI_REDACTIONS in bin/ops-log.js.
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, "[gitlab token redacted]"],
  [/\bhf_[A-Za-z0-9]{30,}/g, "[hugging face token redacted]"],
  [/\bGOCSPX-[A-Za-z0-9_-]{20,}/g, "[google oauth client secret redacted]"],
  [/\bxapp-[A-Za-z0-9-]{10,}/g, "[slack app token redacted]"],
  [/\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, "[sendgrid key redacted]"],
  [/\bpypi-AgEI[A-Za-z0-9_-]{20,}/g, "[pypi token redacted]"],
  [/((?:"|')?(?:authorization|proxy-authorization|cookie|set-cookie|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|password|passwd|secret|client[-_]?secret|credential|accountkey|sharedaccesskey|contractorAuthorizationToken)(?:"|')?\s*[:=]\s*)((?:"[^"]*")|(?:'[^']*')|[^\s,;}]+)/gi, "$1[redacted]"],
  [/([?&](?:access_token|refresh_token|id_token|api_key|key|code|client_secret)=)[^&#\s]+/gi, "$1[redacted]"],
];
export function redactSensitiveText(value) {
  let text = redactPrivateKeyBlocks(String(value || ""));
  for (const [pattern, replacement] of BROAD_LOG_REDACTIONS) {
    text = text.replace(pattern, replacement);
  }
  for (const pattern of LIKELY_SECRET_GLOBAL_PATTERNS) text = text.replace(pattern, "[credential redacted]");
  return text;
}

// A key marker in an added line is a key when 40+ base64 characters of body follow it,
// however the file wraps them (OpenSSL wraps at 64, other tools at 32, 76 or not at all;
// the first version of this gate needed one 40-character line, so a 32-column PKCS#8 key
// passed). The body is read from the rest of the marker line (a JSON string holds the whole
// key with escaped \n) and from the added lines below it, which may be indented, quoted or
// followed by a comma; blank lines and RFC 1421 header fields (Proc-Type, DEK-Info) between
// the marker and the body are skipped. Each line is scanned by at most one marker.
const KEY_BODY_MIN_CHARS = 40;
const KEY_BODY_LOOKAHEAD_LINES = 64;
const KEY_BODY_LINE = /^\+[ \t]*["'`]?([A-Za-z0-9+\/=]+)(?:\\{1,8}[rn])*["'`]?[ \t]*[,;+]?[ \t]*$/;
const KEY_BODY_SKIPPED_LINE = /^\+[ \t]*(?:(?:Proc-Type|DEK-Info):.*)?$/;
const KEY_BODY_RUN = /[A-Za-z0-9+\/=]+/y;
const KEY_BODY_ESCAPED_BREAKS = /(?:\\{1,8}[rn])+/y;
function inlineKeyBodyChars(line, from) {
  let position = from;
  let chars = 0;
  for (;;) {
    KEY_BODY_ESCAPED_BREAKS.lastIndex = position;
    if (KEY_BODY_ESCAPED_BREAKS.exec(line)) position = KEY_BODY_ESCAPED_BREAKS.lastIndex;
    KEY_BODY_RUN.lastIndex = position;
    const run = KEY_BODY_RUN.exec(line);
    if (!run) return chars;
    chars += run[0].length;
    position = KEY_BODY_RUN.lastIndex;
  }
}
function patchKeyBodyChars(lines, index) {
  const header = PRIVATE_KEY_HEADER.exec(lines[index]);
  let chars = inlineKeyBodyChars(lines[index], header.index + header[0].length);
  const last = Math.min(lines.length - 1, index + KEY_BODY_LOOKAHEAD_LINES);
  for (let next = index + 1; chars < KEY_BODY_MIN_CHARS && next <= last; next += 1) {
    if (KEY_BODY_SKIPPED_LINE.test(lines[next])) continue;
    const body = KEY_BODY_LINE.exec(lines[next]);
    if (!body) break;
    chars += body[1].length;
  }
  return chars;
}

export function patchLikelySecretLines(patchText) {
  const hits = [];
  const lines = String(patchText || "").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    // Only added lines introduce new content; context and removed lines already exist.
    // "+++ b/..." is a file header; an added line that itself starts with "++" is content.
    if (!line.startsWith("+") || /^\+\+\+ (?:b\/|\/dev\/null)/.test(line)) continue;
    const keyHeader = PRIVATE_KEY_HEADER.test(line);
    if (keyHeader) {
      // A test comment naming the header is not a key; a key body after it is.
      if (patchKeyBodyChars(lines, index) >= KEY_BODY_MIN_CHARS) hits.push(index + 1);
      continue;
    }
    if (LIKELY_SECRET_PATTERNS.some((pattern) => pattern.test(line))) hits.push(index + 1);
  }
  return hits;
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
      if (/prompt|stdout|stderr|env|token|secret|password|api[-_]?key/i.test(key)) {
        continue;
      }
      if (/^(?:error|detail|reason|message)$/i.test(key) && typeof childValue === "string") {
        safe[`${key}Sha256`] = createHash("sha256").update(childValue).digest("hex");
        safe[`${key}Chars`] = childValue.length;
        continue;
      }
      safe[key] = sanitizeLogValue(childValue, depth + 1);
    }
    return safe;
  }

  return String(value);
}

const FAILED_ANSWER_SUMMARY_CHARS = 400;

export function failureSummary(text) {
  return redactSensitiveText(String(text ?? "").slice(0, 16_000)).slice(0, FAILED_ANSWER_SUMMARY_CHARS);
}
