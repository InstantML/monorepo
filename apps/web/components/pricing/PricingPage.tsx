"use client";

/**
 * PricingPage - public /pricing route.
 *
 * Public copy must stay aligned with the implemented Free/Pro/Premium plan
 * constants in apps/rust-server/src/domain.rs and the signup cards in
 * app/auth-flow.tsx. Avoid publishing unverified competitor dollar math here:
 * PRODUCT_STRATEGY.md treats pricing comparisons as launch-sensitive research
 * that must be rechecked before use.
 */

import Link from "next/link";
import type { ReactNode } from "react";
import { NavLogo } from "../landing/NavLogo";
import { LogoMark } from "../landing/LogoMark";
import { ThemeToggle } from "../landing/ThemeToggle";

const COPYRIGHT_YEAR = new Date().getFullYear();

function IconArrow() {
  return (
    <svg
      className="landing-arrow"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M5 12h14M13 5l7 7-7 7"
      />
    </svg>
  );
}

function IconCheck() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

type Tier = {
  id: string;
  name: string;
  price: string;
  cadence: string;
  blurb: string;
  bestFor: string;
  seats: string;
  seatNote: string;
  storage: string;
  projects: string;
  runs: string;
  metricPoints: string;
  apiRequests: string;
  rateLimits: string;
  features: string[];
  ctaLabel: string;
  ctaHref: string;
  highlight?: boolean;
};

const TIERS: Tier[] = [
  {
    id: "free",
    name: "Free",
    price: "$0",
    cadence: "/ org / month",
    blurb: "For individual researchers, students, and small experiments.",
    bestFor: "Solo research and first projects",
    seats: "2 included seats",
    seatNote: "Upgrade when the team grows",
    storage: "2 GiB hosted storage",
    projects: "2 projects",
    runs: "100 runs",
    metricPoints: "1M metric points / month",
    apiRequests: "500k API requests / month",
    rateLimits: "5 req/sec general; 2 req/sec ingest",
    features: [
      "Full SDK for init, log, artifacts, and checkpoints",
      "Run search, charts, Compare, Reports, and safe previews",
      "W&B, MLflow, and Neptune import paths within plan limits",
      "Monthly API request overage is blocked at the included pool",
    ],
    ctaLabel: "Start free",
    ctaHref: "/signup",
  },
  {
    id: "pro",
    name: "Pro",
    price: "$199",
    cadence: "/ org / month",
    blurb: "For small teams that need shared run review without tracked-hour billing.",
    bestFor: "Lean ML teams",
    seats: "3 included seats",
    seatNote: "Extra seats available through billing",
    storage: "1 TiB hosted storage; $0.03 / GiB-month overage",
    projects: "100 projects",
    runs: "100k runs",
    metricPoints: "250M metric points / month",
    apiRequests: "25M API requests / month; $2 / 1M overage",
    rateLimits: "50 req/sec general; 25 req/sec ingest",
    features: [
      "Everything in Free",
      "Paid storage and API request overage are explicit",
      "Org roles, invitations, usage, billing, and API-key controls",
      "Email support for setup and billing questions",
    ],
    ctaLabel: "Start Pro",
    ctaHref: "/signup?plan=pro",
    highlight: true,
  },
  {
    id: "premium",
    name: "Premium",
    price: "$699",
    cadence: "/ org / month",
    blurb: "For teams with larger run volumes, storage needs, or BYOC requirements.",
    bestFor: "Growth teams and heavy projects",
    seats: "10 included seats",
    seatNote: "Extra seats available through billing",
    storage: "5 TiB hosted storage; $0.03 / GiB-month overage",
    projects: "500 projects",
    runs: "1M runs",
    metricPoints: "2B metric points / month",
    apiRequests: "150M API requests / month; $1 / 1M overage",
    rateLimits: "200 req/sec general; 100 req/sec ingest",
    features: [
      "Everything in Pro",
      "Premium BYOC GCP ClickHouse option",
      "Larger hosted warehouse capacity",
      "Guided storage and ingest setup during beta",
    ],
    ctaLabel: "Start Premium",
    ctaHref: "/signup?plan=premium",
  },
];

