import Fastify from "fastify";

import { SqliteStore } from "./db";
import { RedisQueue } from "./queue";
import { registerIdeRoutes } from "./routes/ide";
import { registerTaskRoutes } from "./routes/tasks";
import { getSettings } from "./settings";
import type { AppContext } from "./types";

async function bootstrap(): Promise<void> {
  const settings = getSettings();
  const store = new SqliteStore(settings.dbPath, settings.migrationsDir);
  store.init();

  const queue = new RedisQueue({
    redisUrl: settings.redisUrl,
    queueName: settings.queueName,
  });

  const context: AppContext = {
    settings,
    store,
    queue,
  };

  const app = Fastify({ logger: true });
  registerTaskRoutes(app, context);
  app.register(
    (instance, _opts, done) => {
      registerTaskRoutes(instance, context);
      done();
    },
    { prefix: "/api" },
  );

  app.register(
    (instance, _opts, done) => {
      registerIdeRoutes(instance, context);
      done();
    },
    { prefix: "/ide" },
  );

  app.register(
    (instance, _opts, done) => {
      registerIdeRoutes(instance, context);
      done();
    },
    { prefix: "/api/ide" },
  );

  app.addHook("onClose", async () => {
    await queue.quit();
    store.close();
  });

  const host = process.env.CLAWBRAIN_API_HOST ?? "0.0.0.0";
  const port = Number(process.env.CLAWBRAIN_API_PORT ?? "8080");

  try {
    await app.listen({ host, port });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

void bootstrap();
