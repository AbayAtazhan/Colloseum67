/**
 * Minimal, dependency-free DeepSeek Chat Completions client.
 *
 * Uses the OpenAI-compatible endpoint documented at
 * https://api-docs.deepseek.com/guides/tool_calls/ and explicitly disables the
 * thinking mode with `"thinking": {"type": "disabled"}` as documented at
 * https://api-docs.deepseek.com/guides/thinking_mode/.
 */

export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
  name?: string;
  /** Present only if thinking mode was enabled; never sent in non-thinking mode. */
  reasoning_content?: string;
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  cachedTokens: number | null;
}

export interface ChatResult {
  message: ChatMessage;
  usage: ChatUsage;
  model: string;
}

export class DeepSeekError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "DeepSeekError";
  }
}

export class DeepSeekNoBalanceError extends DeepSeekError {
  constructor(message: string) {
    super(message, 402, false);
    this.name = "DeepSeekNoBalanceError";
  }
}

export class DeepSeekRateLimitError extends DeepSeekError {
  constructor(message: string) {
    super(message, 429, true);
    this.name = "DeepSeekRateLimitError";
  }
}

export class DeepSeekAuthError extends DeepSeekError {
  constructor(message: string) {
    super(message, 401, false);
    this.name = "DeepSeekAuthError";
  }
}

export class DeepSeekUnavailableError extends DeepSeekError {
  constructor(message: string) {
    // A lost connection/timeout may happen after the provider billed the call.
    // Only explicit 429/5xx responses are safe automatic retry candidates.
    super(message, null, false);
    this.name = "DeepSeekUnavailableError";
  }
}

export interface DeepSeekClientConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  defaultTimeoutMs?: number;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

interface DeepSeekResponseBody {
  model?: string;
  choices?: Array<{
    message?: {
      role?: string;
      content?: string | null;
      tool_calls?: ChatToolCall[];
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_cache_hit_tokens?: number;
  };
  error?: { message?: string; type?: string; code?: string };
}

export class DeepSeekClient {
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaultTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: DeepSeekClientConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? "https://api.deepseek.com").replace(/\/$/, "");
    this.model = config.model ?? "deepseek-flash";
    this.defaultTimeoutMs = config.defaultTimeoutMs ?? 60_000;
    this.maxRetries = config.maxRetries ?? 2;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async chat(input: {
    messages: ChatMessage[];
    tools?: ToolDefinition[];
    maxTokens?: number;
    timeoutMs?: number;
    temperature?: number;
  }): Promise<ChatResult> {
    // Non-thinking mode is requested explicitly; the API enables thinking by
    // default, so omitting this would change behaviour.
    const body: Record<string, unknown> = {
      model: this.model,
      messages: input.messages,
      max_tokens: input.maxTokens ?? 800,
      stream: false,
      thinking: { type: "disabled" },
      temperature: input.temperature ?? 0,
    };
    if (input.tools && input.tools.length > 0) {
      body.tools = input.tools;
      body.tool_choice = "auto";
    }

    let lastError: DeepSeekError | null = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        return await this.requestOnce(
          body,
          input.timeoutMs ?? this.defaultTimeoutMs,
        );
      } catch (error) {
        const normalized =
          error instanceof DeepSeekError
            ? error
            : new DeepSeekUnavailableError(
                error instanceof Error ? error.message : String(error),
              );
        lastError = normalized;
        if (!normalized.retryable || attempt === this.maxRetries) throw normalized;
        const backoffMs = 400 * 2 ** attempt + Math.floor(Math.random() * 150);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }
    throw lastError ?? new DeepSeekUnavailableError("DeepSeek request failed");
  }

  private async requestOnce(
    body: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<ChatResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    let text: string;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      // Keep the deadline active through the body, not just response headers.
      text = await response.text();
    } catch (error) {
      if (controller.signal.aborted) {
        throw new DeepSeekUnavailableError(
          `DeepSeek request timed out after ${timeoutMs}ms`,
        );
      }
      throw new DeepSeekUnavailableError(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      clearTimeout(timer);
    }

    let parsed: DeepSeekResponseBody | null = null;
    try {
      parsed = text ? (JSON.parse(text) as DeepSeekResponseBody) : null;
    } catch {
      parsed = null;
    }

    if (!response.ok) {
      const message =
        parsed?.error?.message ??
        `${response.status} ${response.statusText}`.trim();
      if (response.status === 402) {
        throw new DeepSeekNoBalanceError(`DeepSeek balance unavailable: ${message}`);
      }
      if (response.status === 429) {
        throw new DeepSeekRateLimitError(`DeepSeek rate limit: ${message}`);
      }
      if (response.status === 401 || response.status === 403) {
        throw new DeepSeekAuthError(`DeepSeek authentication failed: ${message}`);
      }
      throw new DeepSeekError(
        `DeepSeek error ${response.status}: ${message}`,
        response.status,
        RETRYABLE_STATUS.has(response.status),
      );
    }

    const message = parsed?.choices?.[0]?.message;
    if (!message) {
      throw new DeepSeekUnavailableError("DeepSeek response has no message");
    }
    const toolCalls = message.tool_calls?.map((call) => ({
      id: call.id,
      type: "function" as const,
      function: {
        name: call.function?.name ?? "",
        arguments: call.function?.arguments ?? "{}",
      },
    }));
    return {
      model: parsed?.model ?? this.model,
      message: {
        role: "assistant",
        content: message.content ?? null,
        ...(toolCalls && toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      },
      usage: {
        promptTokens: parsed?.usage?.prompt_tokens ?? null,
        completionTokens: parsed?.usage?.completion_tokens ?? null,
        totalTokens: parsed?.usage?.total_tokens ?? null,
        cachedTokens: parsed?.usage?.prompt_cache_hit_tokens ?? null,
      },
    };
  }
}
