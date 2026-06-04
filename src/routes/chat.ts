import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { authMiddleware, type UserSession } from "../middleware/auth";
import { rateLimitMiddleware } from "../middleware/rateLimit";
import { countMessagesTokens, countTokens } from "../services/token";
import { redis } from "../services/redis";
import dotenv from "dotenv";

dotenv.config();

const chatRouter = new Hono<{
  Variables: { user: UserSession; token: string };
}>();

function getUpstreamConfig(model: string): {
  url: string;
  key: string;
  actualModel: string;
} {
  const openAiKey = process.env.OPENAI_API_KEY || "";
  const openRouterKey = process.env.OPENROUTER_API_KEY || "";
  const lmStudioUrl =
    process.env.LMSTUDIO_BASE_URL || "http://localhost:1234/v1";

  const lowerModel = model.toLowerCase();

  if (
    lowerModel.includes("lmstudio") ||
    lowerModel.includes("gpt-oss-20b") ||
    lowerModel === "local-model"
  ) {
    return {
      url: `${lmStudioUrl}/chat/completions`,
      key: "lmstudio-placeholder-key",
      actualModel: model,
    };
  }

  if (lowerModel.startsWith("openrouter/") || lowerModel.includes("gemini")) {
    const actualModel = lowerModel.startsWith("openrouter/")
      ? model.substring(11)
      : model;
    return {
      url: "https://openrouter.ai/api/v1/chat/completions",
      key: openRouterKey,
      actualModel,
    };
  }

  return {
    url: "https://api.openai.com/v1/chat/completions",
    key: openAiKey,
    actualModel: model.replace(/^openai\//i, ""),
  };
}

chatRouter.post(
  "/completions",
  authMiddleware(),
  rateLimitMiddleware(),
  async (c) => {
    const user = c.get("user");
    const token = c.get("token");
    const body = await c.req.json();

    if (!body.messages || !Array.isArray(body.messages)) {
      return c.json(
        { error: "Invalid payload: 'messages' array is required." },
        400,
      );
    }

    const model = body.model || "gpt-4o";
    const upstream = getUpstreamConfig(model);

    const inputTokens = countMessagesTokens(body.messages);
    const remainingBudget = user.monthlyTokenLimit - user.tokensConsumed;

    if (remainingBudget <= 0) {
      return c.json(
        { error: "Monthly token budget exceeded. Access Denied." },
        402,
      );
    }

    if (inputTokens > remainingBudget) {
      return c.json(
        {
          error: `Request input (${inputTokens} tokens) exceeds remaining budget (${remainingBudget} tokens).`,
        },
        402,
      );
    }

    const upstreamBody = {
      ...body,
      model: upstream.actualModel,
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (upstream.key && upstream.key !== "lmstudio-placeholder-key") {
      headers["Authorization"] = `Bearer ${upstream.key}`;
    }

    let response: Response;
    try {
      response = await fetch(upstream.url, {
        method: "POST",
        headers,
        body: JSON.stringify(upstreamBody),
      });
    } catch (err: any) {
      console.error("[Proxy] Upstream connection failed:", err.message);
      return c.json(
        { error: `Connection to upstream provider failed: ${err.message}` },
        502,
      );
    }

    if (!response.ok) {
      const errBody = await response.text();
      console.error(
        "[Proxy] Upstream returned error:",
        response.status,
        errBody,
      );
      return c.text(errBody, response.status as any);
    }

    const recordTokenUsage = async (consumed: number) => {
      user.tokensConsumed += consumed;
      if (redis && redis.status === "ready") {
        try {
          await redis.set(`key:auth:${token}`, JSON.stringify(user), "EX", 600);
          await redis.incrby(`budget:consumed:${user.keyId}`, consumed);
        } catch (err) {
          console.error("[Proxy] Budget update failed:", err);
        }
      }
    };

    if (!body.stream) {
      const responseData: any = await response.json();
      const outputText = responseData.choices?.[0]?.message?.content || "";
      const outputTokens = countTokens(outputText);
      const totalConsumed = inputTokens + outputTokens;

      await recordTokenUsage(totalConsumed);
      return c.json(responseData);
    }

    if (!response.body) {
      return c.json(
        { error: "Upstream response does not support streaming." },
        502,
      );
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    return streamSSE(c, async (stream) => {
      let completionText = "";
      let accumulatedBuffer = "";
      let isTerminated = false;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          accumulatedBuffer += decoder.decode(value, { stream: true });
          const lines = accumulatedBuffer.split("\n");
          accumulatedBuffer = lines.pop() || ""; // Hold incomplete line in buffer

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            if (trimmed === "data: [DONE]") {
              await stream.writeSSE({ data: "[DONE]" });
              isTerminated = true;
              break;
            }

            if (trimmed.startsWith("data: ")) {
              const rawJson = trimmed.substring(6);
              try {
                const parsed = JSON.parse(rawJson);
                const content = parsed.choices?.[0]?.delta?.content || "";
                completionText += content;

                const outputTokens = countTokens(completionText);
                const totalConsumed = inputTokens + outputTokens;

                if (totalConsumed >= remainingBudget) {
                  const stopChunk = {
                    choices: [
                      {
                        index: 0,
                        delta: {},
                        finish_reason: "length",
                      },
                    ],
                  };
                  await stream.writeSSE({ data: JSON.stringify(stopChunk) });
                  await stream.writeSSE({ data: "[DONE]" });
                  reader.cancel();
                  isTerminated = true;
                  break;
                }

                await stream.writeSSE({ data: JSON.stringify(parsed) });
              } catch (err) {
                await stream.writeSSE({ data: rawJson });
              }
            }
          }

          if (isTerminated) {
            break;
          }
        }
      } catch (streamErr: any) {
        console.error("[Proxy] Stream relay error:", streamErr.message);
      } finally {
        reader.releaseLock();
        const finalOutputTokens = countTokens(completionText);
        const totalConsumed = inputTokens + finalOutputTokens;
        await recordTokenUsage(totalConsumed);
        console.log(
          `[Proxy] Session completed. Total tokens consumed: ${totalConsumed}`,
        );
      }
    });
  },
);

export { chatRouter };
