import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Isolate production verification from a running laptop dev server.
  distDir: process.env.SWARM_TAB_DIST_DIR ?? ".next",
  /**
   * The laptop run is documented as http://127.0.0.1:PORT. Next.js treats that
   * as a cross-origin dev host and otherwise blocks its own HMR/font/chunk
   * resources, which breaks hydration. Allow both local spellings.
   */
  allowedDevOrigins: ["127.0.0.1", "localhost"],
};

export default nextConfig;
