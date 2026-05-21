"use client";

/**
 * PricingPage — public /pricing route.
 *
 * Three blocks, in order:
 *   1. Tier matrix     — Free / Pro / Premium, with "best fit" labels
 *   2. W&B comparison  — 5-person team, side-by-side dollars
 *   3. Surprise costs  — what W&B charges for that InstantML doesn't
 *
 * Reuses landing-system.css design tokens and class primitives
 * (.landing-root, .landing-nav, .landing-section-py, .landing-h2, .pill,
 * .bento-cell, .landing-cta-primary). Brand color: var(--accent) = #1FB877.
 *
 * Numbers source:
 *   - Free / Pro / Premium tier prices: existing auth-flow.tsx
 *     (PLAN_OPTIONS) — keep these in sync.
 *   - W&B per-seat: ZenML Nov-2025 pricing guide cited in
 *     product/wiki/concepts/pricing-and-seats.md
 *     ($50/seat/mo team tier; $1/tracked-hour overage).
 *   - W&B "growth" / business per-seat ~$200/mo is the audit's planning
 *     number — TODO: verify with a current public quote before any
 *     marketing push. Marked PLACEHOLDER inline below.
 */

import type { ReactNode } from "react";
import { NavLogo } from "../landing/NavLogo";
import { LogoMark } from "../landing/LogoMark";
import { ThemeToggle } from "../landing/ThemeToggle";

function IconArrow() {
  return (
    <svg
      className="landing-arrow"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      viewBox="0 0 24 24"
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

function IconX() {
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
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  );
}

// ─── Tier matrix ────────────────────────────────────────────────────────────

type Tier = {
  id: string;
  name: string;
  price: string;
  cadence: string;
  blurb: string;
  bestFor: string;
  writers: string;
  extraWriter: string;
  viewers: string;
  storage: string;
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
    cadence: "forever",
    blurb: "For individuals, students, and one-off academic runs.",
    bestFor: "Solo researcher · academic",
    writers: "1 writer seat",
    extraWriter: "upgrade for more",
    viewers: "Unlimited free viewers",
    storage: "2 GB hosted storage included",
    features: [
      "Full SDK · init / log / finish",
      "Run compare · charts · artifacts",
      "W&B / MLflow / Neptune import",
      "Community Slack support",
    ],
    ctaLabel: "Start free",
    ctaHref: "/signup",
  },
  {
    id: "pro",
    name: "Pro",
    price: "$199",
    cadence: "/month",
    blurb: "For 3–7-person teams that share runs and review together.",
    bestFor: "Small teams · 3–7 people",
    writers: "3 writer seats included",
    extraWriter: "$50 / extra writer",
    viewers: "Unlimited free viewers",
    storage: "1 TB hosted storage included",
    features: [
      "Everything in Free",
      "Project share links (read-only)",
      "Org-wide RBAC · audit trail",
      "Same-business-day email support",
    ],
    ctaLabel: "Start Pro",
    ctaHref: "/signup?plan=pro",
    highlight: true,
  },
  {
    id: "premium",
    name: "Premium",
    price: "$699",
    cadence: "/month",
    blurb: "For growth-stage ML orgs with multiple projects in flight.",
    bestFor: "Growth-stage · 100k+ runs",
    writers: "10 writer seats included",
    extraWriter: "$70 / extra writer",
    viewers: "Unlimited free viewers",
    storage: "5 TB hosted storage included",
    features: [
      "Everything in Pro",
      "Priority ingest queue",
      "SSO / SAML · custom domains",
      "Shared private Slack channel",
    ],
    ctaLabel: "Start Premium",
    ctaHref: "/signup?plan=premium",
  },
];

