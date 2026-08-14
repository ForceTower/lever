/**
 * `bun run migrate` — applies pending migrations and exits (spec 0001 §9.3).
 * Boot migrates automatically; this exists for running against a copy of the
 * database before an upgrade.
 */
import { openDb, runMigrations } from "./db";

const path = process.env.DATABASE_PATH ?? "./data/lever.db";
const db = openDb(path);
runMigrations(db);
db.close();
console.log(`migrations up to date: ${path}`);
