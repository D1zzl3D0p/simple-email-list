import type { Settings } from "./types";
export async function getSettings(db: D1Database): Promise<Settings> {
  const row = await db
    .prepare("SELECT * FROM settings WHERE id=1")
    .first<Settings>();
  if (!row) throw new Error("Settings missing; apply migrations");
  return row;
}
export function stmt(
  db: D1Database,
  sql: string,
  ...values: (string | number | null)[]
) {
  return db.prepare(sql).bind(...values);
}
export async function rows<T>(
  db: D1Database,
  sql: string,
  ...values: (string | number | null)[]
): Promise<T[]> {
  return (await stmt(db, sql, ...values).all<T>()).results;
}
export function invocationDatabase(db: D1Database, maximum = 39) {
  let used = 0;
  const binding = new Proxy(db, {
    get(target, key) {
      if (key === "prepare")
        return (sql: string) => {
          if (++used > maximum)
            throw Error("Invocation SQL budget exhausted; work retained");
          return target.prepare(sql);
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: binding, remaining: () => maximum - used };
}
