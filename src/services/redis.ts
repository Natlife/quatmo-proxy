import { Redis } from "ioredis";
import dotenv from "dotenv";

dotenv.config();

const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";

let redis: Redis | null = null;

try {
  redis = new Redis(redisUrl, {
    maxRetriesPerRequest: 3,
    connectTimeout: 5000,
    retryStrategy(times: number) {
      if (times > 3) {
        console.warn(
          `[Redis] Fail to connect after ${times} attempts. Falling back to local/in-memory memory cache.`,
        );
        return null;
      }
      return Math.min(times * 100, 2000);
    },
  });

  redis.on("error", (err: Error) => {
    console.error("[Redis] Connection error:", err.message);
  });

  redis.on("connect", () => {
    console.log("[Redis] Connected successfully to Redis server.");
  });
} catch (e) {
  console.warn(
    "[Redis] Failed to initialize Redis. Running with limited memory storage.",
  );
}

export { redis };
export type { Redis };
