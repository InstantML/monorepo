import path from "node:path";

const clerkSources = "https://*.clerk.accounts.dev https://*.clerk.com https://clerk.instantml.ai";

/** @type {import("next").NextConfig} */
const nextConfig = {
  devIndicators: false,
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  turbopack: {
    root: path.resolve(process.cwd(), "../.."),
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value:
              `default-src 'self'; base-uri 'self'; frame-ancestors 'none'; object-src 'none'; form-action 'self' ${clerkSources}; img-src 'self' data: https://img.clerk.com ${clerkSources}; connect-src 'self' ${clerkSources} https://clerk-telemetry.com; frame-src 'self' ${clerkSources}; script-src 'self' 'unsafe-inline' 'unsafe-eval' ${clerkSources}; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:`,
          },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
