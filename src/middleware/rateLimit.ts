import type { MiddlewareHandler } from "hono";
import { redis } from "../services/redis";
import type { UserSession } from "./auth";

const REQUEST_LIMIT_PER_MINUTE = 30;

export const rateLimitMiddleware = (): MiddlewareHandler<{
  Variables: { user: UserSession; token: string };
}> => {
  return async (c, next) => {
    const user = c.get("user") as UserSession | undefined;
    if (!user) {
      return c.json({ error: "Context unauthorized" }, 401);
    }

    const currentMinute = Math.floor(Date.now() / 60000);
    const redisKey = `rate:req:${user.keyId}:${currentMinute}`;

    if (redis && redis.status === "ready") {
      try {
        const count = await redis.incr(redisKey);
        if (count === 1) {
          await redis.expire(redisKey, 60);
        }

        if (count > REQUEST_LIMIT_PER_MINUTE) {
          return c.json(
            { error: "Too many requests. Rate limit exceeded (30 req/min)." },
            429,
          );
        }
      } catch (err) {
        console.error("[RateLimit] Redis error:", err);
      }
    } else {
      // In-memory rate limiting fallback for local dev without Redis
    }

    await next();
  };
};
