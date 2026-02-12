export interface SqliteConfig {
  path?: string;
  readonly?: boolean;
  create?: boolean;
  strict?: boolean;
  safeIntegers?: boolean;
}

export interface MigrationRecord {
  id: string;
  fileName: string;
  appliedAt: string;
}

export interface DbHealth {
  path: string;
  journalMode: string;
  busyTimeoutMs: number;
}
