import type { SqliteStore } from "./db";
import type { RedisQueue } from "./queue";
import type { Settings } from "./settings";

export interface AppContext {
  settings: Settings;
  store: SqliteStore;
  queue: RedisQueue;
}
