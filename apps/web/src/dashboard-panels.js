export const METRIC_SERIES_PATCH_SIZE = 100;
export const DENSE_CHART_SERIES_THRESHOLD = 120;
export const DENSE_CHART_POINT_THRESHOLD = 8000;

export function adaptiveMetricSeriesLimit(runCount) {
  if (runCount >= 1500) return 60;
  if (runCount >= 800) return 80;
  if (runCount >= 400) return 120;
  if (runCount >= 250) return 160;
  if (runCount >= 100) return 250;
  if (runCount >= 50) return 500;
  return 1000;
}

export function adaptiveMetricSeriesPatchSize(runCount) {
  if (runCount >= 1500) return 2000;
  if (runCount >= 500) return 500;
  if (runCount >= 250) return 250;
  return METRIC_SERIES_PATCH_SIZE;
}

export function chunkRunIds(runs, size = adaptiveMetricSeriesPatchSize(runs.length)) {
  const ids = runs.map((run) => run?.id).filter(Boolean);
  const chunks = [];
  for (let index = 0; index < ids.length; index += size) {
    chunks.push(ids.slice(index, index + size));
  }
  return chunks;
}

export function mergeMetricSeriesPatches(runs, current, patch) {
  const byId = new Map(current.map((series) => [series.id, series]));
  for (const series of patch) byId.set(series.id, series);
  return runs
    .filter((run) => run?.id)
    .map((run) => byId.get(run.id) ?? { id: run.id, name: run.name, group: "all", points: [] });
}

export function latestMetricValues(runs, metricKey) {
  return runs
    .map((run, index) => {
      const latest = run?.metric_aggregates?.[metricKey]?.latest;
      return {
        id: run?.id ?? `run-${index}`,
        index,
        name: run?.name ?? `Run ${index + 1}`,
        value: Number(latest),
      };
    })
    .filter((item) => Number.isFinite(item.value));
}

export function histogramBins(values, requestedBins = 12) {
  const finite = values.map(Number).filter(Number.isFinite);
  if (!finite.length) return [];
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  if (min === max) return [{ min, max, count: finite.length }];
  const binCount = Math.max(1, Math.min(requestedBins, Math.ceil(Math.sqrt(finite.length))));
  const width = (max - min) / binCount;
  const bins = Array.from({ length: binCount }, (_, index) => ({
    min: min + index * width,
    max: index === binCount - 1 ? max : min + (index + 1) * width,
    count: 0,
  }));
  for (const value of finite) {
    const rawIndex = Math.floor((value - min) / width);
    const index = Math.max(0, Math.min(bins.length - 1, rawIndex));
    bins[index].count += 1;
  }
  return bins;
}

export function indexedAxisTicks(length, count = 5) {
  const safeLength = Math.floor(Number(length));
  if (!Number.isFinite(safeLength) || safeLength <= 0) return [];
  if (safeLength === 1) return [0];
  const tickCount = Math.max(2, Math.min(Math.floor(count), safeLength));
  const maxIndex = safeLength - 1;
  const ticks = [];
  for (let index = 0; index < tickCount; index += 1) {
    ticks.push(Math.round((maxIndex * index) / (tickCount - 1)));
  }
  return [...new Set(ticks)];
}

export function chartPointCount(series) {
  return (series ?? []).reduce((sum, item) => sum + (item?.normalizedPoints?.length ?? item?.points?.length ?? 0), 0);
}

export function shouldUseDenseChart(series) {
  const plottedSeries = (series ?? []).filter((item) => (item?.normalizedPoints?.length ?? item?.points?.length ?? 0) > 0);
  return plottedSeries.length > DENSE_CHART_SERIES_THRESHOLD || chartPointCount(plottedSeries) > DENSE_CHART_POINT_THRESHOLD;
}
