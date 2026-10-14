import { build } from "esbuild";

// Bundle project modules only. SDK dependencies stay in node_modules; the
// public server's bundle never imports the heavy deployment SDK.
await build({
  entryPoints: ["scripts/start-cloud.ts", "scripts/bootstrap-cloud.ts"],
  outdir: "build",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  target: "node24",
});
