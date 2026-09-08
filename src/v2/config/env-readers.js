export function readPositiveIntEnv(name, fallback, env = process.env) {
  const value = Number(env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export function readNonNegativeIntEnv(name, fallback, env = process.env) {
  const value = Number(env[name]);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

export function readCsvEnv(name, fallback = [], env = process.env) {
  const raw = env[name];
  if (raw === undefined || raw === null || !String(raw).trim()) {
    return [...fallback];
  }
  return [...new Set(String(raw).split(",").map((item) => item.trim()).filter(Boolean))];
}

export function readChoiceEnv(name, allowedValues, fallback, env = process.env) {
  const value = String(env[name] || "").trim().toLowerCase();
  return allowedValues.includes(value) ? value : fallback;
}