function TierCard({ tier }: { tier: Tier }) {
  const rows = [
    ["Seats", tier.seats, tier.seatNote],
    ["Storage", tier.storage, ""],
    ["Projects", tier.projects, ""],
    ["Runs", tier.runs, ""],
    ["Metric points", tier.metricPoints, ""],
    ["API requests", tier.apiRequests, ""],
    ["Rate limits", tier.rateLimits, ""],
  ];

  return (
    <div
      className={`bento-cell pricing-tier-card${tier.highlight ? " pricing-tier-card--highlight" : ""}`}
    >
      {tier.highlight ? (
        <span className="pricing-tier-card__ribbon">Most teams start here</span>
      ) : null}
      <div className="pricing-tier-card__head">
        <div className="pricing-tier-card__name">{tier.name}</div>
        <div className="pricing-tier-card__price-row">
          <span className="pricing-tier-card__price">{tier.price}</span>
          <span className="pricing-tier-card__cadence">{tier.cadence}</span>
        </div>
        <p className="pricing-tier-card__blurb">{tier.blurb}</p>
        <div className="pricing-tier-card__fit">
          <span className="mono-label">Best fit</span>
          <span className="pricing-tier-card__fit-value">{tier.bestFor}</span>
        </div>
      </div>

      <ul className="pricing-tier-card__lines">
        {rows.map(([key, value, note]) => (
          <li key={key}>
            <span className="pricing-tier-card__line-key">{key}</span>
            <span className="pricing-tier-card__line-val">
              {value}
              {note ? <span className="pricing-tier-card__line-sub">{note}</span> : null}
            </span>
          </li>
        ))}
      </ul>

      <ul className="pricing-tier-card__features">
        {tier.features.map((feature) => (
          <li key={feature}>
            <span className="pricing-tier-card__feature-check">
              <IconCheck />
            </span>
            <span>{feature}</span>
          </li>
        ))}
      </ul>

      <Link
        href={tier.ctaHref}
        className={
          tier.highlight
            ? "landing-cta-primary pricing-tier-card__cta"
            : "landing-cta-ghost pricing-tier-card__cta"
        }
      >
        {tier.ctaLabel}
        <IconArrow />
      </Link>
    </div>
  );
}

type BillingSignal = {
  label: string;
  lines: { k: string; v: string }[];
  total: string;
  note: string;
  tone: "old" | "alt" | "new";
};

const BILLING_SIGNALS: BillingSignal[] = [
  {
    label: "Training time",
    lines: [
      { k: "Tracked-hour meter", v: "No" },
      { k: "Step count", v: "Not billed" },
      { k: "Runtime length", v: "Not billed" },
    ],
    total: "No tracked-hour billing",
    note: "InstantML v1 does not charge based on how long your training loop runs.",
    tone: "new",
  },
  {
    label: "Included usage",
    lines: [
      { k: "Seats", v: "2 / 3 / 10" },
      { k: "Hosted storage", v: "2 GiB / 1 TiB / 5 TiB" },
      { k: "API requests", v: "500k / 25M / 150M" },
    ],
    total: "Plan limits are visible",
    note: "Settings shows current usage, reset dates, and retained-resource posture.",
    tone: "alt",
  },
  {
    label: "Overage policy",
    lines: [
      { k: "Free overage", v: "Blocked" },
      { k: "Paid API requests", v: "$2 or $1 / 1M" },
      { k: "Paid storage", v: "$0.03 / GiB-month" },
    ],
    total: "Explicit overage",
    note: "Paid plans meter API request and storage overage, while write routes still honor plan guardrails.",
    tone: "new",
  },
];

function SignalCard({ signal }: { signal: BillingSignal }) {
  return (
    <div
      className={`bento-cell pricing-compare-col pricing-compare-col--${signal.tone}`}
    >
      <div className="pricing-compare-col__label">{signal.label}</div>
      <ul className="pricing-compare-col__lines">
        {signal.lines.map((line) => (
          <li key={line.k}>
            <span>{line.k}</span>
            <span className="pricing-compare-col__line-val">{line.v}</span>
          </li>
        ))}
      </ul>
      <div className="pricing-compare-col__total-row">
        <span className="pricing-compare-col__total-label">Policy</span>
        <span className="pricing-compare-col__total">{signal.total}</span>
      </div>
      <p className="pricing-compare-col__note">{signal.note}</p>
    </div>
  );
}

type ChecklistItem = {
  title: string;
  compare: string;
  instantml: string;
};

