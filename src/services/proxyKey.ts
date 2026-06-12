import { randomBytes } from "crypto";

export interface ProxyKeyConfig {
  value: string;
  source: "env" | "generated";
}

function createGeneratedProxyKey(): string {
  return `sk-${randomBytes(24).toString("hex")}`;
}

const envProxyKey = process.env.PROXY_API_KEY?.trim();

export const proxyKeyConfig: ProxyKeyConfig = envProxyKey
  ? {
      value: envProxyKey,
      source: "env",
    }
  : {
      value: createGeneratedProxyKey(),
      source: "generated",
    };

export function getProxyApiKey(): string {
  return proxyKeyConfig.value;
}
