// Shared production truncators. Every marker is included in the character budget.
export function truncateText(value, limit = 12000) {
  const text = String(value || "");
  if (text.length <= limit) return text;
  const marker = "\n... [truncated]";
  return `${text.slice(0, Math.max(0, limit - marker.length))}${marker}`.slice(0, limit);
}

export function truncateResultText(value, limit = 24000) {
  const text = String(value || "");
  if (text.length <= limit) return text;
  const marker = `\n... [${text.length} characters in total; the middle was truncated] ...\n`;
  const room = Math.max(0, limit - marker.length);
  const head = Math.floor(room * 0.3);
  const tail = room - head;
  return `${text.slice(0, head)}${marker}${tail ? text.slice(-tail) : ""}`.slice(0, limit);
}

// Older records may advertise detail that the audit's combined cap discarded.
// These replacements only shorten text, so correcting the pointer cannot break its cap.
export function honestResultPointers(text) {
  return String(text || "").replace(/^(?:Run id:|Worktree patch preview:)[^\r\n]*/gm, line => line
    .replaceAll("returns the full bridge block", "retrieves retained detail")
    .replaceAll("returns the stored preview", "retrieves retained preview"));
}

// Reports retain an unbroken prefix. Large diagnostics are shortened before a report
// that fits; reportTruncated describes only characters actually removed from the report.
export function fitResultParts({ head = "", report = "", tail = "" }, limit = 24000) {
  const join = (...parts) => parts.filter(Boolean).join("\n");
  const whole = join(head, report, tail);
  if (whole.length <= limit) return { text: whole, chars: whole.length, reportTruncated: false };
  const marker = omitted => `\n... [the agent's report was cut here: ${omitted} of ${report.length} characters omitted at its end; the result is limited to ${limit} characters (CODEX_OPENCODE_QUEUE_RESULT_MAX_CHARS)] ...`;
  const diagnosticBudget = report.length <= limit - 200
    ? Math.max(0, limit - report.length - 2)
    : Math.min(head.length + tail.length, Math.floor(limit * 0.6));
  // Preserve short verdicts on either side rather than letting a large path/diagnostic
  // block consume the other side's budget.
  const tailBudget = Math.min(tail.length, Math.max(Math.floor(diagnosticBudget / 2), diagnosticBudget - head.length));
  const usedTail = truncateResultText(tail, tailBudget);
  const usedHead = truncateResultText(head, Math.max(0, diagnosticBudget - usedTail.length));
  const room = Math.max(0, limit - usedHead.length - usedTail.length - (usedHead ? 1 : 0) - (usedTail ? 1 : 0));
  if (report.length <= room) return { text: join(usedHead, report, usedTail), chars: whole.length, reportTruncated: false };
  const keep = Math.max(0, room - marker(report.length).length);
  const cutReport = `${report.slice(0, keep)}${marker(report.length - keep)}`.slice(0, room);
  return { text: join(usedHead, cutReport, usedTail), chars: whole.length, reportTruncated: keep < report.length };
}
