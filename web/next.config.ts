import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // web/ is one app in a repo with pi/; don't let Turbopack pick a parent lockfile as the root
  turbopack: { root: __dirname },
};

export default nextConfig;
