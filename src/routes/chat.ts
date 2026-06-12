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

export interface ParsedToolCall {
  name: string;
  arguments: Record<string, string>;
}

export function parseXmlToolCall(xml: string): ParsedToolCall | null {
  const funcMatch = xml.match(/<function=([^>]+)>/);
  if (!funcMatch) return null;
  const name = funcMatch[1].trim();

  const args: Record<string, string> = {};
  const paramStartRegex = /<parameter=([^>]+)>/g;
  let match;
  const paramRanges: {
    name: string;
    startIdx: number;
    contentStartIdx: number;
  }[] = [];

  while ((match = paramStartRegex.exec(xml)) !== null) {
    paramRanges.push({
      name: match[1].trim(),
      startIdx: match.index,
      contentStartIdx: match.index + match[0].length,
    });
  }

  for (let i = 0; i < paramRanges.length; i++) {
    const current = paramRanges[i];
    const nextStart =
      i + 1 < paramRanges.length
        ? paramRanges[i + 1].startIdx
        : xml.indexOf("</function>");

    let paramContent = xml.substring(
      current.contentStartIdx,
      nextStart !== -1 ? nextStart : xml.length,
    );
    const closeTagIdx = paramContent.lastIndexOf("</parameter>");
    if (closeTagIdx !== -1) {
      paramContent = paramContent.substring(0, closeTagIdx);
    }
    args[current.name] = paramContent.trim();
  }

  return { name, arguments: args };
}

export class XmlToolCallConverter {
  private buffer = "";
  private inToolCall = false;

  public processChunk(text: string): any[] {
    const cleanText = text.replace(/<\/tool_call>/g, "");
    this.buffer += cleanText;
    const outputs: any[] = [];
    const targetTag = "<function=";

    while (this.buffer.length > 0) {
      if (!this.inToolCall) {
        const funcIdx = this.buffer.indexOf(targetTag);
        if (funcIdx === -1) {
          // Check if the end of the buffer matches a partial prefix of "<function="
          let partialLen = 0;
          for (
            let len = Math.min(this.buffer.length, targetTag.length - 1);
            len > 0;
            len--
          ) {
            if (this.buffer.endsWith(targetTag.substring(0, len))) {
              partialLen = len;
              break;
            }
          }

          if (partialLen > 0) {
            // Flush content before the partial tag, keep the partial tag in the buffer
            const outputText = this.buffer.substring(
              0,
              this.buffer.length - partialLen,
            );
            this.buffer = this.buffer.substring(
              this.buffer.length - partialLen,
            );
            if (outputText.length > 0) {
              outputs.push({
                delta: { content: outputText },
              });
            }
            break;
          } else {
            // No partial match, flush the entire buffer
            const outputText = this.buffer;
            this.buffer = "";
            outputs.push({
              delta: { content: outputText },
            });
            break;
          }
        } else {
          if (funcIdx > 0) {
            const leadingText = this.buffer.substring(0, funcIdx);
            outputs.push({
              delta: { content: leadingText },
            });
          }
          this.buffer = this.buffer.substring(funcIdx);
          this.inToolCall = true;
        }
      } else {
        const endIdx = this.buffer.indexOf("</function>");
        if (endIdx === -1) {
          break;
        } else {
          const fullToolCallXml = this.buffer.substring(
            0,
            endIdx + "</function>".length,
          );
          this.buffer = this.buffer.substring(endIdx + "</function>".length);
          this.inToolCall = false;

          const parsed = parseXmlToolCall(fullToolCallXml);
          if (parsed) {
            const toolCallId =
              "call_" + Math.random().toString(36).substring(2, 11);
            outputs.push({
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: toolCallId,
                    type: "function",
                    function: {
                      name: parsed.name,
                      arguments: JSON.stringify(parsed.arguments),
                    },
                  },
                ],
              },
            });
          } else {
            outputs.push({
              delta: { content: fullToolCallXml },
            });
          }
        }
      }
    }

    return outputs;
  }

  public flush(): any[] {
    const outputs: any[] = [];
    if (this.buffer) {
      outputs.push({
        delta: { content: this.buffer },
      });
      this.buffer = "";
    }
    return outputs;
  }
}

const chatRouter = new Hono<{
  Variables: { user: UserSession; token: string };
}>();