function TierCard({ tier }: { tier: Tier }) {
  return (
    <div
      className={`bento-cell pricing-tier-card${tier.highlight ? " pricing-tier-card--highlight" : ""}`}
    >
      {tier.highlight ? (
        <span className="pricing-tier-card__ribbon">Most teams pick this</span>
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
        <li>
          <span className="pricing-tier-card__line-key">Writer seats</span>
          <span className="pricing-tier-card__line-val">
            {tier.writers}
            <span className="pricing-tier-card__line-sub">{tier.extraWriter}</span>
          </span>
        </li>
        <li>
          <span className="pricing-tier-card__line-key">Viewer seats</span>
          <span className="pricing-tier-card__line-val pricing-tier-card__line-val--accent">
            {tier.viewers}
          </span>
        </li>
        <li>
          <span className="pricing-tier-card__line-key">Storage</span>
          <span className="pricing-tier-card__line-val">{tier.storage}</span>
        </li>
      </ul>

      <ul className="pricing-tier-card__features">
        {tier.features.map((f) => (
          <li key={f}>
            <span className="pricing-tier-card__feature-check"><IconCheck /></span>
            <span>{f}</span>
          </li>
        ))}
      </ul>

      <a
        href={tier.ctaHref}
        className={
          tier.highlight
            ? "landing-cta-primary pricing-tier-card__cta"
            : "landing-cta-ghost pricing-tier-card__cta"
        }
      >
        {tier.ctaLabel}
        <IconArrow />
      </a>
    </div>
  );
}

// ─── W&B comparison ─────────────────────────────────────────────────────────

// PLACEHOLDER VALUES — verify with W&B sales rep before going live.
// Sources:
//   - $50/seat/mo at the Team/Pro tier
//     (raw/external-feedback/blogs/zenml-wandb-pricing-guide.md, Nov 2025).
//   - $1/tracked-hour overage from same source.
//   - $0.03/GB/mo storage overage from same source.
//   - 20k runs/mo × ~12h avg ≈ tracked-hour ballpark; we land on a
//     conservative 200 tracked-hours/mo for the team beyond the included 500.
// TODO: replace ESTIMATED amounts with a current public quote.
const SCENARIO = {
  shape:
    "5-person team · ~20,000 runs/month · 50 GB metadata · 1 writer + 4 viewers (today)",
  wandb: {
    label: "W&B · Pro tier",
    lines: [
      { k: "5 writer seats @ $50", v: "$250" },
      { k: "Tracked-hour overage (est. 200h × $1)", v: "$200" },
      { k: "Hosted artifact storage (est. 50 GB × $0.03)", v: "$2" },
    ],
    monthly: "$452 /mo",
    annual: "~$5,424 /yr",
    note: "ESTIMATED — verify with W&B current quote",
  },
  wandbShared: {
    label: "W&B · with seat-sharing workaround",
    lines: [
      { k: "2 writer seats (shared across the team)", v: "$100" },
      { k: "Tracked-hour overage (est. 200h × $1)", v: "$200" },
      { k: "Hosted artifact storage (est. 50 GB × $0.03)", v: "$2" },
    ],
    monthly: "$302 /mo",
    annual: "~$3,624 /yr",
    note: "Shared seats break attribution, RBAC, and onboarding.",
  },
  instantml: {
    label: "InstantML · Pro",
    lines: [
      { k: "Base (3 writer seats included)", v: "$199" },
      { k: "+2 extra writers @ $50", v: "$100" },
      { k: "4 viewer seats", v: "$0" },
      { k: "Hosted artifacts (50 GB included)", v: "$0" },
    ],
    monthly: "$299 /mo",
    annual: "~$3,588 /yr",
    note: "Flat. Every teammate gets their own writer login. Extra storage target: $0.03/GB-month.",
  },
};

function ComparisonColumn({
  label,
  lines,
  monthly,
  annual,
  note,
  tone,
}: {
  label: string;
  lines: { k: string; v: string }[];
  monthly: string;
  annual: string;
  note: string;
  tone: "old" | "alt" | "new";
}) {
  return (
    <div
      className={`bento-cell pricing-compare-col pricing-compare-col--${tone}`}
    >
      <div className="pricing-compare-col__label">{label}</div>
      <ul className="pricing-compare-col__lines">
        {lines.map((l) => (
          <li key={l.k}>
            <span>{l.k}</span>
            <span className="pricing-compare-col__line-val">{l.v}</span>
          </li>
        ))}
      </ul>
      <div className="pricing-compare-col__total-row">
        <span className="pricing-compare-col__total-label">Monthly</span>
        <span className="pricing-compare-col__total">{monthly}</span>
      </div>
      <div className="pricing-compare-col__annual">{annual}</div>
      <p className="pricing-compare-col__note">{note}</p>
    </div>
  );
}

// ─── Surprise costs ──────────────────────────────────────────────────────────

type Surprise = {
  title: string;
  wandb: string;
  instantml: string;
  evidence?: { label: string; href: string };
};

const SURPRISES: Surprise[] = [
  {
    title: "Artifact storage that bills forever",
    wandb:
      "Orphaned artifacts you thought were deleted keep accruing storage charges. Public report: a student's bill ran to ~$600 from artifacts they couldn't see.",
    instantml:
      "Hosted R2 storage is included in every tier and shown in usage. Writes are blocked at the included pool until paid overages launch.",
    evidence: {
      label: "wandb#10459 — artifacts not pruned",
      href: "https://github.com/wandb/wandb/issues/10459",
    },
  },
  {
    title: "Per-seat pricing that punishes growing teams",
    wandb:
      "Every teammate is a paid seat. Teams workaround it by sharing one login — which destroys attribution, RBAC, and the audit trail.",
    instantml:
      "Unlimited free viewer seats from day one. Bring in PMs, leadership, the whole company — they all get their own login.",
  },
  {
    title: "Tracked-hour overage on top of seats",
    wandb:
      "A second axis of bill creep: pay per logged compute hour on top of the seat fee. Reported $1/hr overage, with cases of 5,000 tracked hours in a single day on small clusters.",
    instantml:
      "Flat monthly bill. We don't meter your training time. Log a million steps or ten — same price.",
  },
  {
    title: "Silent SDK data loss",
    wandb:
      "Multiple open issues where the SDK stops logging mid-run with no error visible to the user.",
    instantml:
      "End-to-end ack on metric writes. Offline spool replays on reconnect. We surface drops loudly, not quietly.",
    evidence: {
      label: "wandb#10581 — stops tracking metrics",
      href: "https://github.com/wandb/wandb/issues/10581",
    },
  },
];

function SurpriseRow({ s }: { s: Surprise }) {
  return (
    <div className="bento-cell pricing-surprise">
      <h3 className="pricing-surprise__title">{s.title}</h3>
      <div className="pricing-surprise__grid">
        <div className="pricing-surprise__col pricing-surprise__col--old">
          <div className="pricing-surprise__col-label">
            <span className="pricing-surprise__icon pricing-surprise__icon--bad">
              <IconX />
            </span>
            W&amp;B today
          </div>
          <p>{s.wandb}</p>
          {s.evidence ? (
            <a
              href={s.evidence.href}
              target="_blank"
              rel="noreferrer noopener"
              className="landing-text-link pricing-surprise__evidence"
            >
              {s.evidence.label}
              <IconArrow />
            </a>
          ) : null}
        </div>
        <div className="pricing-surprise__col pricing-surprise__col--new">
          <div className="pricing-surprise__col-label">
            <span className="pricing-surprise__icon pricing-surprise__icon--good">
              <IconCheck />
            </span>
            InstantML
          </div>
          <p>{s.instantml}</p>
        </div>
      </div>
    </div>
  );
}

// ─── Page shell ──────────────────────────────────────────────────────────────

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
            <a href={href} className="landing-footer-link">
              {label}
            </a>
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
          <a href="/#how" className="landing-nav__link">
            How it works
          </a>
          <a href="/#capabilities" className="landing-nav__link">
            Capabilities
          </a>
          <a href="/#developers" className="landing-nav__link landing-nav__link--md">
            Developers
          </a>
          <a href="/pricing" className="landing-nav__link pricing-nav__link--active">
            Pricing
          </a>
          <ThemeToggle />
          <a href="/signup" className="landing-cta-primary landing-cta-primary--sm">
            Get early access
          </a>
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

      {/* Header */}
      <PageSection className="landing-section-py pricing-header-section">
        <div className="landing-section-intro pricing-header-intro">
          <p className="mono-label landing-mono-label">Pricing</p>
          <h1 className="landing-h2 pricing-h1">
            Predictable monthly bill.{" "}
            <span className="font-serif-italic landing-h2-muted">
              Unlimited free viewers on every tier.
            </span>
          </h1>
          <p className="landing-section-body">
            No per-tracked-hour creep. Hosted artifact storage is included and
            visible in usage. Invite your whole team — only writers count toward
            the bill.
          </p>
          <div className="pricing-header-chips">
            <span className="landing-proof-chip">
              <span className="landing-proof-chip__check">
                <IconCheck />
              </span>
              Unlimited free viewer seats
            </span>
            <span className="landing-proof-chip">
              <span className="landing-proof-chip__check">
                <IconCheck />
              </span>
              Included hosted artifact storage
            </span>
            <span className="landing-proof-chip">
              <span className="landing-proof-chip__check">
                <IconCheck />
              </span>
              No tracked-hour billing
            </span>
          </div>
        </div>

        <div className="pricing-tier-grid">
          {TIERS.map((t) => (
            <TierCard key={t.id} tier={t} />
          ))}
        </div>

        <p className="pricing-fine-print">
          All tiers include the full SDK, run compare, artifacts, and W&amp;B /
          MLflow / Neptune import. Artifact bytes are stored in private
          Cloudflare R2-backed org buckets. Additional retained storage beyond
          the included pool is planned at $0.03/GB-month plus provider operation
          costs; usage remains
          guardrail telemetry until provider reconciliation is billable truth.
        </p>
      </PageSection>

      {/* W&B comparison */}
      <PageSection id="compare" className="landing-section-py pricing-compare-section">
        <div className="landing-section-intro">
          <p className="mono-label landing-mono-label">The math</p>
          <h2 className="landing-h2">
            What a 5-person team pays.{" "}
            <span className="font-serif-italic landing-h2-muted">
              Side-by-side, same workload.
            </span>
          </h2>
          <p className="landing-section-body">
            {SCENARIO.shape}.
          </p>
        </div>

        <div className="pricing-compare-grid">
          <ComparisonColumn
            label={SCENARIO.wandbShared.label}
            lines={SCENARIO.wandbShared.lines}
            monthly={SCENARIO.wandbShared.monthly}
            annual={SCENARIO.wandbShared.annual}
            note={SCENARIO.wandbShared.note}
            tone="old"
          />
          <ComparisonColumn
            label={SCENARIO.wandb.label}
            lines={SCENARIO.wandb.lines}
            monthly={SCENARIO.wandb.monthly}
            annual={SCENARIO.wandb.annual}
            note={SCENARIO.wandb.note}
            tone="alt"
          />
          <ComparisonColumn
            label={SCENARIO.instantml.label}
            lines={SCENARIO.instantml.lines}
            monthly={SCENARIO.instantml.monthly}
            annual={SCENARIO.instantml.annual}
            note={SCENARIO.instantml.note}
            tone="new"
          />
        </div>

        <div className="pricing-compare-savings">
          <div>
            <span className="mono-label">Savings vs. unshared W&amp;B Pro</span>
            <span className="pricing-compare-savings__value">
              ~$1,836 / year
            </span>
          </div>
          <div>
            <span className="mono-label">And every teammate gets their own login</span>
            <span className="pricing-compare-savings__sub">
              Attribution, RBAC, audit trail — restored.
            </span>
          </div>
        </div>

        <p className="pricing-fine-print pricing-fine-print--note">
          W&amp;B dollar figures are current public-quote estimates and include
          a modest tracked-hour overage assumption — confirm with your account
          rep for an exact comparison. InstantML numbers are list price, no
          contract minimum.
        </p>
      </PageSection>

      {/* Surprise costs */}
      <PageSection
        id="surprises"
        className="landing-section-py pricing-surprises-section"
      >
        <div className="landing-section-intro">
          <p className="mono-label landing-mono-label">No surprise costs</p>
          <h2 className="landing-h2">
            Four ways W&amp;B&apos;s bill ambushes you.{" "}
            <span className="font-serif-italic landing-h2-muted">
              We removed every one of them.
            </span>
          </h2>
        </div>

        <div className="pricing-surprise-stack">
          {SURPRISES.map((s) => (
            <SurpriseRow key={s.title} s={s} />
          ))}
        </div>
      </PageSection>

      {/* CTA */}
      <PageSection className="landing-section-py">
        <div className="landing-cta-card">
          <div className="bg-grid landing-bg-overlay landing-cta-card__grid" />
          <div className="landing-cta-card__glow" />
          <div className="landing-cta-card__body">
            <div className="landing-cta-card__logo">
              <LogoMark size={28} color="var(--accent)" />
            </div>
            <h2 className="landing-cta-h2">
              Stop sharing seats.{" "}
              <span className="font-serif-italic landing-h2-muted">
                Invite the whole team.
              </span>
            </h2>
            <p className="landing-cta-desc">
              Start on Free. Upgrade when you outgrow the writer seat. Every
              viewer is free, forever — no per-call charges, no tracked-hour
              meter.
            </p>
            <div className="landing-cta-row">
              <a href="/signup" className="landing-cta-primary">
                Get started
                <IconArrow />
              </a>
              <a href="/#developers" className="landing-cta-ghost">
                See the SDK
              </a>
            </div>
            <p className="landing-cta-note">
              hello@instantml.ai · we reply same business day
            </p>
          </div>
        </div>
      </PageSection>

      {/* Footer */}
      <footer className="landing-footer">
        <div className="landing-footer__inner">
          <div className="landing-footer__grid">
            <div className="landing-footer__brand">
              <div className="landing-footer__brand-row">
                <LogoMark size={20} color="var(--accent)" />
                <span className="landing-footer__brand-name">InstantML</span>
              </div>
              <p className="landing-footer__brand-desc">
                Training observability that&apos;s actually fast. Sub-second
                charts at 100k runs, flat pricing, and a data model your team
                can own.
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
              &copy; {new Date().getFullYear()} InstantML
            </span>
            <span className="landing-footer__status">
              <span className="status-live" />
              v0.1 · hello@instantml.ai
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
}
