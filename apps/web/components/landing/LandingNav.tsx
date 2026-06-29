"use client";

import Link from "next/link";
import { NavLogo } from "./NavLogo";
import { ThemeToggle } from "./ThemeToggle";

export function LandingNav() {
  return (
    <nav className="landing-nav">
      <div className="landing-nav__inner">
        <NavLogo size={22} />
        <div className="landing-nav__links">
          <a href="/#developers" className="landing-nav__link">
            SDK
          </a>
          <Link href="/docs" className="landing-nav__link">
            Docs
          </Link>
          <Link href="/pricing" className="landing-nav__link landing-nav__link--mobile">
            Pricing
          </Link>
          <Link href="/signin" className="landing-nav__link landing-nav__link--md">
            Sign in
          </Link>
          <ThemeToggle />
          <Link href="/signup" className="landing-cta-primary landing-cta-primary--sm">
            Start free
          </Link>
        </div>
      </div>
    </nav>
  );
}
