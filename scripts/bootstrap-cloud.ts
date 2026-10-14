/** Deliberately separate from the public server: release deployment SDK memory. */
import { hardhat } from "viem/chains";
import { deployLocalDemo } from "../tests/harness/local-chain";
import { pathToFileURL } from "node:url";

const contextPath = process.env.LOCAL_CHAIN_CONTEXT;
if (!contextPath) throw new Error("Missing cloud context file");
await deployLocalDemo({
  chain: { ...hardhat, id: 31338 },
  rpcUrl: "http://127.0.0.1:18546",
  contextFile: pathToFileURL(contextPath),
});
