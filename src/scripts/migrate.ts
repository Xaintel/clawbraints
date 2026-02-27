import path from "node:path";

import { Command } from "commander";

import { SqliteStore } from "../db";

const DEFAULT_DB_PATH = "/data/clawbrain/db/clawbrain.sqlite3";

function parseArgs(argv: string[]): { dbPath: string } {
  const program = new Command();
  program.option("--db-path <path>", "SQLite DB path", DEFAULT_DB_PATH);
  program.parse(argv);
  const opts = program.opts<Record<string, string>>();
  return { dbPath: String(opts.dbPath ?? DEFAULT_DB_PATH) };
}

function main(argv: string[]): number {
  const args = parseArgs(argv);
  const dbPath = path.resolve(args.dbPath);
  const migrationsDir = process.env.CLAWBRAIN_MIGRATIONS_DIR
    ? path.resolve(process.env.CLAWBRAIN_MIGRATIONS_DIR)
    : path.resolve(process.cwd(), "migrations");

  // eslint-disable-next-line no-console
  console.log(`[STEP] Using database: ${dbPath}`);
  const store = new SqliteStore(dbPath, migrationsDir);
  store.init();
  store.close();
  // eslint-disable-next-line no-console
  console.log("[OK] Migration run finished");
  return 0;
}

if (require.main === module) {
  process.exit(main(process.argv));
}
