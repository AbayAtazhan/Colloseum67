import { Store } from "./store";

let defaultStore: Store | null = null;

/**
 * Lazily opened process-wide store. Uses DATABASE_PATH from the environment
 * (default: ./data/swarm-tab.db). Only server code may import this module.
 */
export function getDefaultStore(): Store {
  if (!defaultStore) {
    defaultStore = new Store(process.env.DATABASE_PATH ?? "./data/swarm-tab.db");
  }
  return defaultStore;
}

export { Store } from "./store";
export type { CreateMissionInput, TransitionPatch } from "./store";
