declare module 'node:sqlite' {
  type SQLInputValue = null | number | bigint | string | Uint8Array;
  type SQLOutputValue = null | number | bigint | string | Uint8Array;

  interface StatementResultingChanges {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  }

  interface StatementSync {
    run(...params: SQLInputValue[]): StatementResultingChanges;
    get(...params: SQLInputValue[]): Record<string, SQLOutputValue> | undefined;
    all(...params: SQLInputValue[]): Record<string, SQLOutputValue>[];
    expandedSQL(): string;
    sourceSQL(): string;
  }

  interface DatabaseSyncOptions {
    open?: boolean;
    readOnly?: boolean;
    enableForeignKeyConstraints?: boolean;
    allowExtension?: boolean;
    enableLoadExtension?: boolean;
  }

  class DatabaseSync {
    constructor(location: string, options?: DatabaseSyncOptions);
    open(): void;
    close(): void;
    prepare(sql: string): StatementSync;
    exec(sql: string): void;
  }

  export { DatabaseSync, StatementSync, SQLInputValue, SQLOutputValue };
}
