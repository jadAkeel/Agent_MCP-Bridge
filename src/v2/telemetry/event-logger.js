const LOG_LEVELS = Object.freeze({ off: 0, error: 1, warn: 2, info: 3, debug: 4 });

export function createEventLogger({
  logLevel,
  sanitizeLogValue,
  getConsole = () => console,
}) {
  const configuredLevel = LOG_LEVELS[logLevel] ?? LOG_LEVELS.warn;

  function logEvent(level, event, data = {}) {
    const eventLevel = LOG_LEVELS[level] ?? LOG_LEVELS.info;
    if (configuredLevel < eventLevel) {
      return;
    }

    getConsole().error(JSON.stringify({
      ts: new Date().toISOString(),
      level,
      event,
      ...sanitizeLogValue(data),
    }));
  }

  return { logEvent };
}
