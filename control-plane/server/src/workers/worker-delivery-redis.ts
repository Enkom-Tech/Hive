import { Redis } from "ioredis";
import { logger } from "../middleware/logger.js";

/** Channel for multi-replica worker payload fan-out; all API replicas must use the same name. */
export const WORKER_DELIVERY_PUBSUB_CHANNEL = "hive:worker:deliver:v1" as const;

const CHANNEL = WORKER_DELIVERY_PUBSUB_CHANNEL;

let publisher: Redis | null = null;
let subscriber: Redis | null = null;

export type DeliverToInstanceHandler = (workerInstanceRowId: string, body: string) => void;

/**
 * When set, cross-replica worker WebSocket delivery uses Redis pub/sub.
 * Subscriber invokes `onDeliver` on each message; only the replica holding the socket should succeed.
 */
export function initWorkerDeliveryRedis(
  url: string | undefined,
  onDeliver: DeliverToInstanceHandler,
): void {
  if (!url?.trim()) return;

  try {
    publisher = new Redis(url, { maxRetriesPerRequest: 2 });
    subscriber = new Redis(url, { maxRetriesPerRequest: 2 });
    void subscriber.subscribe(CHANNEL, (err?: Error | null) => {
      if (err) {
        logger.error({ err }, "worker delivery redis subscribe failed");
      }
    });
    subscriber.on("message", (_ch: string, message: string) => {
      try {
        const parsed = JSON.parse(message) as { workerInstanceRowId?: string; body?: string };
        if (typeof parsed.workerInstanceRowId !== "string" || typeof parsed.body !== "string") return;
        onDeliver(parsed.workerInstanceRowId, parsed.body);
      } catch {
        // ignore malformed
      }
    });
    logger.info("worker delivery redis enabled");
  } catch (err) {
    logger.error({ err }, "worker delivery redis init failed");
  }
}

export function publishWorkerInstanceDeliver(workerInstanceRowId: string, body: string): void {
  if (!publisher) return;
  void publisher.publish(
    CHANNEL,
    JSON.stringify({ workerInstanceRowId, body }),
  );
}

export function isWorkerDeliveryRedisConfigured(): boolean {
  return publisher != null;
}
