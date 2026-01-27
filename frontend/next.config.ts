import type { NextConfig } from "next";

const backendBaseUrl = (process.env.API_BASE_URL || process.env.NEXT_PUBLIC_API_BASE_URL || '')
  .replace(/\/$/, '');

const nextConfig: NextConfig = {
  async rewrites() {
    if (!backendBaseUrl) {
      return [];
    }
    return [
      {
        source: '/api/:path*',
        destination: `${backendBaseUrl}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
