import Redis from "ioredis";

import { QueueError } from "./errors";

export class RedisQueue {
  private readonly client: Redis;

  constructor(
    private readonly options: {
      redisUrl: string;
      queueName: string;
    },
  ) {
    this.client = new Redis(options.redisUrl, {
      lazyConnect: false,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
  }

  async ping(): Promise<void> {
    try {
      await this.client.ping();
    } catch (error) {
      throw new QueueError(`redis ping failed: ${String(error)}`);
    }
  }

  async enqueue(payload: Record<string, unknown>): Promise<void> {
    try {
      await this.client.rpush(this.options.queueName, JSON.stringify(payload));
    } catch (error) {
      throw new QueueError(`redis enqueue failed: ${String(error)}`);
    }
  }

  async quit(): Promise<void> {
    await this.client.quit();
  }
}