const CHECKLIST: ChecklistItem[] = [
  {
    title: "Training-time billing",
    compare:
      "When comparing trackers, check whether training hours, tracked compute time, or background logging time create a second bill axis.",
    instantml:
      "InstantML does not bill tracked training hours in v1. The important meters are seats, included usage, storage, and API requests.",
  },
  {
    title: "Storage accounting",
    compare:
      "Confirm which artifact bytes are billable, when storage resets, and whether deleting metadata actually reduces retained storage.",
    instantml:
      "Hosted storage is shown in Settings. Paid storage overage is reportable at $0.03 / GiB-month, but storage writes can still be blocked at plan guardrails until usage, plan, or terms change.",
  },
  {
    title: "API request quota",
    compare:
      "Look for monthly request allowances, short-window rate limits, and whether ingestion can silently exceed a plan.",
    instantml:
      "Free and non-billable orgs are blocked at the monthly request allowance. Pro and Premium use explicit request overage.",
  },
  {
    title: "Roles and seats",
    compare:
      "Check whether viewers, pending invites, service users, or shared logins change the effective seat count.",
    instantml:
      "Settings counts active members plus unexpired invitations. Owner, Admin, Write/read, and Read only roles are visible in the UI.",
  },
];

function ChecklistRow({ item }: { item: ChecklistItem }) {
  return (
    <div className="bento-cell pricing-surprise">
      <h3 className="pricing-surprise__title">{item.title}</h3>
      <div className="pricing-surprise__grid">
        <div className="pricing-surprise__col pricing-surprise__col--old">
          <div className="pricing-surprise__col-label">
            <span className="pricing-surprise__icon pricing-surprise__icon--bad">
              <IconCheck />
            </span>
            Compare elsewhere
          </div>
          <p>{item.compare}</p>
        </div>
        <div className="pricing-surprise__col pricing-surprise__col--new">
          <div className="pricing-surprise__col-label">
            <span className="pricing-surprise__icon pricing-surprise__icon--good">
              <IconCheck />
            </span>
            InstantML
          </div>
          <p>{item.instantml}</p>
        </div>
      </div>
    </div>
  );
}

