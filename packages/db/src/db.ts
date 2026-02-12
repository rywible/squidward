import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "./compat";

import type { DbHealth, SqliteConfig } from "./types";

const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MIGRATION_PATH = resolve(CURRENT_DIR, "../migrations/001_initial.sql");

export class PlatformDb {
  readonly db: Database;
  readonly path: string;

  constructor(config: SqliteConfig = {}) {
    const dbPath = config.path ?? ":memory:";
    this.path = dbPath;
    const options = {
      create: config.create ?? true,
      strict: config.strict ?? true,
      safeIntegers: config.safeIntegers ?? false
    };
    this.db = new Database(
      dbPath,
      config.readonly === undefined ? options : { ...options, readonly: config.readonly }
    );
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
  }

  init(migrationPath = DEFAULT_MIGRATION_PATH): void {
    const migrationSql = readFileSync(migrationPath, "utf8");
    this.db.exec(migrationSql);
  }

  health(): DbHealth {
    const journalMode = this.db.query("PRAGMA journal_mode;").get() as {
      journal_mode: string;
    };
    const busyTimeout = (this.db.query("PRAGMA busy_timeout;").get() as Record<string, unknown> | null) ?? {};
    const busyTimeoutMs = Number(
      busyTimeout.busy_timeout ?? busyTimeout.timeout ?? Object.values(busyTimeout)[0] ?? 0
    );

    return {
      path: this.path,
      journalMode: journalMode.journal_mode,
      busyTimeoutMs
    };
  }

  close(): void {
    this.db.close();
  }
}
