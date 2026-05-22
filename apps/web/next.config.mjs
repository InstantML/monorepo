import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const hostedApiBases = Object.freeze({
  prod: "https://api.instantml.ai",
  staging: "https://staging.api.instantml.ai",
});
const hostedApiOrigins = Object.values(hostedApiBases).map((base) => new URL(base).origin);
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
  const webApiEnv = resolveWebApiEnv();
  const explicitHostedBases = isTruthy(process.env.INSTANTML_WEB_EXPLICIT_API_BASES);
  // Frontend deployments intentionally default to prod. Set
  // INSTANTML_WEB_API_ENV=staging only on staging/preview frontend builds.
  const hostedDefault = hostedApiBases[webApiEnv || "prod"];
  const useHostedDefault = webApiEnv && !explicitHostedBases;
  const rawDefault = useHostedDefault
    ? hostedDefault
    : process.env.INSTANTML_API_BASE ?? process.env.NEXT_PUBLIC_INSTANTML_API_BASE ?? hostedDefault;
  const rawControl = useHostedDefault ? hostedDefault : process.env.INSTANTML_CONTROL_API_BASE;
  const rawData = useHostedDefault ? hostedDefault : process.env.INSTANTML_DATA_API_BASE;
  const splitDefault = rawControl && rawData ? rawControl : rawDefault;
  return {
    default: resolveApiBase("INSTANTML_API_BASE", splitDefault),
    control: resolveApiBase("INSTANTML_CONTROL_API_BASE", rawControl ?? rawDefault),
    data: resolveApiBase("INSTANTML_DATA_API_BASE", rawData ?? rawDefault),
  };
}

function resolveWebApiEnv() {
  const raw = (process.env.INSTANTML_WEB_API_ENV ?? "").trim().toLowerCase();
  if (!raw) return "";
  if (["prod", "production"].includes(raw)) return "prod";
  if (["stage", "staging"].includes(raw)) return "staging";
  throw new Error("INSTANTML_WEB_API_ENV must be prod or staging.");
}

function isTruthy(value) {
  return ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase());
}

function resolveApiBase(name, rawBase) {
  const url = new URL(rawBase);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error(`${name} must be an http(s) URL.`);
  const allowedOrigins = (process.env.INSTANTML_API_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  const firstPartyHostedApi = hostedApiOrigins.includes(url.origin);
  if (allowedOrigins.length && !allowedOrigins.includes(url.origin) && !firstPartyHostedApi) {
    throw new Error(`${name} origin ${url.origin} is not in INSTANTML_API_ALLOWED_ORIGINS.`);
  }
  if (process.env.NODE_ENV === "production" && !allowedOrigins.length && !loopback && !firstPartyHostedApi) {
    throw new Error("Set INSTANTML_API_ALLOWED_ORIGINS for production API rewrites.");
  }
  return `${url.origin}${url.pathname.replace(/\/$/, "")}`;
}

const clerkConnect = "https://api.clerk.com https://*.clerk.accounts.dev https://*.clerk.dev https://*.clerk.com https://clerk.instantml.ai";
const clerkAssets = "https://img.clerk.com https://images.clerk.dev https://*.clerk.accounts.dev https://*.clerk.dev https://*.clerk.com https://clerk.instantml.ai";
const stripeConnect = "https://api.stripe.com https://checkout.stripe.com https://billing.stripe.com";
const securityHeaders = [
  { key: "Content-Security-Policy", value: `default-src 'self'; base-uri 'self'; frame-ancestors 'none'; object-src 'none'; form-action 'self' https://*.clerk.accounts.dev https://*.clerk.dev https://*.clerk.com https://checkout.stripe.com https://billing.stripe.com; img-src 'self' data: blob: ${clerkAssets}; connect-src 'self' http://127.0.0.1:* http://localhost:* ${clerkConnect} ${stripeConnect}; frame-src ${clerkConnect} https://challenges.cloudflare.com https://checkout.stripe.com https://billing.stripe.com; script-src 'self' 'unsafe-inline' 'unsafe-eval' ${clerkConnect} https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:` },
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
      { source: "/api/invitations/:path*", destination: `${apiBases.control}/api/invitations/:path*` },
      { source: "/api/billing/:path*", destination: `${apiBases.control}/api/billing/:path*` },
      { source: "/api/users", destination: `${apiBases.control}/api/users` },
      { source: "/api/users/:path*", destination: `${apiBases.control}/api/users/:path*` },
      { source: "/api/orgs", destination: `${apiBases.control}/api/orgs` },
      { source: "/api/orgs/:path*", destination: `${apiBases.control}/api/orgs/:path*` },
      { source: "/api/dashboard/preferences", destination: `${apiBases.control}/api/dashboard/preferences` },
      { source: "/api/workspace-views", destination: `${apiBases.control}/api/workspace-views` },
      { source: "/api/workspace-views/:path*", destination: `${apiBases.control}/api/workspace-views/:path*` },
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
      {
        source: "/invite",
        headers: [
          { key: "Cache-Control", value: "no-store" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
    ];
  },
};

export default nextConfig;
