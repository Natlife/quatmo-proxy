import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { authMiddleware, type UserSession } from "../middleware/auth";
import { rateLimitMiddleware } from "../middleware/rateLimit";
import { countMessagesTokens, countTokens } from "../services/token";
import { redis } from "../services/redis";
import dotenv from "dotenv";
import { spawn } from "child_process";
import path from "path";

dotenv.config();

const chatRouter = new Hono<{
  Variables: { user: UserSession; token: string };
}>();

interface ActiveSession {
  accumulatedTokens: number;
  lastRequestTime: number;
}
const activeSessions = new Map<string, ActiveSession>();

async function classifyPrompt(prompt: string): Promise<any> {
  return new Promise((resolve) => {
    try {
      const exePath = path.resolve(process.cwd(), "bin", "classifier.exe");
      const truncatedPrompt = prompt.slice(0, 4000);
      const child = spawn(exePath, ["--prompt", truncatedPrompt]);
      
      let stdout = "";
      let stderr = "";
      
      child.stdout.on("data", (data) => {
        stdout += data.toString();
      });
      
      child.stderr.on("data", (data) => {
        stderr += data.toString();
      });
      
      child.on("close", (code) => {
        if (code === 0) {
          try {
            const parsed = JSON.parse(stdout.trim());
            resolve(parsed);
            return;
          } catch (err) {
            console.error("[Classifier] Failed to parse stdout:", stdout, err);
          }
        } else {
          console.error(`[Classifier] Exited with code ${code}. Stderr: ${stderr}`);
        }
        resolve(null);
      });
    } catch (err) {
      console.error("[Classifier] Spawn error:", err);
      resolve(null);
    }
  });
}

