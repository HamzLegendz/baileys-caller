/**
 * SQLite-backed Baileys auth state using better-sqlite3.
 *
 * Drop-in replacement for `useMultiFileAuthState` — stores all auth keys
 * and credentials in a single SQLite database file.
 *
 * Key behavior mirrors the official useMultiFileAuthState exactly,
 * including app-state-sync-key proto decoding.
 *
 * @author HamzLegendz (modified from baileys-caller)
 */
import Database from "better-sqlite3";
import { resolve } from "node:path";
import { existsSync, mkdirSync } from "node:fs";

// Lazy Baileys import helper — resolves from the same node_modules as Baileys itself
const loadBaileys = async (): Promise<any> => {
  try {
    return await import("@whiskeysockets/baileys");
  } catch {
    throw new Error(
      "Could not import @whiskeysockets/baileys. Install it as a peer dependency.",
    );
  }
};

/**
 * Creates a Baileys-compatible auth state backed by a SQLite database.
 * @param dbPath - Path to the SQLite file (e.g. `./session.db`)
 */
export const useSQLiteAuthState = async (dbPath: string) => {
  const { initAuthCreds, BufferJSON, proto } = await loadBaileys();

  const resolvedPath = resolve(dbPath);
  const dir = resolvedPath.substring(0, resolvedPath.lastIndexOf("/"));
  if (dir && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const db = new Database(resolvedPath);

  // WAL mode for better concurrent read performance
  db.pragma("journal_mode = WAL");

  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS auth_creds (
      id   TEXT PRIMARY KEY,
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auth_keys (
      key_type TEXT NOT NULL,
      key_id   TEXT NOT NULL,
      data     TEXT NOT NULL,
      PRIMARY KEY (key_type, key_id)
    );
  `);

  const stmtGetCred = db.prepare<[string], { data: string }>(
    "SELECT data FROM auth_creds WHERE id = ?"
  );
  const stmtSetCred = db.prepare<[string, string]>(
    "INSERT OR REPLACE INTO auth_creds (id, data) VALUES (?, ?)"
  );
  const stmtGetKey = db.prepare<[string, string], { data: string }>(
    "SELECT data FROM auth_keys WHERE key_type = ? AND key_id = ?"
  );
  const stmtSetKey = db.prepare<[string, string, string]>(
    "INSERT OR REPLACE INTO auth_keys (key_type, key_id, data) VALUES (?, ?, ?)"
  );
  const stmtDelKey = db.prepare<[string, string]>(
    "DELETE FROM auth_keys WHERE key_type = ? AND key_id = ?"
  );

  const serialize   = (data: any): string => JSON.stringify(data, BufferJSON.replacer);
  const deserialize = (raw: string): any  => JSON.parse(raw, BufferJSON.reviver);

  // Load or create credentials
  const credsRow = stmtGetCred.get("creds");
  const creds    = credsRow ? deserialize(credsRow.data) : initAuthCreds();

  const state = {
    creds,
    keys: {
      get: async (type: string, ids: string[]) => {
        const result: Record<string, any> = {};
        for (const id of ids) {
          const row = stmtGetKey.get(type, id);
          if (row) {
            let val = deserialize(row.data);

            // Mirror useMultiFileAuthState: decode app-state-sync-key with proto
            if (type === "app-state-sync-key" && val) {
              val = proto.Message.AppStateSyncKeyData.fromObject(val);
            }

            result[id] = val;
          }
        }
        return result;
      },

      set: async (data: Record<string, Record<string, any>>) => {
        const setMany = db.transaction(() => {
          for (const [type, ids] of Object.entries(data)) {
            for (const [id, value] of Object.entries(ids ?? {})) {
              if (value != null) {
                stmtSetKey.run(type, id, serialize(value));
              } else {
                stmtDelKey.run(type, id);
              }
            }
          }
        });
        setMany();
      },
    },
  };

  const saveCreds = () => {
    stmtSetCred.run("creds", serialize(state.creds));
  };

  const closeDb = () => {
    try { db.close(); } catch {}
  };

  return { state, saveCreds, closeDb };
};
