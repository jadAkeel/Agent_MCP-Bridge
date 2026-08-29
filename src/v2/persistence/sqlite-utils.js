export function ensureTableColumn(db, table, column, definition) {
  const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((item) => item.name));
  if (!columns.has(column)) {
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    } catch (error) {
      if (!/duplicate column name/i.test(error.message || String(error))) throw error;
    }
  }
}

export function closeDb(db) {
  try {
    db.close();
  } catch {
    // Nothing useful to do during cleanup.
  }
}