function getUpstreamConfig(
  model: string,
  token?: string,
): {
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
    lowerModel === "local-model" ||
    lowerModel === "auto" ||
    token === "lmstudio-placeholder-key"
  ) {
    return {
      url: `${lmStudioUrl}/chat/completions`,
      key: "lmstudio-placeholder-key",
      actualModel: model,
    };
  }

  if (lowerModel === "gemma" || lowerModel.includes("gemma")) {
    const isTestMode = process.env.PROXY_TEST_MODE === "true";
    const customBaseUrl =
      process.env.CUSTOM_BASE_URL || "https://quatmo-api.iahn.hanoi.vn/v1";
    const customKey = process.env.CUSTOM_API_KEY || "FORWARD_USER_KEY";
    const actualModel = process.env.CUSTOM_MODEL_NAME || "gemma-4";
    return {
      url: isTestMode
        ? "http://localhost:3002/v1/chat/completions"
        : `${customBaseUrl}/chat/completions`,
      key: customKey,
      actualModel: actualModel,
    };
  }

  if (
    lowerModel.startsWith("openrouter/") ||
    lowerModel.includes("gemini") ||
    lowerModel.includes("llama") ||
    lowerModel.includes("qwen") ||
    lowerModel.includes("claude") ||
    (lowerModel.includes("/") &&
      !lowerModel.startsWith("openai/gpt-4") &&
      !lowerModel.startsWith("openai/gpt-3"))
  ) {
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

    const lastMsg = body.messages && body.messages.length > 0 ? body.messages[body.messages.length - 1] : null;
    let classifierPromise: Promise<any> | null = null;
    if (lastMsg && lastMsg.role === "user" && typeof lastMsg.content === "string") {
      classifierPromise = classifyPrompt(lastMsg.content);
    }

    const model = body.model || "gpt-4o";
    const upstream = getUpstreamConfig(model, token);
    const remainingBudget = user.monthlyTokenLimit - user.tokensConsumed;

    console.log(`\x1b[36m[Proxy]\x1b[0m ➔ Request: ${model} | Stream: ${body.stream} | Budget: ${remainingBudget}`);

    const inputTokens = countMessagesTokens(body.messages);

    if (remainingBudget <= 0) {
      const errorMsg = "Monthly token budget exceeded. Access Denied.";
      if (body.stream) {
        return streamSSE(c, async (stream) => {
          const errChunk = {
            choices: [
              {
                index: 0,
                delta: { content: `\n\n**[${errorMsg}]**\n\n` },
                finish_reason: "error",
              },
            ],
          };
          await stream.writeSSE({ data: JSON.stringify(errChunk) });
          await stream.writeSSE({ data: "[DONE]" });
        });
      }
      return c.json({ error: errorMsg }, 402);
    }

    let classifierResultText = "";
    if (classifierPromise) {
      try {
        const res = await classifierPromise;
        if (res && res.label) {
          const formattedLabel = res.label.toLowerCase();
          const confidencePct = `${(res.confidence * 100).toFixed(1)}%`;
          console.log(`\x1b[32m[Classifier]\x1b[0m ➔ ${formattedLabel} (${confidencePct})`);
          classifierResultText = `__CLASSIFIER_RESULT__:{"label":"${res.label}","confidence":${res.confidence}}\n\n`;
        }
      } catch (e) {
        console.error("[Classifier] Error during classification:", e);
      }
    }

    const upstreamBody: any = {
      ...body,
      model: upstream.actualModel,
    };
    if (body.stream) {
      upstreamBody.stream_options = {
        include_usage: true,
      };
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (upstream.key === "FORWARD_USER_KEY") {
      headers["Authorization"] = `Bearer ${token}`;
    } else if (upstream.key && upstream.key !== "lmstudio-placeholder-key") {
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
      const upstreamUsage = responseData.usage;
      let totalConsumed = 0;
      if (upstreamUsage && typeof upstreamUsage.total_tokens === "number") {
        totalConsumed = upstreamUsage.total_tokens;
      } else {
        const outputText = responseData.choices?.[0]?.message?.content || "";
        const outputTokens = countTokens(outputText);
        totalConsumed = inputTokens + outputTokens;
      }
      console.log(`\x1b[36m[Proxy]\x1b[0m ➔ Completed | Total: ${totalConsumed} tokens`);

      // Accumulate in active window
      const now = Date.now();
      let session = activeSessions.get(user.keyId);
      if (!session || now - session.lastRequestTime > 8000) {
        session = { accumulatedTokens: 0, lastRequestTime: now };
      }
      session.accumulatedTokens += totalConsumed;
      session.lastRequestTime = now;
      activeSessions.set(user.keyId, session);

      // Override usage for client display
      responseData.usage = {
        prompt_tokens:
          session.accumulatedTokens - (upstreamUsage?.completion_tokens ?? 0),
        completion_tokens: upstreamUsage?.completion_tokens ?? 0,
        total_tokens: session.accumulatedTokens,
      };

      // Prepend to response content
      if (classifierResultText && responseData.choices?.[0]?.message) {
        responseData.choices[0].message.content = classifierResultText + responseData.choices[0].message.content;
      }

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
      let upstreamTotalTokens: number | null = null;

      // Immediately write the classifier output to the stream first!
      if (classifierResultText) {
        const classifierChunk = {
          choices: [
            {
              index: 0,
              delta: { content: classifierResultText },
              finish_reason: null,
            },
          ],
        };
        await stream.writeSSE({ data: JSON.stringify(classifierChunk) });
      }

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
              if (upstreamTotalTokens === null) {
                const finalOutputTokens = countTokens(completionText);
                const totalConsumed = inputTokens + finalOutputTokens;

                // Accumulate in active window
                const now = Date.now();
                let session = activeSessions.get(user.keyId);
                if (!session || now - session.lastRequestTime > 8000) {
                  session = { accumulatedTokens: 0, lastRequestTime: now };
                }
                session.accumulatedTokens += totalConsumed;
                session.lastRequestTime = now;
                activeSessions.set(user.keyId, session);

                const usageChunk = {
                  choices: [],
                  usage: {
                    prompt_tokens:
                      session.accumulatedTokens - finalOutputTokens,
                    completion_tokens: finalOutputTokens,
                    total_tokens: session.accumulatedTokens,
                  },
                };
                await stream.writeSSE({ data: JSON.stringify(usageChunk) });
              }
              await stream.writeSSE({ data: "[DONE]" });
              await stream.close();
              isTerminated = true;
              break;
            }

            if (trimmed.startsWith("data: ")) {
              const rawJson = trimmed.substring(6);
              try {
                const parsed = JSON.parse(rawJson);

                // Extract actual usage if returned by upstream
                if (parsed.usage) {
                  const u = parsed.usage;
                  const total =
                    u.total_tokens ??
                    (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0);
                  if (typeof total === "number" && total > 0) {
                    upstreamTotalTokens = total;

                    // Accumulate in active window
                    const now = Date.now();
                    let session = activeSessions.get(user.keyId);
                    if (!session || now - session.lastRequestTime > 8000) {
                      session = { accumulatedTokens: 0, lastRequestTime: now };
                    }
                    session.accumulatedTokens += total;
                    session.lastRequestTime = now;
                    activeSessions.set(user.keyId, session);

                    // Override response usage
                    parsed.usage = {
                      prompt_tokens:
                        session.accumulatedTokens - (u.completion_tokens ?? 0),
                      completion_tokens: u.completion_tokens ?? 0,
                      total_tokens: session.accumulatedTokens,
                    };
                  }
                }

                const content = parsed.choices?.[0]?.delta?.content || "";
                completionText += content;

                const outputTokens = countTokens(completionText);
                const totalConsumed = inputTokens + outputTokens;

                if (totalConsumed >= remainingBudget) {
                  // Accumulate in active window
                  const now = Date.now();
                  let session = activeSessions.get(user.keyId);
                  if (!session || now - session.lastRequestTime > 8000) {
                    session = { accumulatedTokens: 0, lastRequestTime: now };
                  }
                  session.accumulatedTokens += totalConsumed;
                  session.lastRequestTime = now;
                  activeSessions.set(user.keyId, session);

                  const errorChunk = {
                    choices: [
                      {
                        index: 0,
                        delta: {
                          content:
                            "\n\n**[Proxy Error: Token limit exceeded. Request truncated.]**\n\n",
                        },
                        finish_reason: null,
                      },
                    ],
                  };
                  await stream.writeSSE({ data: JSON.stringify(errorChunk) });

                  const usageChunk = {
                    choices: [],
                    usage: {
                      prompt_tokens: session.accumulatedTokens - outputTokens,
                      completion_tokens: outputTokens,
                      total_tokens: session.accumulatedTokens,
                    },
                  };
                  await stream.writeSSE({ data: JSON.stringify(usageChunk) });

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
                  await stream.close();
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
        try {
          reader.releaseLock();
        } catch (_) {}
        let totalConsumed = 0;
        if (upstreamTotalTokens !== null) {
          totalConsumed = upstreamTotalTokens;
        } else {
          const finalOutputTokens = countTokens(completionText);
          totalConsumed = inputTokens + finalOutputTokens;
        }
        console.log(`\x1b[36m[Proxy]\x1b[0m ➔ Completed | Total: ${totalConsumed} tokens`);
        await recordTokenUsage(totalConsumed);
      }
    });
  },
);

export { chatRouter };
