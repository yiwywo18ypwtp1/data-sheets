import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  experimental: {
    // CSV import sends batches of up to 1 000 rows through a Server Action; the client keeps each under ~3 MB.
    serverActions: { bodySizeLimit: "4mb" },
    // Offline, a navigation or Server Action waits and is retried when the network is back, instead of failing.
    useOffline: true,
  },
  // The service worker must always be fetched fresh, or an old one would keep serving old pages.
  async headers() {
    return [{ source: "/sw.js", headers: [{ key: "Cache-Control", value: "no-cache, no-store, must-revalidate" }] }];
  },
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
