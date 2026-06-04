import { get_encoding } from "tiktoken";

let encoder: any = null;

try {
  encoder = get_encoding("cl100k_base");
} catch (e) {
  console.warn(
    "[Tokenizer] Tiktoken failed to load. Falling back to approximate character-based tokenization.",
  );
}

export function countTokens(text: string): number {
  if (!text) return 0;
  if (encoder) {
    try {
      return encoder.encode(text).length;
    } catch (e) {
      // Fallback
    }
  }
  return Math.ceil(text.length / 4);
}

export function countMessagesTokens(
  messages: Array<{ role: string; content: string }>,
): number {
  let count = 0;
  for (const message of messages) {
    count += countTokens(message.role);
    count += countTokens(message.content);
    count += 4;
  }
  count += 3;
  return count;
}
