import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Abi, Hex } from "viem";

export const PROJECT_ROOT = process.env.SWARM_TAB_PROJECT_ROOT ?? fileURLToPath(new URL("../../", import.meta.url));

export interface HardhatArtifact {
  contractName: string;
  abi: Abi;
  bytecode: Hex;
}

export async function loadArtifact(
  contractFile: string,
  contractName: string,
): Promise<HardhatArtifact> {
  const path = `${PROJECT_ROOT}artifacts/contracts/${contractFile}/${contractName}.json`;
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as HardhatArtifact;
    if (!parsed.bytecode || !parsed.abi) {
      throw new Error("missing abi/bytecode");
    }
    return parsed;
  } catch (error) {
    throw new Error(
      `cannot load artifact ${path}; run "npm run contracts:compile" first (${String(error)})`,
    );
  }
}
