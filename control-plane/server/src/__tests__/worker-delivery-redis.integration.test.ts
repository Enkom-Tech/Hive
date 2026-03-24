import Redis from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WORKER_DELIVERY_PUBSUB_CHANNEL } from "../workers/worker-delivery-redis.js";

/**
 * Pub/sub smoke for the same channel + payload shape as worker-delivery-redis.
 * Set `HIVE_WORKER_DELIVERY_PUBSUB_TEST_URL` (e.g. redis://127.0.0.1:6379). CI sets this alongside a Redis service.
 * (Avoids accidental runs when a generic `REDIS_URL` is present in the shell.)
 */
const redisUrl = process.env.HIVE_WORKER_DELIVERY_PUBSUB_TEST_URL?.trim();

describe.skipIf(!redisUrl)("worker delivery Redis pub/sub (integration)", () => {
  let sub: Redis;
  let pub: Redis;

  beforeAll(() => {
    if (!redisUrl) return;
    sub = new Redis(redisUrl, { maxRetriesPerRequest: 2 });
    pub = new Redis(redisUrl, { maxRetriesPerRequest: 2 });
    const swallow = (): void => {};
    sub.on("error", swallow);
    pub.on("error", swallow);
  });

  afterAll(() => {
    sub?.disconnect();
    pub?.disconnect();
  });

  it(
    "subscriber receives JSON on WORKER_DELIVERY_PUBSUB_CHANNEL",
    async () => {
      if (!redisUrl) return;

      const payload = JSON.stringify({
        workerInstanceRowId: "aaaaaaaa-e29b-41d4-a716-446655440099",
        body: '{"type":"ping"}',
      });

      const received = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("subscribe/publish round-trip timed out")), 15_000);
        sub.once("message", (_ch: string, message: string) => {
          clearTimeout(timer);
          resolve(message);
        });
        void sub.subscribe(WORKER_DELIVERY_PUBSUB_CHANNEL, (err?: Error | null) => {
          if (err) {
            clearTimeout(timer);
            reject(err);
            return;
          }
          void pub.publish(WORKER_DELIVERY_PUBSUB_CHANNEL, payload);
        });
      });

      expect(JSON.parse(received)).toEqual(JSON.parse(payload));
    },
    20_000,
  );
});
