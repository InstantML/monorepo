"use client";

// Decorative live training-loss chart. Values are HARDCODED — not pulled
// from any real run. The "live" pill is purely cosmetic. Two converging
// series (train + eval loss) sweep in via CSS stroke-dashoffset.

const TRAIN = [
  3.21, 2.84, 2.47, 2.18, 1.94, 1.71, 1.55, 1.42, 1.30, 1.21,
  1.13, 1.06, 1.00, 0.94, 0.89, 0.85, 0.81, 0.77, 0.74, 0.71,
  0.68, 0.65, 0.63, 0.61, 0.59, 0.57, 0.56, 0.54, 0.53, 0.52,
];
const EVAL = [
  3.18, 2.91, 2.62, 2.36, 2.13, 1.93, 1.78, 1.66, 1.55, 1.46,
  1.39, 1.32, 1.26, 1.21, 1.17, 1.13, 1.09, 1.06, 1.04, 1.02,
  1.00, 0.99, 0.97, 0.96, 0.95, 0.94, 0.93, 0.93, 0.92, 0.92,
];

function polyline(values: number[], w: number, h: number, max: number) {
  const n = values.length - 1;
  return values
    .map((v, i) => {
      const x = (i / n) * w;
      const y = h - (v / max) * h;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

export function MaskingDemo() {
  const w = 520;
  const h = 200;
  const max = 3.4;

  return (
    <div className="landing-masking-demo">
      <div className="landing-masking-demo__header">
        <div className="landing-masking-demo__label">
          run · llm-7b-sft · loss
        </div>
        <div className="landing-masking-demo__live">
          <span className="status-live" />
          streaming
        </div>
      </div>

      <div className="landing-masking-demo__chart">
        <svg viewBox={`0 0 ${w} ${h}`} className="landing-masking-demo__svg" preserveAspectRatio="none">
          <defs>
            <linearGradient id="lmTrainFill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%"  stopColor="rgba(52, 211, 153, 0.35)" />
              <stop offset="100%" stopColor="rgba(52, 211, 153, 0)" />
            </linearGradient>
          </defs>

          {[0.25, 0.5, 0.75].map((t) => (
            <line
              key={t}
              x1="0"
              x2={w}
              y1={h * t}
              y2={h * t}
              stroke="rgba(148,163,184,0.08)"
              strokeWidth="1"
            />
          ))}

          <polygon
            points={`0,${h} ${polyline(TRAIN, w, h, max)} ${w},${h}`}
            fill="url(#lmTrainFill)"
          />

          <polyline
            points={polyline(EVAL, w, h, max)}
            fill="none"
            stroke="#94A3B8"
            strokeOpacity="0.55"
            strokeWidth="1.6"
            strokeLinejoin="round"
            strokeLinecap="round"
            className="chart-line"
            style={{ animationDelay: "120ms" }}
          />

          <polyline
            points={polyline(TRAIN, w, h, max)}
            fill="none"
            stroke="var(--accent)"
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
            className="chart-line"
          />

          <circle
            cx={w}
            cy={h - (TRAIN[TRAIN.length - 1] / max) * h}
            r="3.5"
            fill="var(--accent)"
          />
        </svg>

        <div className="landing-masking-demo__legend">
          <div className="landing-masking-demo__legend-row">
            <span className="landing-masking-demo__legend-line landing-masking-demo__legend-line--train" />
            train
          </div>
          <div className="landing-masking-demo__legend-row">
            <span className="landing-masking-demo__legend-line landing-masking-demo__legend-line--eval" />
            eval
          </div>
        </div>
      </div>

      <div className="landing-masking-demo__footer">
        <span className="landing-masking-demo__stat">step <span className="landing-masking-demo__stat-val">28,400</span></span>
        <span className="landing-masking-demo__stat">loss <span className="tick-flash">0.52</span></span>
        <span className="landing-masking-demo__stat">throughput <span className="landing-masking-demo__stat-val">42k tok/s</span></span>
      </div>
    </div>
  );
}
