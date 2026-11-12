// The tables and columns of Lumiverse's database that the database reader reads, each with the type
// Lumiverse declares it with (its `src/db/baseline.sql`), and the check of a file against them. The
// reader maps a row by what these columns mean in the Lumiverse it was written for: a file whose
// columns say otherwise was made by another Lumiverse, and the reader reads none of it rather than
// guess. A column the reader doesn't read may come and go as Lumiverse likes.

import type { Database } from "bun:sqlite";

/** Each table the reader reads, and each column of it that it reads, with the type Lumiverse declares the column with. */
export const READ_COLUMNS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  chats: { id: "TEXT", user_id: "TEXT", character_id: "TEXT", name: "TEXT", metadata: "TEXT", updated_at: "INTEGER" },
  messages: {
    id: "TEXT",
    chat_id: "TEXT",
    index_in_chat: "INTEGER",
    is_user: "INTEGER",
    name: "TEXT",
    content: "TEXT",
    send_date: "INTEGER",
    swipe_id: "INTEGER",
    swipes: "TEXT",
    extra: "TEXT",
    created_at: "INTEGER",
    revision: "INTEGER",
  },
  world_books: { id: "TEXT", user_id: "TEXT", name: "TEXT", description: "TEXT", metadata: "TEXT", updated_at: "INTEGER" },
  world_book_entries: {
    id: "TEXT",
    world_book_id: "TEXT",
    key: "TEXT",
    keysecondary: "TEXT",
    content: "TEXT",
    comment: "TEXT",
    role: "TEXT",
    order_value: "INTEGER",
    constant: "INTEGER",
    disabled: "INTEGER",
    use_regex: "INTEGER",
    vectorized: "INTEGER",
    extensions: "TEXT",
    revision: "INTEGER",
    updated_at: "INTEGER",
  },
};

const TABLES = Object.keys(READ_COLUMNS);

/** Every column of the tables read, as SQLite reports the schema: one statement, so one moment of it. */
const COLUMNS = `WITH t(name) AS (VALUES ${TABLES.map(() => "(?)").join(", ")})
  SELECT t.name AS tbl, c.name AS col, c.type AS type FROM t LEFT JOIN pragma_table_info(t.name) AS c`;

/** What the file declares for the tables read: each table's columns with their declared types; a table the file lacks has none. */
export function columnsOf(db: Database): Map<string, Map<string, string>> {
  const found = new Map<string, Map<string, string>>(TABLES.map((table) => [table, new Map()]));
  for (const row of db.query<{ tbl: string; col: string | null; type: string | null }, string[]>(COLUMNS).all(...TABLES)) {
    if (row.col !== null) found.get(row.tbl)?.set(row.col, row.type ?? "");
  }
  return found;
}

/**
 * How the file differs from what the reader reads, in one plain sentence naming the table and the
 * column; null when every column read is there as Lumiverse declares it. Columns the reader doesn't
 * read are no difference, and a declared type is compared in any case, as SQLite takes it.
 */
export function differenceOf(found: ReadonlyMap<string, ReadonlyMap<string, string>>): string | null {
  const differences: string[] = [];
  for (const [table, columns] of Object.entries(READ_COLUMNS)) {
    const has = found.get(table);
    if (has === undefined || has.size === 0) {
      differences.push(`Lumiverse's database has no table "${table}"`);
      continue;
    }
    for (const [column, type] of Object.entries(columns)) {
      const actual = has.get(column)?.trim().toUpperCase();
      if (actual === undefined) differences.push(`table "${table}" in Lumiverse's database has no column "${column}"`);
      else if (actual !== type) differences.push(`column "${column}" of table "${table}" in Lumiverse's database is declared ${actual === "" ? "with no type" : actual} where the reader reads it as ${type}`);
    }
  }
  const [first, ...more] = differences;
  if (first === undefined) return null;
  return more.length === 0 ? first : `${first} (and ${more.length} more ${more.length === 1 ? "difference" : "differences"} like it)`;
}