function FooterCol({
  title,
  links,
}: {
  title: string;
  links: [string, string][];
}) {
  return (
    <div>
      <div className="landing-footer-col-title">{title}</div>
      <ul className="landing-footer-links">
        {links.map(([label, href]) => (
          <li key={label}>
            {href.startsWith("/") ? (
              <Link href={href} className="landing-footer-link">
                {label}
              </Link>
            ) : (
              <a href={href} className="landing-footer-link">
                {label}
              </a>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Nav() {
  return (
    <nav className="landing-nav">
      <div className="landing-nav__inner">
        <NavLogo size={22} />
        <div className="landing-nav__links">
          <Link href="/#how" className="landing-nav__link">
            How it works
          </Link>
          <Link href="/#capabilities" className="landing-nav__link">
            Capabilities
          </Link>
          <Link href="/#developers" className="landing-nav__link landing-nav__link--md">
            Developers
          </Link>
          <Link href="/docs" className="landing-nav__link landing-nav__link--mobile">
            Docs
          </Link>
          <Link href="/pricing" className="landing-nav__link landing-nav__link--mobile pricing-nav__link--active">
            Pricing
          </Link>
          <ThemeToggle />
          <Link href="/signup" className="landing-cta-primary landing-cta-primary--sm">
            Get early access
          </Link>
        </div>
      </div>
    </nav>
  );
}

function PageSection({
  id,
  children,
  className = "",
}: {
  id?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      id={id}
      className={`landing-section section-fade visible ${className}`}
    >
      {children}
    </section>
  );
}

export function PricingPage() {
  return (
    <div className="landing-root pricing-root">
      <Nav />

      <PageSection className="landing-section-py pricing-header-section">
        <div className="landing-section-intro pricing-header-intro">
          <h1 className="landing-h2 pricing-h1">
            Predictable training observability pricing.{" "}
            <span className="font-serif-italic landing-h2-muted">
              No tracked-hour billing.
            </span>
          </h1>
          <p className="landing-section-body">
            InstantML uses seat-plus-included-usage plans for hosted teams.
            Storage and API request overage are explicit on paid plans, and
            project, run, and metric limits are visible before they block new
            writes.
          </p>
          <div className="pricing-header-chips">
            <span className="landing-proof-chip">
              <span className="landing-proof-chip__check">
                <IconCheck />
              </span>
              No tracked-hour billing
            </span>
            <span className="landing-proof-chip">
              <span className="landing-proof-chip__check">
                <IconCheck />
              </span>
              Usage visible in Settings
            </span>
            <span className="landing-proof-chip">
              <span className="landing-proof-chip__check">
                <IconCheck />
              </span>
              Explicit storage and API request overage
            </span>
          </div>
        </div>

        <div className="pricing-tier-grid">
          {TIERS.map((tier) => (
            <TierCard key={tier.id} tier={tier} />
          ))}
        </div>

        <p className="pricing-fine-print">
          Prices are current hosted beta list prices. Extra seats are available
          through billing; contact us for current extra-seat pricing. Included
          seats apply to organization workspaces; personal workspaces stay one owner seat.
          Enterprise/custom is reserved for SSO/SAML, VPC or self-hosted
          deployment, compliance, custom retention, dedicated support, or
          unusually heavy data footprints.
        </p>
      </PageSection>

      <PageSection id="billing-model" className="landing-section-py pricing-compare-section">
        <div className="landing-section-intro">
          <p className="mono-label landing-mono-label">Billing model</p>
          <h2 className="landing-h2">
            The meters are explicit.{" "}
            <span className="font-serif-italic landing-h2-muted">
              Training time is not one of them.
            </span>
          </h2>
          <p className="landing-section-body">
            Compare InstantML by its implemented usage model: seats, retained
            storage, monthly metric points, monthly API requests, and clear
            write gates when limits are reached.
          </p>
        </div>

        <div className="pricing-compare-grid">
          {BILLING_SIGNALS.map((signal) => (
            <SignalCard key={signal.label} signal={signal} />
          ))}
        </div>

        <p className="pricing-fine-print pricing-fine-print--note">
          Paid storage overage is reportable at $0.03 / GiB-month after
          included storage, and storage writes can still be blocked at plan
          guardrails until usage, plan, or terms change. Paid API request
          overage is $2 / 1M requests on Pro and $1 / 1M requests on Premium.
          Free and non-billable orgs are blocked at the monthly API request
          allowance.
        </p>
      </PageSection>

      <PageSection
        id="compare"
        className="landing-section-py pricing-surprises-section"
      >
        <div className="landing-section-intro">
          <p className="mono-label landing-mono-label">Comparison checklist</p>
          <h2 className="landing-h2">
            Compare the billing rules, not stale screenshots.{" "}
            <span className="font-serif-italic landing-h2-muted">
              These are the questions that matter.
            </span>
          </h2>
        </div>

        <div className="pricing-surprise-stack">
          {CHECKLIST.map((item) => (
            <ChecklistRow key={item.title} item={item} />
          ))}
        </div>
      </PageSection>

      <PageSection className="landing-section-py">
        <div className="landing-cta-card">
          <div className="bg-grid landing-bg-overlay landing-cta-card__grid" />
          <div className="landing-cta-card__glow" />
          <div className="landing-cta-card__body">
            <h2 className="landing-cta-h2">
              Start with a real plan limit.{" "}
              <span className="font-serif-italic landing-h2-muted">
                Scale when usage proves it.
              </span>
            </h2>
            <p className="landing-cta-desc">
              Start on Free, upgrade to Pro or Premium when the workspace needs
              more seats, storage, projects, runs, metric points, or API
              request capacity.
            </p>
            <div className="landing-cta-row">
              <Link href="/signup" className="landing-cta-primary">
                Get started
                <IconArrow />
              </Link>
              <Link href="/docs/pricing" className="landing-cta-ghost">
                Read billing docs
              </Link>
            </div>
            <p className="landing-cta-note">
              hello@instantml.ai
            </p>
          </div>
        </div>
      </PageSection>

      <footer className="landing-footer">
        <div className="landing-footer__inner">
          <div className="landing-footer__grid">
            <div className="landing-footer__brand">
              <div className="landing-footer__brand-row">
                <LogoMark size={20} color="var(--accent)" />
                <span className="landing-footer__brand-name">InstantML</span>
              </div>
              <p className="landing-footer__brand-desc">
                Training observability that's actually fast. Sub-second hosted
                reads on the current 50k-run benchmark, predictable pricing,
                and a data model your team can own.
              </p>
            </div>
            <FooterCol
              title="Product"
              links={[
                ["How it works", "/#how"],
                ["Capabilities", "/#capabilities"],
                ["Developers", "/#developers"],
                ["Pricing", "/pricing"],
              ]}
            />
            <FooterCol
              title="Migrate"
              links={[
                ["From W&B", "/#developers"],
                ["From MLflow", "/#developers"],
                ["From Neptune", "/#developers"],
              ]}
            />
            <FooterCol
              title="Company"
              links={[
                ["Contact", "mailto:hello@instantml.ai"],
                ["Careers", "mailto:careers@instantml.ai"],
              ]}
            />
          </div>
          <div className="landing-footer__bottom">
            <span className="landing-footer__copy">
              &copy; {COPYRIGHT_YEAR} InstantML
            </span>
            <span className="landing-footer__status">
              v0.1 - hello@instantml.ai
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
}