let classifierFailureCount = 0;
let classifierDisabledUntil = 0;
const MAX_FAILURES = 3;
const CIRCUIT_BREAKER_DURATION_MS = 60000; // 60 seconds

function handleClassifierFailure() {
  classifierFailureCount++;
  if (classifierFailureCount >= MAX_FAILURES) {
    classifierDisabledUntil = Date.now() + CIRCUIT_BREAKER_DURATION_MS;
    console.error(
      `[Classifier] ${MAX_FAILURES} consecutive failures detected. Circuit breaker tripped! Bypassing classification for ${CIRCUIT_BREAKER_DURATION_MS / 1000}s to protect response latency.`,
    );
  }
}

async function classifyPrompt(prompt: string): Promise<any> {
  const apiUrl = process.env.CLASSIFIER_API_URL;
  const truncatedPrompt = prompt.slice(0, 4000);

  // CHẾ ĐỘ 1: Gọi qua Web API (Chuẩn Production - Ưu tiên hàng đầu)
  if (apiUrl) {
    if (Date.now() < classifierDisabledUntil) {
      console.warn(
        "[Classifier] Circuit breaker active. Bypassing classification request.",
      );
      return null;
    }

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      const classifierApiKey = process.env.CLASSIFIER_API_KEY?.trim();
      if (classifierApiKey) {
        headers["Authorization"] = `Bearer ${classifierApiKey}`;
      }

      const response = await fetch(apiUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({ prompt: truncatedPrompt }),
        signal: AbortSignal.timeout(60000), // Tự động huỷ sau 60 giây để không block request chính
      });

      if (response.ok) {
        const parsed = await response.json();
        if (parsed && typeof parsed.label === "string") {
          classifierFailureCount = 0; // Reset counter on success
          return parsed;
        }
      } else {
        console.error(`[Classifier API] HTTP Error: ${response.status}`);
        handleClassifierFailure();
      }
      return null;
    } catch (err: any) {
      console.error("[Classifier API] Request failed:", err.message);
      handleClassifierFailure();
      return null;
    }
  }

  // CHẾ ĐỘ 2: Chạy binary cục bộ (Chỉ dùng làm Fallback phát triển local)
  return new Promise((resolve) => {
    let resolved = false;
    let child: any = null;

    // Thiết lập timeout 60 giây để bắt buộc kết thúc nếu exe bị treo
    const timeout = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      console.error("[Classifier] Process timeout (60s). Terminating...");
      if (child) {
        try {
          child.kill("SIGKILL");
        } catch (e) {}
      }
      resolve(null);
    }, 60000);

    try {
      const exePath = path.resolve(process.cwd(), "bin", "classifier.exe");
      child = spawn(exePath, ["--prompt", truncatedPrompt]);

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (data: any) => {
        stdout += data.toString();
      });

      child.stderr.on("data", (data: any) => {
        stderr += data.toString();
      });

      child.on("error", (err: any) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeout);
        console.error("[Classifier] Process error:", err);
        resolve(null);
      });

      child.on("close", (code: number) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeout);

        if (code === 0) {
          try {
            const parsed = JSON.parse(stdout.trim());
            resolve(parsed);
            return;
          } catch (err) {
            console.error("[Classifier] Failed to parse stdout:", stdout, err);
          }
        } else {
          console.error(
            `[Classifier] Exited with code ${code}. Stderr: ${stderr}`,
          );
        }
        resolve(null);
      });
    } catch (err) {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        console.error("[Classifier] Spawn error:", err);
        resolve(null);
      }
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
  provider: "lmstudio" | "custom" | "openrouter" | "openai";
} {
  const openAiKey = process.env.OPENAI_API_KEY || "";
  const openRouterKey = process.env.OPENROUTER_API_KEY || "";
  const lmStudioUrl =
    process.env.LMSTUDIO_BASE_URL || "http://localhost:1234/v1";
  const customBaseUrl =
    process.env.CUSTOM_BASE_URL || "https://quatmo-api.iahn.hanoi.vn/v1";
  const customKey = process.env.CUSTOM_API_KEY || "FORWARD_USER_KEY";
  const isTestMode = process.env.PROXY_TEST_MODE === "true";
  const customUrl = isTestMode
    ? "http://localhost:3002/v1/chat/completions"
    : `${customBaseUrl}/chat/completions`;

  const lowerModel = model.toLowerCase();
  const configuredCustomModel = (
    process.env.CUSTOM_MODEL_NAME || "gemma-4"
  ).trim();
  const configuredCustomModelLower = configuredCustomModel.toLowerCase();
  const customModelAliases = (process.env.CUSTOM_MODEL_ALIASES || "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  const matchesConfiguredCustomModel =
    lowerModel === configuredCustomModelLower ||
    customModelAliases.includes(lowerModel);

  // 1. Explicit prefix checks:
  if (lowerModel.startsWith("openrouter/")) {
    const actualModel = model.substring(11); // Strip "openrouter/"
    return {
      url: "https://openrouter.ai/api/v1/chat/completions",
      key: openRouterKey,
      actualModel,
      provider: "openrouter",
    };
  }

  if (lowerModel.startsWith("custom/")) {
    const actualModel = model.substring(7); // Strip "custom/"
    return {
      url: customUrl,
      key: customKey,
      actualModel,
      provider: "custom",
    };
  }

  if (lowerModel.startsWith("lmstudio/")) {
    const actualModel = model.substring(9); // Strip "lmstudio/"
    return {
      url: `${lmStudioUrl}/chat/completions`,
      key: "lmstudio-placeholder-key",
      actualModel,
      provider: "lmstudio",
    };
  }

  if (lowerModel.startsWith("openai/")) {
    const actualModel = model.substring(7); // Strip "openai/"
    return {
      url: "https://api.openai.com/v1/chat/completions",
      key: openAiKey,
      actualModel,
      provider: "openai",
    };
  }

  // 2. Fallback heuristic checks (no prefix):
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
      provider: "lmstudio",
    };
  }

  if (
    matchesConfiguredCustomModel ||
    lowerModel.includes("gemma-4") ||
    lowerModel.includes("qwen3-coder") ||
    lowerModel.includes("whiterabbitneo") ||
    lowerModel.includes("foundation-sec")
  ) {
    // Preserve original model name – do NOT replace with configuredCustomModel
    // unless the request already exactly matches it (to avoid sending "gemma-4" when user wants "qwen3-coder")
    const actualModel =
      lowerModel === configuredCustomModelLower ? configuredCustomModel : model;
    return {
      url: customUrl,
      key: customKey,
      actualModel,
      provider: "custom",
    };
  }

  if (
    lowerModel.includes("gemini") ||
    lowerModel.includes("llama") ||
    lowerModel.includes("qwen") ||
    lowerModel.includes("claude") ||
    lowerModel.includes("deepseek") ||
    lowerModel.includes("/")
  ) {
    return {
      url: "https://openrouter.ai/api/v1/chat/completions",
      key: openRouterKey,
      actualModel: model,
      provider: "openrouter",
    };
  }

  // Fallback to OpenAI
  return {
    url: "https://api.openai.com/v1/chat/completions",
    key: openAiKey,
    actualModel: model,
    provider: "openai",
  };
}

