import type { NextConfig } from "next";

const BACKEND = process.env.BACKEND_URL ?? "http://localhost:3001";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${BACKEND}/:path*`,
      },
    ];
  },
};

export default nextConfig;
