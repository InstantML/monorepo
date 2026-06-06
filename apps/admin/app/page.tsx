import { currentUser } from "@clerk/nextjs/server";
import { headers } from "next/headers";
import { AdminAccessPanel } from "./access-panel";
import { AdminConsole } from "../src/admin-console";
import {
  adminAllowedEmailLabel,
  canLoadClerkForRequest,
  isAdminEmailAllowed,
  parseAdminAllowedEmails,
} from "../src/admin-auth.mjs";
import { fetchAdminOverview } from "../src/admin-data";
import { LogoMark } from "../src/logo-mark";

type PageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

type AdminViewer = {
  email: string;
  name: string | null;
};

export const dynamic = "force-dynamic";

function firstParam(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

export default async function AdminPage({ searchParams }: PageProps) {
  const allowedEmails = parseAdminAllowedEmails(process.env.INSTANTML_ADMIN_ALLOWED_EMAILS);
  const allowedEmailLabel = adminAllowedEmailLabel(allowedEmails);
  const publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? process.env.CLERK_PUBLISHABLE_KEY;
  const secretKey = process.env.CLERK_SECRET_KEY;
  const requestHeaders = await headers();
  const requestHost = requestHeaders.get("host");
  const requestProtocol = requestHeaders.get("x-forwarded-proto") ?? "http";
  if (!publishableKey || !secretKey) {
    return (
      <AdminAccessPanel
        mode="setup"
        allowedEmailLabel={allowedEmailLabel}
        message="Set NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY or CLERK_PUBLISHABLE_KEY plus CLERK_SECRET_KEY before starting the admin app."
      />
    );
  }
  if (!canLoadClerkForRequest(publishableKey, requestHost, requestProtocol)) {
    return (
      <AdminAccessPanel
        mode="setup"
        allowedEmailLabel={allowedEmailLabel}
        message="Production Clerk keys require an HTTPS instantml.ai host. Use Clerk development keys for localhost, or test this app at https://admin.instantml.ai."
      />
    );
  }

  let viewer: AdminViewer | null = null;
  try {
    viewer = await loadAdminViewer();
  } catch {
    return (
      <AdminAccessPanel
        mode="setup"
        allowedEmailLabel={allowedEmailLabel}
        message="Unable to verify the Clerk admin session. Check that the admin app uses the same Clerk publishable and secret keys."
      />
    );
  }
  if (!viewer) {
    return <AdminAccessPanel mode="signed-out" allowedEmailLabel={allowedEmailLabel} />;
  }

  if (!isAdminEmailAllowed(viewer.email, allowedEmails)) {
    return (
      <AdminAccessPanel
        mode="denied"
        allowedEmailLabel={allowedEmailLabel}
        currentEmail={viewer.email}
      />
    );
  }

  const params = searchParams ? await searchParams : {};
  const q = firstParam(params.q);
  const result = await fetchAdminOverview({ q });

  if (!result.ok) {
    return (
      <main className="setup-shell">
        <section className="setup-panel">
          <div className="brand-lockup">
            <span className="brand-mark">
              <LogoMark />
            </span>
            <div>
              <p>InstantML Admin</p>
              <h1>Operator overview unavailable</h1>
            </div>
          </div>
          <p className="setup-copy">{result.message}</p>
          <dl className="setup-list">
            <div>
              <dt>API base</dt>
              <dd>{result.apiBase}</dd>
            </div>
            <div>
              <dt>Environment</dt>
              <dd>{result.environment}</dd>
            </div>
          </dl>
        </section>
      </main>
    );
  }

  return (
    <AdminConsole
      overview={result.data}
      environment={result.environment}
      apiBase={result.apiBase}
      query={q ?? ""}
      viewer={viewer}
    />
  );
}

async function loadAdminViewer(): Promise<AdminViewer | null> {
  const user = await currentUser();
  if (!user) return null;
  const primaryEmail = user.primaryEmailAddress?.emailAddress ?? user.emailAddresses[0]?.emailAddress;
  if (!primaryEmail) return null;
  if (user.primaryEmailAddress?.verification?.status !== "verified") return null;
  return {
    email: primaryEmail,
    name: user.fullName,
  };
}
