import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@vercel/functions", "ioredis", "ws"],
};

export default nextConfig;
