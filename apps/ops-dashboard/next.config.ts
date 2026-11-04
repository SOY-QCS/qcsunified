import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Shared workspace packages are TypeScript source; let Next compile them.
  transpilePackages: ["@qcs/ui", "@qcs/config", "@qcs/types", "@qcs/api-client", "@qcs/pricing"],
};

export default nextConfig;
