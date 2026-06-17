import { clerkMiddleware } from "@clerk/nextjs/server";
import { adminClerkDomain } from "./src/admin-auth.mjs";

export default clerkMiddleware({
  domain: adminClerkDomain(),
});

export const config = {
  matcher: [
    "/((?!_next|__clerk|api|trpc|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|txt|xml|webmanifest)).*)",
  ],
};
