import { bootstrapLocalChain, stopHardhatNode } from "./local-chain";

let child: Awaited<ReturnType<typeof bootstrapLocalChain>>["process"] | null = null;

export default async function setup(): Promise<() => Promise<void>> {
  const bootstrapped = await bootstrapLocalChain();
  child = bootstrapped.process;
  return async () => {
    await stopHardhatNode(child);
  };
}
