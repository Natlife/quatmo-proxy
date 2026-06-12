import type { MiddlewareHandler } from "hono";
import { redis } from "../services/redis";
import { getProxyApiKey } from "../services/proxyKey";

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
    const proxyApiKey = getProxyApiKey();

    let session: UserSession | null = null;

    const openAiKey = process.env.OPENAI_API_KEY || "";
    const openRouterKey = process.env.OPENROUTER_API_KEY || "";
    const customApiKey = process.env.CUSTOM_API_KEY || "";

    if (token === proxyApiKey) {
      session = {
        keyId: "master-key-id",
        userId: "master-user",
        monthlyTokenLimit: 999_999_999,
        tokensConsumed: 0,
      };
    } else if (token === "qp_student_test") {
      if (redis && redis.status === "ready") {
        try {
          const cached = await redis.get(`key:auth:${token}`);
          if (cached) {
            session = JSON.parse(cached);
          } else {
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
        } catch (err) {
          console.error("[Auth] Cache lookup error:", err);
        }
      } else {
        session = memoryBudgets.get(token) || null;
      }
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
        { error: "Unauthorized. Provided API key does not match the proxy access key." },
        401,
      );
    }

    // Attach user session to the request context
    c.set("user", session);
    c.set("token", token);
    await next();
  };
};
