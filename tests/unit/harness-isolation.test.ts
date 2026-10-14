import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { createPublicClient, http } from "viem";
import { startHardhatNode, stopHardhatNode } from "../harness/local-chain";

describe("local chain process isolation", () => {
  it("skips an occupied RPC port and shuts down its own node", async () => {
    const existing = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x7a69" }));
    });
    await new Promise<void>((resolve) => existing.listen(0, "127.0.0.1", resolve));
    const address = existing.address();
    if (!address || typeof address === "string") throw new Error("no listening port");
    let boot: Awaited<ReturnType<typeof startHardhatNode>> | null = null;
    try {
      boot = await startHardhatNode({ port: address.port });
      expect(new URL(boot.rpcUrl).port).not.toBe(String(address.port));
      const rpc = createPublicClient({ transport: http(boot.rpcUrl, { retryCount: 0, timeout: 200 }) });
      expect(await rpc.getChainId()).toBe(31337);
      await stopHardhatNode(boot.process);
      await expect(rpc.getChainId()).rejects.toThrow();
    } finally {
      if (boot) await stopHardhatNode(boot.process);
      await new Promise<void>((resolve) => existing.close(() => resolve()));
    }
  });
});
