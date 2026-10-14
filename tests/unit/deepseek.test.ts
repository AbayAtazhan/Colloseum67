import { describe, expect, it, vi } from "vitest";
import {
  DeepSeekClient,
  DeepSeekNoBalanceError,
  DeepSeekRateLimitError,
  DeepSeekUnavailableError,
} from "@/agents/deepseek";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const successBody = {
  model: "deepseek-flash",
  choices: [
    {
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "code_facts", arguments: '{"address":"0xabc"}' },
          },
        ],
      },
    },
  ],
  usage: {
    prompt_tokens: 120,
    completion_tokens: 30,
    total_tokens: 150,
    prompt_cache_hit_tokens: 10,
  },
};

describe("DeepSeek client (non-thinking tool calling)", () => {
  it("sends the documented non-thinking tool-calling body and parses the call", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(successBody)) as unknown as typeof fetch;
    const client = new DeepSeekClient({ apiKey: "test-key", fetchImpl });
    const result = await client.chat({
      messages: [{ role: "user", content: "get code facts" }],
      tools: [
        {
          type: "function",
          function: {
            name: "code_facts",
            description: "facts",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
      maxTokens: 800,
    });

    const [url, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } })
      .mock.calls[0];
    expect(url).toBe("https://api.deepseek.com/chat/completions");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.model).toBe("deepseek-flash");
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.max_tokens).toBe(800);
    expect(body.tool_choice).toBe("auto");
    expect(body.temperature).toBe(0);

    expect(result.message.tool_calls?.[0].function.name).toBe("code_facts");
    expect(result.usage).toEqual({
      promptTokens: 120,
      completionTokens: 30,
      totalTokens: 150,
      cachedTokens: 10,
    });
  });

  it("classifies 402 as a non-retryable balance problem", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { message: "Insufficient Balance" } }, 402),
    ) as unknown as typeof fetch;
    const client = new DeepSeekClient({ apiKey: "k", fetchImpl, maxRetries: 2 });
    await expect(
      client.chat({ messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toBeInstanceOf(DeepSeekNoBalanceError);
    expect((fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(1);
  });

  it("retries transient 429 and then surfaces the rate limit", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { message: "rate limited" } }, 429),
    ) as unknown as typeof fetch;
    const client = new DeepSeekClient({ apiKey: "k", fetchImpl, maxRetries: 2 });
    await expect(
      client.chat({ messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toBeInstanceOf(DeepSeekRateLimitError);
    expect((fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(3);
  });

  it("recovers when a transient 500 is followed by a success", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: { message: "boom" } }, 500))
      .mockResolvedValueOnce(
        jsonResponse({
          model: "deepseek-flash",
          choices: [{ message: { role: "assistant", content: "ok" } }],
          usage: {},
        }),
      ) as unknown as typeof fetch;
    const client = new DeepSeekClient({ apiKey: "k", fetchImpl, maxRetries: 2 });
    const result = await client.chat({
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.message.content).toBe("ok");
  });

  it("aborts and reports a timeout", async () => {
    const fetchImpl = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("aborted")),
        );
      })) as unknown as typeof fetch;
    const client = new DeepSeekClient({
      apiKey: "k",
      fetchImpl,
      maxRetries: 0,
    });
    await expect(
      client.chat({
        messages: [{ role: "user", content: "hi" }],
        timeoutMs: 20,
      }),
    ).rejects.toBeInstanceOf(DeepSeekUnavailableError);
  });

  it("does not retry an ambiguous transport failure that might already be billed", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("connection lost"); });
    const client = new DeepSeekClient({ apiKey: "k", fetchImpl, maxRetries: 2 });
    await expect(client.chat({ messages: [{ role: "user", content: "hi" }] }))
      .rejects.toBeInstanceOf(DeepSeekUnavailableError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keeps the timeout active while receiving the response body", async () => {
    let wasAborted = false;
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => ({
      ok: true,
      text: () => new Promise<string>((resolve, reject) => {
        const stalledBody = setTimeout(() => resolve(JSON.stringify(successBody)), 100);
        init?.signal?.addEventListener("abort", () => {
          wasAborted = true;
          clearTimeout(stalledBody);
          reject(new Error("body aborted"));
        });
      }),
    } as Response)) as unknown as typeof fetch;
    const client = new DeepSeekClient({ apiKey: "k", fetchImpl, maxRetries: 0 });
    await expect(client.chat({
      messages: [{ role: "user", content: "hi" }], timeoutMs: 20,
    })).rejects.toBeInstanceOf(DeepSeekUnavailableError);
    expect(wasAborted).toBe(true);
  });
});
