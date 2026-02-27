import Redis from "ioredis";

import { QueueError } from "./errors";

export class RedisQueue {
  private readonly client: Redis;

  readonly queueName: string;

  constructor(
    private readonly options: {
      redisUrl: string;
      queueName: string;
    },
  ) {
    this.queueName = options.queueName;
    this.client = new Redis(options.redisUrl);
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
      await this.client.rpush(this.queueName, JSON.stringify(payload));
    } catch (error) {
      throw new QueueError(`redis enqueue failed: ${String(error)}`);
    }
  }

  async dequeue(timeout: number): Promise<Record<string, unknown> | null> {
    try {
      const response = await this.client.blpop(this.queueName, timeout);
      if (!response) {
        return null;
      }

      const [, rawPayload] = response;
      const parsed = JSON.parse(rawPayload);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new QueueError("queue payload must be a JSON object");
      }
      return parsed as Record<string, unknown>;
    } catch (error) {
      if (error instanceof QueueError) {
        throw error;
      }
      throw new QueueError(`redis dequeue failed: ${String(error)}`);
    }
  }

  async length(): Promise<number> {
    try {
      return Number(await this.client.llen(this.queueName));
    } catch (error) {
      throw new QueueError(`redis length failed: ${String(error)}`);
    }
  }

  async publishHeartbeat(params: {
    agent: string;
    linuxUser: string;
    ttlSeconds?: number;
    extra?: Record<string, unknown>;
  }): Promise<string> {
    const host = process.env.HOSTNAME ?? "unknown-host";
    const pid = process.pid;
    const key = `clawbrain:agent_heartbeat:${params.agent}:${params.linuxUser}:${host}:${pid}`;
    const payload: Record<string, unknown> = {
      agent: params.agent,
      linux_user: params.linuxUser,
      host,
      pid,
      queue: this.queueName,
      ts: new Date().toISOString(),
      ...(params.extra ?? {}),
    };

    const ttlSeconds = Math.max(15, Number(params.ttlSeconds ?? 45));
    try {
      await this.client.set(key, JSON.stringify(payload), "EX", ttlSeconds);
      return key;
    } catch (error) {
      throw new QueueError(`redis publish heartbeat failed: ${String(error)}`);
    }
  }

  async listHeartbeats(keyPrefix = "clawbrain:agent_heartbeat:"): Promise<Record<string, unknown>[]> {
    const result: Record<string, unknown>[] = [];
    try {
      const stream = this.client.scanStream({ match: `${keyPrefix}*`, count: 100 });
      for await (const keysChunk of stream as AsyncIterable<string[]>) {
        for (const key of keysChunk) {
          const raw = await this.client.get(key);
          if (!raw) {
            continue;
          }
          try {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              result.push({ ...(parsed as Record<string, unknown>), _key: key });
            }
          } catch {
            // Skip malformed heartbeat payloads.
          }
        }
      }
      return result;
    } catch (error) {
      throw new QueueError(`redis list heartbeats failed: ${String(error)}`);
    }
  }

  async getRaw(key: string): Promise<string | null> {
    try {
      const value = await this.client.get(key);
      return value ?? null;
    } catch (error) {
      throw new QueueError(`redis get failed: ${String(error)}`);
    }
  }

  async setRaw(key: string, value: string): Promise<void> {
    try {
      await this.client.set(key, value);
    } catch (error) {
      throw new QueueError(`redis set failed: ${String(error)}`);
    }
  }

  async quit(): Promise<void> {
    await this.client.quit();
  }
}
