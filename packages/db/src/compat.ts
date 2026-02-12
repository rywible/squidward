import LibsqlDatabase from "libsql";

export interface DatabaseOptions {
  create?: boolean;
  strict?: boolean;
  readonly?: boolean;
  safeIntegers?: boolean;
}

interface QueryRunner {
  run: (...args: unknown[]) => unknown;
  get: (...args: unknown[]) => unknown;
  all: (...args: unknown[]) => unknown[];
}

export class Database {
  private readonly inner: LibsqlDatabase.Database;

  constructor(filename: string, options: DatabaseOptions = {}) {
    const fileMustExist = options.create === false;
    this.inner = new LibsqlDatabase(filename, {
      readonly: options.readonly ?? false,
      fileMustExist,
    });
    this.inner.pragma("foreign_keys = ON");
    this.inner.pragma("busy_timeout = 5000");
    if (options.safeIntegers) {
      this.inner.defaultSafeIntegers(true);
    }
  }

  query(sql: string): QueryRunner {
    const statement = this.inner.prepare(sql);
    return {
      run: (...args: unknown[]) => statement.run(...(args as [])),
      get: (...args: unknown[]) => statement.get(...(args as [])),
      all: (...args: unknown[]) => statement.all(...(args as [])),
    };
  }

  exec(sql: string): void {
    this.inner.exec(sql);
  }

  pragma(source: string): unknown {
    return this.inner.pragma(source);
  }

  close(): void {
    this.inner.close();
  }
}
