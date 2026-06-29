import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { postAuthRedirectPath, sanitizeNextPath } from "../../src/routes.js";
import { AuthFlow } from "../auth-flow";
import { serverAuthSession } from "../server-auth";

export const metadata: Metadata = {
  title: "Sign in",
  description: "Sign in to your InstantML account.",
  robots: { index: false, follow: false },
};

type SignInPageProps = {
  searchParams?: Promise<{ next?: string | string[] }>;
};

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function SignInPage({ searchParams }: SignInPageProps) {
  const params = await searchParams;
  const nextPath = sanitizeNextPath(firstParam(params?.next));
  const session = await serverAuthSession((await headers()).get("cookie") ?? "");
  if (session?.authenticated) {
    redirect(postAuthRedirectPath(session, nextPath));
  }
  return <AuthFlow mode="signin" />;
}
