import { NextResponse } from "next/server";
import { currentUser } from "@clerk/nextjs/server";
import { isAdminEmailAllowed, parseAdminAllowedEmails } from "../../../../../src/admin-auth.mjs";
import { changeOrgPlan } from "../../../../../src/admin-data";

export const dynamic = "force-dynamic";

const ALLOWED_PLANS = new Set(["free", "pro", "premium"]);

type RouteContext = {
  params: Promise<{ orgId: string }>;
};

export async function POST(request: Request, context: RouteContext) {
  const authorized = await isAuthorizedOperator();
  if (!authorized) {
    return NextResponse.json({ message: "Not authorized." }, { status: 401 });
  }

  const { orgId } = await context.params;
  if (!orgId) {
    return NextResponse.json({ message: "Missing organization id." }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ message: "Request body must be JSON." }, { status: 400 });
  }

  const rawPlan = (body as { plan_tier?: unknown } | null)?.plan_tier;
  const planTier = typeof rawPlan === "string" ? rawPlan.trim().toLowerCase() : "";
  if (!ALLOWED_PLANS.has(planTier)) {
    return NextResponse.json(
      { message: "plan_tier must be one of: free, pro, premium." },
      { status: 400 },
    );
  }

  const result = await changeOrgPlan({ orgId, planTier });
  if (!result.ok) {
    return NextResponse.json({ message: result.message }, { status: result.status });
  }
  return NextResponse.json({ org: result.org });
}

async function isAuthorizedOperator(): Promise<boolean> {
  const allowedEmails = parseAdminAllowedEmails(process.env.INSTANTML_ADMIN_ALLOWED_EMAILS);
  let user;
  try {
    user = await currentUser();
  } catch {
    return false;
  }
  if (!user) return false;
  const email =
    user.primaryEmailAddress?.emailAddress ?? user.emailAddresses[0]?.emailAddress ?? "";
  if (!email) return false;
  if (user.primaryEmailAddress?.verification?.status !== "verified") return false;
  return isAdminEmailAllowed(email, allowedEmails);
}