function normalizeUpstreamBody(
  body: any,
  upstream: ReturnType<typeof getUpstreamConfig>,
) {
  const upstreamBody: any = {
    ...body,
    model: upstream.actualModel,
  };

  if (upstream.provider === "custom") {
    const modelLower = upstream.actualModel.toLowerCase();
    // Always strip parallel_tool_calls: most custom/iahn models don't support it
    delete upstreamBody.parallel_tool_calls;

    if (modelLower.startsWith("gemma")) {
      // Gemma has no native OpenAI function calling – strip tools entirely
      delete upstreamBody.tools;
      delete upstreamBody.tool_choice;
      console.log(
        `\x1b[33m[Proxy]\x1b[0m Gemma: stripped tools (no native function calling) | ${upstream.actualModel}`,
      );
    } else {
      // qwen3-coder and others: keep tools, keep tool_choice
      console.log(
        `\x1b[32m[Proxy]\x1b[0m Custom: ${upstream.actualModel} | tools: ${upstreamBody.tools?.length ?? 0} | tool_choice: ${upstreamBody.tool_choice ?? "none"}`,
      );
    }
    return upstreamBody;
  }

  if (upstream.provider === "lmstudio") {
    delete upstreamBody.parallel_tool_calls;
    if (upstreamBody.tool_choice === "auto") {
      delete upstreamBody.tool_choice;
    }
  }

  return upstreamBody;
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

    const lastMsg =
      body.messages && body.messages.length > 0
        ? body.messages[body.messages.length - 1]
        : null;

    let classifierResultText = "";
    if (
      lastMsg &&
      lastMsg.role === "user" &&
      typeof lastMsg.content === "string"
    ) {
      try {
        const res = await classifyPrompt(lastMsg.content);
        if (res && res.label) {
          const formattedLabel = res.label.toLowerCase();
          const confidencePct = `${(res.confidence * 100).toFixed(1)}%`;
          console.log(
            `\x1b[32m[Classifier]\x1b[0m ➔ ${formattedLabel} (${confidencePct})`,
          );
          classifierResultText = `__CLASSIFIER_RESULT__:{"label":"${res.label}","confidence":${res.confidence}}\n\n`;
        }
      } catch (e) {
        console.error("[Classifier] Error during classification:", e);
      }
    }

    const model = body.model || "gpt-4o";
    const upstream = getUpstreamConfig(model, token);
    const remainingBudget = user.monthlyTokenLimit - user.tokensConsumed;

    console.log(
      `\x1b[36m[Proxy]\x1b[0m ➔ Request: ${model} | Stream: ${body.stream} | Budget: ${remainingBudget}`,
    );
    // console.log(
    //   `\x1b[36m[Proxy]\x1b[0m ➔ Messages Count: ${body.messages?.length ?? 0}`,
    // );
    // if (Array.isArray(body.messages)) {
    //   for (const msg of body.messages) {
    //     const contentStr = typeof msg.content === "string"
    //       ? msg.content
    //       : Array.isArray(msg.content)
    //         ? JSON.stringify(msg.content)
    //         : "";
    //     console.log(`  - [${msg.role}]: ${contentStr.slice(0, 120).replace(/\n/g, " ")}`);
    //   }
    // }

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

    const upstreamBody = normalizeUpstreamBody(body, upstream);
    if (body.stream) {
      // Only inject stream_options for providers known to support it (OpenAI, OpenRouter)
      // iahn/custom and LM Studio may reject this field with 400/422
      if (
        upstream.provider === "openai" ||
        upstream.provider === "openrouter"
      ) {
        upstreamBody.stream_options = { include_usage: true };
      }
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
      console.log(
        `\x1b[36m[Proxy]\x1b[0m ➔ Completed | Total: ${totalConsumed} tokens`,
      );

      // Override usage for client display
      responseData.usage = {
        prompt_tokens: upstreamUsage?.prompt_tokens ?? inputTokens,
        completion_tokens:
          upstreamUsage?.completion_tokens ?? totalConsumed - inputTokens,
        total_tokens: totalConsumed,
      };

      let hasToolCalls =
        Array.isArray(responseData.choices?.[0]?.message?.tool_calls) &&
        responseData.choices[0].message.tool_calls.length > 0;

      // Convert XML tool call in non-streaming response if present
      const content = responseData.choices?.[0]?.message?.content || "";
      if (!hasToolCalls && content.includes("<function=")) {
        const cleanContent = content.replace(/<\/tool_call>/g, "");
        const parsedTool = parseXmlToolCall(cleanContent);
        if (parsedTool) {
          const funcIdx = cleanContent.indexOf("<function=");
          const leadingText = cleanContent.substring(0, funcIdx).trim();
          responseData.choices[0].message.content = leadingText || null;
          responseData.choices[0].message.tool_calls = [
            {
              id: "call_" + Math.random().toString(36).substring(2, 11),
              type: "function",
              function: {
                name: parsedTool.name,
                arguments: JSON.stringify(parsedTool.arguments),
              },
            },
          ];
          hasToolCalls = true;
        }
      }

      // Only inject classifier into plain text replies.
      if (
        classifierResultText &&
        responseData.choices?.[0]?.message &&
        !hasToolCalls
      ) {
        responseData.choices[0].message.content =
          classifierResultText +
          (responseData.choices[0].message.content || "");
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
      const toolCallConverter = new XmlToolCallConverter();
      let completionText = "";
      let accumulatedBuffer = "";
      let isTerminated = false;
      let upstreamTotalTokens: number | null = null;

      let classifierChunkSent = false;
      let classifierSuppressedForToolCalls = false;

      const emitSyntheticUsageAndDone = async () => {
        // Flush any remaining tool call buffer
        const flushedDeltas = toolCallConverter.flush();
        for (const convDelta of flushedDeltas) {
          const flushChunk = {
            choices: [
              {
                index: 0,
                delta: convDelta.delta,
                finish_reason: null,
              },
            ],
          };
          await stream.writeSSE({ data: JSON.stringify(flushChunk) });
        }

        if (upstreamTotalTokens === null) {
          const finalOutputTokens = countTokens(completionText);
          const totalConsumed = inputTokens + finalOutputTokens;

          const usageChunk = {
            choices: [],
            usage: {
              prompt_tokens: inputTokens,
              completion_tokens: finalOutputTokens,
              total_tokens: totalConsumed,
            },
          };
          await stream.writeSSE({ data: JSON.stringify(usageChunk) });
        }
        await stream.writeSSE({ data: "[DONE]" });
        await stream.close();
        isTerminated = true;
      };

      const handleSseLine = async (trimmed: string) => {
        if (!trimmed) return;

        if (trimmed === "data: [DONE]") {
          await emitSyntheticUsageAndDone();
          return;
        }

        if (!trimmed.startsWith("data: ")) {
          return;
        }

        const rawJson = trimmed.substring(6);
        try {
          const parsed = JSON.parse(rawJson);
          const delta = parsed.choices?.[0]?.delta;

          // Normalize reasoning field names → unified "reasoning_content"
          // Different models use: reasoning_content (DeepSeek/Qwen), reasoning, thinking (Gemma/Anthropic)
          if (delta) {
            if (delta.reasoning && !delta.reasoning_content) {
              delta.reasoning_content = delta.reasoning;
            }
            if (delta.thinking && !delta.reasoning_content) {
              delta.reasoning_content = delta.thinking;
            }
          }

          const hasToolCalls =
            Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0;
          const hasContentDelta =
            typeof delta?.content === "string" && delta.content.length > 0;

          if (
            !classifierChunkSent &&
            !classifierSuppressedForToolCalls &&
            classifierResultText
          ) {
            if (hasToolCalls) {
              classifierSuppressedForToolCalls = true;
            } else if (hasContentDelta) {
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
              classifierChunkSent = true;
            }
          }

          if (parsed.usage) {
            const u = parsed.usage;
            const total =
              u.total_tokens ??
              (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0);
            if (typeof total === "number" && total > 0) {
              upstreamTotalTokens = total;

              parsed.usage = {
                prompt_tokens: u.prompt_tokens ?? inputTokens,
                completion_tokens: u.completion_tokens ?? total - inputTokens,
                total_tokens: total,
              };
            }
          }

          const content = delta?.content || "";
          const reasoning = delta?.reasoning_content || delta?.reasoning || "";
          completionText += content + reasoning;

          const outputTokens = countTokens(completionText);
          const totalConsumed = inputTokens + outputTokens;

          if (totalConsumed >= remainingBudget) {
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
                prompt_tokens: inputTokens,
                completion_tokens: outputTokens,
                total_tokens: totalConsumed,
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
            return;
          }

          if (delta && typeof delta.content === "string") {
            const convertedDeltas = toolCallConverter.processChunk(
              delta.content,
            );
            for (const convDelta of convertedDeltas) {
              if (convDelta.delta.tool_calls) {
                classifierSuppressedForToolCalls = true;
              }
              const newParsed = {
                ...parsed,
                choices: [
                  {
                    ...parsed.choices[0],
                    delta: {
                      ...delta,
                      ...convDelta.delta,
                    },
                  },
                ],
              };
              await stream.writeSSE({ data: JSON.stringify(newParsed) });
            }
          } else {
            await stream.writeSSE({ data: JSON.stringify(parsed) });
          }
        } catch (err) {
          await stream.writeSSE({ data: rawJson });
        }
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            accumulatedBuffer += decoder.decode();
            const trailing = accumulatedBuffer.trim();
            if (trailing && !isTerminated) {
              await handleSseLine(trailing);
            }
            break;
          }

          accumulatedBuffer += decoder.decode(value, { stream: true });
          const lines = accumulatedBuffer.split("\n");
          accumulatedBuffer = lines.pop() || ""; // Hold incomplete line in buffer

          for (const line of lines) {
            const trimmed = line.trim();
            await handleSseLine(trimmed);
            if (isTerminated) break;
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
        console.log(
          `\x1b[36m[Proxy]\x1b[0m ➔ Completed | Total: ${totalConsumed} tokens`,
        );
        await recordTokenUsage(totalConsumed);
      }
    });
  },
);

export { chatRouter };
