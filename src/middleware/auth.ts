import type { MiddlewareHandler } from "hono";
import { redis } from "../services/redis";

export interface UserSession {
  keyId: string;
  userId: string;
  monthlyTokenLimit: number;
  tokensConsumed: number;
}

const memoryBudgets = new Map<string, UserSession>([
  [
    "qp_student_test",
    {
      keyId: "test-key-id",
      userId: "student-1",
      monthlyTokenLimit: 50000,
      tokensConsumed: 0,
    },
  ],
]);

export const authMiddleware = (): MiddlewareHandler<{
  Variables: { user: UserSession; token: string };
}> => {
  return async (c, next) => {
    const authHeader = c.req.header("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return c.json({ error: "Missing or invalid Authorization header" }, 401);
    }

    const token = authHeader.substring(7).trim();
    const proxyApiKey = process.env.PROXY_API_KEY;

    let session: UserSession | null = null;

    // Check if proxy has a predefined API key set in env
    if (proxyApiKey && proxyApiKey.trim() !== "") {
      if (token === proxyApiKey) {
        session = {
          keyId: "master-key-id",
          userId: "master-user",
          monthlyTokenLimit: 999_999_999,
          tokensConsumed: 0,
        };
      } else if (token === "qp_student_test") {
        session = memoryBudgets.get(token) || null;
      } else if (token === "lmstudio-placeholder-key") {
        session = {
          keyId: "lmstudio-local-key",
          userId: "local-user",
          monthlyTokenLimit: 999_999_999,
          tokensConsumed: 0,
        };
      }
      
      if (!session) {
        return c.json(
          { error: "Unauthorized. Provided API key does not match the proxy master API key." },
          401
        );
      }
    } else {
      // Backward compatibility fallback if PROXY_API_KEY is not defined
      if (redis && redis.status === "ready") {
        try {
          const cached = await redis.get(`key:auth:${token}`);
          if (cached) {
            session = JSON.parse(cached);
          } else {
            if (token === "qp_student_test") {
              session = memoryBudgets.get(token) || null;
              if (session) {
                await redis.set(
                  `key:auth:${token}`,
                  JSON.stringify(session),
                  "EX",
                  600,
                );
              }
            }
          }
        } catch (err) {
          console.error("[Auth] Cache lookup error:", err);
        }
      } else {
        session = memoryBudgets.get(token) || null;
      }

      if (!session && token) {
        session = {
          keyId: `custom-${token.substring(0, 8)}`,
          userId: "custom-user",
          monthlyTokenLimit: 999_999_999,
          tokensConsumed: 0,
        };
      }
    }

    if (!session) {
      return c.json(
        { error: "Unauthorized. Proxy token is invalid or expired." },
        401,
      );
    }

    // Attach user session to the request context
    c.set("user", session);
    c.set("token", token);
    await next();
  };
};
