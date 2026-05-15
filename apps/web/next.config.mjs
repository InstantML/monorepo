import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** @type {import('next').NextConfig} */
const apiBase = resolveApiBase();

function resolveApiBase() {
  if (process.env.NODE_ENV === "production" && process.env.NEXT_PUBLIC_INSTANTML_API_BASE && !process.env.INSTANTML_API_BASE) {
    throw new Error("Use server-only INSTANTML_API_BASE for production rewrites.");
  }
  const rawBase = process.env.INSTANTML_API_BASE ?? process.env.NEXT_PUBLIC_INSTANTML_API_BASE ?? "http://127.0.0.1:8000";
  const url = new URL(rawBase);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("INSTANTML_API_BASE must be an http(s) URL.");
  const allowedOrigins = (process.env.INSTANTML_API_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (allowedOrigins.length && !allowedOrigins.includes(url.origin)) {
    throw new Error(`INSTANTML_API_BASE origin ${url.origin} is not in INSTANTML_API_ALLOWED_ORIGINS.`);
  }
  if (process.env.NODE_ENV === "production" && !allowedOrigins.length && !loopback) {
    throw new Error("Set INSTANTML_API_ALLOWED_ORIGINS for production API rewrites.");
  }
  return `${url.origin}${url.pathname.replace(/\/$/, "")}`;
}

const securityHeaders = [
  { key: "Content-Security-Policy", value: "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; object-src 'none'; form-action 'self'; img-src 'self' data: blob:; connect-src 'self' http://127.0.0.1:* http://localhost:*; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
];

const nextConfig = {
  devIndicators: false,
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  turbopack: {
    root: path.resolve(__dirname, "../.."),
  },
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${apiBase}/api/:path*` },
      { source: "/runs/:path*", destination: `${apiBase}/runs/:path*` },
      { source: "/projects", destination: `${apiBase}/projects` },
      { source: "/health", destination: `${apiBase}/health` },
    ];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
