import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadRootEnv();
/** @type {import('next').NextConfig} */
const apiBases = resolveApiBases();

function loadRootEnv() {
  const envPath = path.resolve(__dirname, "../..", ".env");
  if (!fs.existsSync(envPath)) return;
  const contents = fs.readFileSync(envPath, "utf8");
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (process.env[key] !== undefined) continue;
    const rawValue = line.slice(separator + 1).trim();
    const quoted = (rawValue.startsWith("\"") && rawValue.endsWith("\"")) || (rawValue.startsWith("'") && rawValue.endsWith("'"));
    process.env[key] = quoted ? rawValue.slice(1, -1) : rawValue;
  }
}

function resolveApiBases() {
  if (process.env.NODE_ENV === "production" && process.env.NEXT_PUBLIC_INSTANTML_API_BASE && !process.env.INSTANTML_API_BASE) {
    throw new Error("Use server-only INSTANTML_API_BASE for production rewrites.");
  }
  const rawDefault = process.env.INSTANTML_API_BASE ?? process.env.NEXT_PUBLIC_INSTANTML_API_BASE ?? "http://127.0.0.1:8000";
  const rawControl = process.env.INSTANTML_CONTROL_API_BASE;
  const rawData = process.env.INSTANTML_DATA_API_BASE;
  const splitDefault = rawControl && rawData ? rawControl : rawDefault;
  return {
    default: resolveApiBase("INSTANTML_API_BASE", splitDefault),
    control: resolveApiBase("INSTANTML_CONTROL_API_BASE", rawControl ?? rawDefault),
    data: resolveApiBase("INSTANTML_DATA_API_BASE", rawData ?? rawDefault),
  };
}

function resolveApiBase(name, rawBase) {
  const url = new URL(rawBase);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error(`${name} must be an http(s) URL.`);
  const allowedOrigins = (process.env.INSTANTML_API_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (allowedOrigins.length && !allowedOrigins.includes(url.origin)) {
    throw new Error(`${name} origin ${url.origin} is not in INSTANTML_API_ALLOWED_ORIGINS.`);
  }
  if (process.env.NODE_ENV === "production" && !allowedOrigins.length && !loopback) {
    throw new Error("Set INSTANTML_API_ALLOWED_ORIGINS for production API rewrites.");
  }
  return `${url.origin}${url.pathname.replace(/\/$/, "")}`;
}

const clerkConnect = "https://api.clerk.com https://*.clerk.accounts.dev https://*.clerk.dev https://*.clerk.com";
const clerkAssets = "https://img.clerk.com https://images.clerk.dev https://*.clerk.accounts.dev https://*.clerk.dev https://*.clerk.com";
const securityHeaders = [
  { key: "Content-Security-Policy", value: `default-src 'self'; base-uri 'self'; frame-ancestors 'none'; object-src 'none'; form-action 'self' https://*.clerk.accounts.dev https://*.clerk.dev https://*.clerk.com; img-src 'self' data: blob: ${clerkAssets}; connect-src 'self' http://127.0.0.1:* http://localhost:* ${clerkConnect}; frame-src ${clerkConnect} https://challenges.cloudflare.com; script-src 'self' 'unsafe-inline' 'unsafe-eval' ${clerkConnect} https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:` },
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
      { source: "/api/auth/:path*", destination: `${apiBases.control}/api/auth/:path*` },
      { source: "/api/users", destination: `${apiBases.control}/api/users` },
      { source: "/api/users/:path*", destination: `${apiBases.control}/api/users/:path*` },
      { source: "/api/orgs", destination: `${apiBases.control}/api/orgs` },
      { source: "/api/orgs/:path*", destination: `${apiBases.control}/api/orgs/:path*` },
      { source: "/api/:path*", destination: `${apiBases.data}/api/:path*` },
      { source: "/runs/:path*", destination: `${apiBases.data}/runs/:path*` },
      { source: "/projects", destination: `${apiBases.data}/projects` },
      { source: "/health", destination: `${apiBases.default}/health` },
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
