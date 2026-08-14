/**
 * A minimal Kysely dialect over `bun:sqlite` (the driver the spec pins, §3).
 * Kysely's built-in SqliteDialect targets better-sqlite3, and hand-rolling the
 * ~80 lines buys two things the stock dialect cannot give us:
 *
 * - every transaction opens with BEGIN IMMEDIATE — taking the write lock up
 *   front avoids the DEFERRED read→write upgrade that fails mid-transaction
 *   under WAL (§8.3), and every transaction we run is a write;
 * - a connection mutex serializes queries on the single SQLite connection, so
 *   one request's open transaction can never interleave with another's
 *   queries. Inside a transaction callback, always query through the `trx`
 *   handle — the root instance would wait on the mutex and deadlock.
 */
import type { Database, SQLQueryBindings } from "bun:sqlite";
import {
  Kysely,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type DatabaseIntrospector,
  type Dialect,
  type Driver,
  type QueryResult,
} from "kysely";
import type { DatabaseSchema } from "./schema";

export type Db = Kysely<DatabaseSchema>;

class ConnectionMutex {
  #promise: Promise<void> | undefined;
  #resolve: (() => void) | undefined;

  async lock(): Promise<void> {
    while (this.#promise !== undefined) await this.#promise;
    this.#promise = new Promise((resolve) => {
      this.#resolve = resolve;
    });
  }

  unlock(): void {
    const resolve = this.#resolve;
    this.#promise = undefined;
    this.#resolve = undefined;
    resolve?.();
  }
}

class BunSqliteConnection implements DatabaseConnection {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  exec(sql: string): void {
    this.#db.exec(sql);
  }

  executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    // db.query() caches prepared statements per SQL string.
    const statement = this.#db.query(compiledQuery.sql);
    // Boundary casts: Kysely types parameters as ReadonlyArray<unknown> and
    // rows by the query's type, both of which only the caller can know.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const parameters = compiledQuery.parameters as SQLQueryBindings[];
    if (statement.columnNames.length > 0) {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      return Promise.resolve({ rows: statement.all(...parameters) as R[] });
    }
    const { changes, lastInsertRowid } = statement.run(...parameters);
    return Promise.resolve({
      rows: [],
      numAffectedRows: BigInt(changes),
      insertId: BigInt(lastInsertRowid),
    });
  }

  streamQuery(): AsyncIterableIterator<never> {
    throw new Error("bun:sqlite dialect does not support streaming");
  }
}

class BunSqliteDriver implements Driver {
  readonly #connection: BunSqliteConnection;
  readonly #mutex = new ConnectionMutex();

  constructor(db: Database) {
    this.#connection = new BunSqliteConnection(db);
  }

  async init(): Promise<void> {}

  async acquireConnection(): Promise<DatabaseConnection> {
    await this.#mutex.lock();
    return this.#connection;
  }

  // There is exactly one connection, so the transaction methods can ignore
  // the passed handle instead of down-casting it.
  async beginTransaction(): Promise<void> {
    this.#connection.exec("BEGIN IMMEDIATE");
  }

  async commitTransaction(): Promise<void> {
    this.#connection.exec("COMMIT");
  }

  async rollbackTransaction(): Promise<void> {
    this.#connection.exec("ROLLBACK");
  }

  async releaseConnection(): Promise<void> {
    this.#mutex.unlock();
  }

  async destroy(): Promise<void> {}
}

class BunSqliteDialect implements Dialect {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  createDriver(): Driver {
    return new BunSqliteDriver(this.#db);
  }

  createQueryCompiler(): SqliteQueryCompiler {
    return new SqliteQueryCompiler();
  }

  createAdapter(): SqliteAdapter {
    return new SqliteAdapter();
  }

  createIntrospector(db: Kysely<unknown>): DatabaseIntrospector {
    return new SqliteIntrospector(db);
  }
}

/**
 * Wraps an already-opened `bun:sqlite` handle (pragmas and migrations run on
 * the raw handle first — see `openDb`/`runMigrations`). Closing the raw handle
 * is the owner's job; `db.destroy()` is a no-op.
 */
export function createDb(db: Database): Db {
  return new Kysely<DatabaseSchema>({ dialect: new BunSqliteDialect(db) });
}
