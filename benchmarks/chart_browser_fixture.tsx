import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

import { MetricChart, type ChartZoomRange } from "../apps/web/app/dashboard/metrics/metric-chart";

type FixtureState = {
  firstPaintMs: number | null;
  longTasks: Array<{ duration: number; startTime: number }>;
  ready: boolean;
};

declare global {
  interface Window {
    __INSTANTML_CHART_FIXTURE__: FixtureState;
  }
}

window.__INSTANTML_CHART_FIXTURE__ = { firstPaintMs: null, longTasks: [], ready: false };

if (typeof PerformanceObserver !== "undefined") {
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        window.__INSTANTML_CHART_FIXTURE__.longTasks.push({ duration: entry.duration, startTime: entry.startTime });
      }
    });
    observer.observe({ type: "longtask", buffered: true });
  } catch {
    // Long-task observation is optional in browsers that do not expose it.
  }
}

function makeSeries() {
  return Array.from({ length: 2_000 }, (_, runIndex) => ({
    id: `run-${runIndex}`,
    name: `Run ${runIndex}`,
    points: Array.from({ length: 60 }, (_, pointIndex) => ({
      step: pointIndex,
      value: 1.5 + Math.sin(pointIndex / 11 + runIndex / 17) + runIndex / 10_000,
    })),
  }));
}

function Fixture() {
  const series = useMemo(makeSeries, []);
  const [zoomRange, setZoomRange] = useState<ChartZoomRange>(null);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      window.__INSTANTML_CHART_FIXTURE__.firstPaintMs = performance.now() - renderStartedAt;
      window.__INSTANTML_CHART_FIXTURE__.ready = true;
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  return (
    <main className="fixture-shell">
      <MetricChart
        emptyMessage="No benchmark data"
        height={360}
        metricKey="train/loss"
        onZoomRangeChange={setZoomRange}
        series={series}
        showChartOptions
        showExportActions={false}
        showLegend
        showRange
        xMode="step"
        zoomRange={zoomRange}
      />
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing chart fixture root");
const renderStartedAt = performance.now();
createRoot(root).render(<Fixture />);
