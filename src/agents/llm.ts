import { InfrastructureError } from "@/shared/errors";
import {
  DeepSeekClient,
  type ChatMessage,
  type ChatResult,
  type ChatToolCall,
  type ToolDefinition,
} from "./deepseek";

export interface LlmClient {
  readonly model: string;
  /** True when this is the explicitly-labelled deterministic test LLM. */
  readonly fixture: boolean;
  chat(input: {
    messages: ChatMessage[];
    tools?: ToolDefinition[];
    maxTokens?: number;
    timeoutMs?: number;
  }): Promise<ChatResult>;
}

export class LlmSetupRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmSetupRequiredError";
  }
}

export interface LlmRuntimeConfig {
  fixture: boolean;
  apiKey: string | null;
  baseUrl: string;
  model: string;
}

export function resolveLlmConfig(env: NodeJS.ProcessEnv = process.env): LlmRuntimeConfig {
  return {
    fixture: env.SWARM_TAB_FAKE_LLM === "1",
    apiKey: env.DEEPSEEK_API_KEY ?? null,
    baseUrl: env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
    model: env.DEEPSEEK_MODEL ?? "deepseek-flash",
  };
}

export function createLlmClient(
  config: LlmRuntimeConfig,
  fetchImpl?: typeof fetch,
): LlmClient {
  if (config.fixture) {
    if (!config.apiKey) {
      return new FixtureLlmClient();
    }
    // Even with a key present, the explicit fixture switch wins, but we keep
    // the model name visible so the UI never mistakes it for a live run.
    return new FixtureLlmClient();
  }
  if (!config.apiKey) {
    throw new LlmSetupRequiredError(
      "DEEPSEEK_API_KEY is not configured. Add it to .env, or run the local demo with SWARM_TAB_FAKE_LLM=1 (clearly labelled fixture mode).",
    );
  }
  return new DeepSeekLlmClient(
    new DeepSeekClient({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: config.model,
      defaultTimeoutMs: 60_000,
      maxRetries: 2,
      ...(fetchImpl ? { fetchImpl } : {}),
    }),
  );
}

class DeepSeekLlmClient implements LlmClient {
  readonly model: string;
  readonly fixture = false;

  constructor(private readonly client: DeepSeekClient) {
    this.model = client.model;
  }

  async chat(input: {
    messages: ChatMessage[];
    tools?: ToolDefinition[];
    maxTokens?: number;
    timeoutMs?: number;
  }): Promise<ChatResult> {
    return this.client.chat(input);
  }
}

/**
 * Deterministic, explicitly-labelled LLM used only in test mode
 * (`SWARM_TAB_FAKE_LLM=1`). It follows the same tool-calling protocol as the
 * real model so the whole orchestrator path is exercised.
 */
export class FixtureLlmClient implements LlmClient {
  readonly model = "fixture-deepseek-flash";
  readonly fixture = true;

  async chat(input: {
    messages: ChatMessage[];
    tools?: ToolDefinition[];
    maxTokens?: number;
    timeoutMs?: number;
  }): Promise<ChatResult> {
    const toolNames = new Set(
      (input.tools ?? []).map((tool) => tool.function.name),
    );
    const addresses = extractAddresses(
      [...input.messages].reverse().find((message) => message.role === "user")
        ?.content ?? "",
    );
    const toolMessages = input.messages.filter(
      (message) => message.role === "tool",
    );

    const calls: ChatToolCall[] = [];
    if (toolNames.has("code_facts")) {
      addresses.slice(0, 2).forEach((address, index) => {
        if (!hasToolResult(toolMessages, "code_facts", address)) {
          calls.push(fixtureToolCall(`code-${index}`, "code_facts", {
            providerId: "code",
            address,
          }));
        }
      });
    } else if (toolNames.has("market_snapshot") || toolNames.has("exit_quotes")) {
      const name = toolNames.has("market_snapshot") ? "market_snapshot" : "exit_quotes";
      const address = addresses[0];
      if (address) {
        if (!toolMessages.some((message) => message.name === name)) {
          calls.push(fixtureToolCall("market-base", name, { providerId: name === "market_snapshot" ? "market" : "exit",
            address, ...(addresses[1] ? { compareAddress: addresses[1] } : {}), ...(name === "exit_quotes" ? { depth: false } : {}) }));
        } else if (name === "exit_quotes" && toolMessages.filter((message) => message.name === name).length === 1) {
          calls.push(fixtureToolCall("exit-depth", name, { providerId: "exit", address,
            ...(addresses[1] ? { compareAddress: addresses[1] } : {}), depth: true }));
        }
      }
    } else if (toolNames.has("address_activity")) {
      const address = addresses[0];
      if (address && !hasToolResult(toolMessages, "address_activity", address)) {
        calls.push(
          fixtureToolCall("activity-0", "address_activity", {
            providerId: "activity",
            address,
          }),
        );
      }
    }

    if (calls.length > 0) {
      return {
        model: this.model,
        message: {
          role: "assistant",
          content: null,
          tool_calls: calls,
        },
        usage: fixtureUsage(),
      };
    }

    const settled = toolMessages
      .map((message) => message.content ?? "")
      .filter((content) => content.includes('"ok":true'));
    const rejected = toolMessages
      .map((message) => message.content ?? "")
      .filter((content) => content.includes('"ok":false'));
    const summary = [
      "Fixture mode (test LLM): no live DeepSeek call was made.",
      `Paid data points received: ${settled.length}; refusals: ${rejected.length}.`,
      ...settled.slice(0, 4),
      ...rejected.slice(0, 2),
    ].join("\n");
    return {
      model: this.model,
      message: { role: "assistant", content: summary },
      usage: fixtureUsage(),
    };
  }
}

function fixtureUsage() {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
  };
}

function fixtureToolCall(
  id: string,
  name: string,
  args: Record<string, unknown>,
): ChatToolCall {
  return {
    id: `fixture-${id}`,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

function extractAddresses(text: string): string[] {
  const matches = text.match(/0x[0-9a-fA-F]{40}/g) ?? [];
  return [...new Set(matches.map((value) => value.toLowerCase()))];
}

function hasToolResult(
  messages: ChatMessage[],
  toolName: string,
  address: string,
): boolean {
  return messages.some(
    (message) =>
      message.role === "tool" &&
      message.name === toolName &&
      (message.content ?? "").toLowerCase().includes(address.toLowerCase()),
  );
}

export function asInfrastructureError(error: unknown): InfrastructureError {
  return error instanceof InfrastructureError
    ? error
    : new InfrastructureError(error instanceof Error ? error.message : String(error));
}
