/**
 * DeepSeek connectivity check (run when DEEPSEEK_API_KEY is available):
 *   1. one real non-thinking chat request;
 *   2. one full tool-calling round trip (model call -> tool result -> final answer).
 *
 * Without a key the script prints the exact remaining setup step and exits 0
 * without pretending to have called the model.
 *
 * Usage: npm run deepseek:check
 */
import "dotenv/config";
import {
  DeepSeekClient,
  type ChatMessage,
  type ToolDefinition,
} from "@/agents/deepseek";
import { resolveLlmConfig } from "@/agents/llm";

const tools: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "echo_fact",
      description: "Return a fact about an address. Test tool for the setup check.",
      parameters: {
        type: "object",
        properties: {
          address: { type: "string", description: "EVM address" },
        },
        required: ["address"],
        additionalProperties: false,
      },
    },
  },
];

async function main(): Promise<void> {
  const config = resolveLlmConfig();
  if (!config.apiKey) {
    console.log("DEEPSEEK_API_KEY is not configured.");
    console.log(
      "Add it to .env (server-side only) and re-run `npm run deepseek:check`.",
    );
    console.log(
      "Local UI runs without the key use the clearly-labelled fixture LLM: SWARM_TAB_FAKE_LLM=1 via `npm run dev:local`.",
    );
    return;
  }

  const client = new DeepSeekClient({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.model,
    defaultTimeoutMs: 60_000,
    maxRetries: 2,
  });

  console.log(`1) plain request (model ${config.model}, non-thinking mode)`);
  const plain = await client.chat({
    messages: [{ role: "user", content: "Reply with the single word: ready" }],
    maxTokens: 16,
  });
  console.log(
    `   content: ${JSON.stringify(plain.message.content)} usage=${JSON.stringify(plain.usage)}`,
  );

  console.log("2) tool-calling round trip");
  const messages: ChatMessage[] = [
    {
      role: "user",
      content:
        "Call echo_fact for address 0x036CbD53842c5426634e7929541eC2318f3dCF7e, then confirm in one sentence.",
    },
  ];
  const first = await client.chat({ messages, tools, maxTokens: 200 });
  messages.push(first.message);
  const call = first.message.tool_calls?.[0];
  if (!call) {
    console.log(
      `   model did not call the tool (content=${JSON.stringify(first.message.content)})`,
    );
    console.log("   usage:", JSON.stringify(first.usage));
    return;
  }
  console.log(
    `   tool call: ${call.function.name}(${call.function.arguments})`,
  );
  messages.push({
    role: "tool",
    tool_call_id: call.id,
    name: call.function.name,
    content: JSON.stringify({
      address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      fact: "official Circle test USDC on Base Sepolia",
    }),
  });
  const second = await client.chat({ messages, tools, maxTokens: 200 });
  console.log(`   final: ${JSON.stringify(second.message.content)}`);
  console.log("   usage:", JSON.stringify(second.usage));
  console.log("DeepSeek check complete.");
}

main().catch((error) => {
  console.error(
    "DeepSeek check failed:",
    error instanceof Error ? `${error.name}: ${error.message}` : error,
  );
  process.exitCode = 1;
});
