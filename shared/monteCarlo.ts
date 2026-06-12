import type { Variable, SimulationResult, Percentiles, Histogram, HistogramBin, SensitivityItem, RiskPreference } from './types';
import { v4 as uuidv4 } from 'uuid';

export function sampleTriangular(min: number, mostLikely: number, max: number): number {
  if (min > max) [min, max] = [max, min];
  if (mostLikely < min) mostLikely = min;
  if (mostLikely > max) mostLikely = max;

  const u = Math.random();
  const range = max - min;

  if (range === 0) return min;

  const modePos = (mostLikely - min) / range;
  let result: number;

  if (u < modePos) {
    result = min + Math.sqrt(u * range * (mostLikely - min));
  } else {
    result = max - Math.sqrt((1 - u) * range * (max - mostLikely));
  }

  return result;
}

export function calcMean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

export function calcMedian(sortedArr: number[]): number {
  if (sortedArr.length === 0) return 0;
  const mid = Math.floor(sortedArr.length / 2);
  if (sortedArr.length % 2 === 0) {
    return (sortedArr[mid - 1] + sortedArr[mid]) / 2;
  }
  return sortedArr[mid];
}

export function calcStdDev(arr: number[], mean: number): number {
  if (arr.length === 0) return 0;
  const variance = arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
}

export function calcPercentile(sortedArr: number[], p: number): number {
  if (sortedArr.length === 0) return 0;
  const idx = (p / 100) * (sortedArr.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedArr[lo];
  const frac = idx - lo;
  return sortedArr[lo] * (1 - frac) + sortedArr[hi] * frac;
}

export function calcPercentiles(sortedArr: number[]): Percentiles {
  return {
    p5: calcPercentile(sortedArr, 5),
    p25: calcPercentile(sortedArr, 25),
    p50: calcPercentile(sortedArr, 50),
    p75: calcPercentile(sortedArr, 75),
    p95: calcPercentile(sortedArr, 95),
  };
}

export function calcLossProbability(arr: number[], threshold: number): number {
  if (arr.length === 0) return 0;
  const losses = arr.filter(v => v < threshold).length;
  return losses / arr.length;
}

export function buildHistogram(arr: number[], numBins?: number): Histogram {
  if (arr.length === 0) return { bins: [] };

  const min = Math.min(...arr);
  const max = Math.max(...arr);

  if (!numBins) {
    numBins = Math.ceil(Math.log2(arr.length)) + 1;
  }

  const range = max - min || 1;
  const binWidth = range / numBins;

  const bins: HistogramBin[] = [];
  for (let i = 0; i < numBins; i++) {
    bins.push({
      start: min + i * binWidth,
      end: min + (i + 1) * binWidth,
      count: 0,
    });
  }

  for (const v of arr) {
    let idx = Math.floor((v - min) / binWidth);
    if (idx >= numBins) idx = numBins - 1;
    if (idx < 0) idx = 0;
    bins[idx].count++;
  }

  return { bins };
}

export function calcPearsonCorrelation(x: number[], y: number[]): number {
  const n = x.length;
  if (n === 0 || n !== y.length) return 0;

  const meanX = calcMean(x);
  const meanY = calcMean(y);

  let num = 0;
  let denomX = 0;
  let denomY = 0;

  for (let i = 0; i < n; i++) {
    const dx = x[i] - meanX;
    const dy = y[i] - meanY;
    num += dx * dy;
    denomX += dx * dx;
    denomY += dy * dy;
  }

  if (denomX === 0 || denomY === 0) return 0;
  return num / Math.sqrt(denomX * denomY);
}

export function calcSensitivity(
  variables: Variable[],
  variableSamples: Record<string, number[]>,
  results: number[]
): SensitivityItem[] {
  const correlations: SensitivityItem[] = variables.map(v => {
    const samples = variableSamples[v.id] || [];
    const corr = calcPearsonCorrelation(samples, results);
    return {
      variableId: v.id,
      variableName: v.name,
      correlation: corr,
      contribution: 0,
    };
  });

  const totalAbs = correlations.reduce((s, c) => s + Math.abs(c.correlation), 0);
  if (totalAbs > 0) {
    correlations.forEach(c => {
      c.contribution = (Math.abs(c.correlation) / totalAbs) * 100;
    });
  }

  correlations.sort((a, b) => b.contribution - a.contribution);
  return correlations;
}

export interface SimulateOptions {
  iterations: number;
  threshold: number;
  runName?: string;
}

export function runMonteCarloSimulation(
  projectId: string,
  variables: Variable[],
  options: SimulateOptions
): SimulationResult {
  const { iterations, threshold, runName } = options;

  const variableSamples: Record<string, number[]> = {};
  variables.forEach(v => {
    variableSamples[v.id] = new Array(iterations);
  });

  const results = new Array(iterations);

  for (let i = 0; i < iterations; i++) {
    let iterResult = 0;
    for (const v of variables) {
      const sample = sampleTriangular(v.min, v.mostLikely, v.max);
      variableSamples[v.id][i] = sample;
      iterResult += sample * v.weight;
    }
    results[i] = iterResult;
  }

  const sortedResults = [...results].sort((a, b) => a - b);
  const mean = calcMean(results);
  const median = calcMedian(sortedResults);
  const stdDev = calcStdDev(results, mean);
  const percentiles = calcPercentiles(sortedResults);
  const lossProb = calcLossProbability(results, threshold);
  const var95 = percentiles.p5;
  const histogram = buildHistogram(results);
  const sensitivity = calcSensitivity(variables, variableSamples, results);

  return {
    id: uuidv4(),
    projectId,
    runName: runName || `运行 ${new Date().toLocaleString('zh-CN')}`,
    iterations,
    timestamp: new Date().toISOString(),
    mean,
    median,
    stdDev,
    min: sortedResults[0],
    max: sortedResults[sortedResults.length - 1],
    percentiles,
    lossProbability: lossProb,
    var95,
    threshold,
    histogram,
    sensitivity,
    samples: results,
    variableSamples,
  };
}

export function formatNumber(num: number, decimals = 2): string {
  if (!isFinite(num)) return 'N/A';
  return num.toLocaleString('zh-CN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function formatPercentage(num: number, decimals = 2): string {
  if (!isFinite(num)) return 'N/A';
  return (num * 100).toLocaleString('zh-CN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }) + '%';
}

export interface RiskLevelResult {
  level: string;
  color: string;
  bg: string;
  border: string;
  focusMetrics: string[];
  explanation: string;
}

export function getRiskLevel(
  sim: SimulationResult,
  preference: RiskPreference = 'balanced'
): RiskLevelResult {
  const { lossProbability, var95, mean, stdDev, percentiles } = sim;
  const cv = mean !== 0 ? stdDev / Math.abs(mean) : Infinity;
  const tailLoss = Math.abs(var95);
  const upsideRatio = mean > 0 ? percentiles.p95 / mean : 0;

  if (preference === 'conservative') {
    if (lossProbability >= 0.2 || tailLoss > Math.abs(mean) * 1.5) {
      return {
        level: '高风险',
        color: 'text-monte-danger',
        bg: 'bg-monte-danger/15',
        border: 'border-monte-danger/40',
        focusMetrics: ['亏损概率', '95% VaR', '尾部亏损'],
        explanation: `保守视角下，该项目尾部风险显著：亏损概率达 ${formatPercentage(lossProbability)}，最坏5%情景下亏损达 ${formatNumber(var95)}，尾部亏损已超过均值的1.5倍。建议严格控制下行风险，设置止损策略。`,
      };
    }
    if (lossProbability >= 0.1 || tailLoss > Math.abs(mean)) {
      return {
        level: '中高风险',
        color: 'text-monte-warn',
        bg: 'bg-monte-warn/15',
        border: 'border-monte-warn/40',
        focusMetrics: ['亏损概率', '95% VaR'],
        explanation: `保守视角下，该项目存在不可忽视的下行风险：亏损概率 ${formatPercentage(lossProbability)}，95% VaR 为 ${formatNumber(var95)}。尾部亏损接近均值水平，需要制定风险缓释方案。`,
      };
    }
    if (lossProbability >= 0.05) {
      return {
        level: '中等风险',
        color: 'text-emerald-300',
        bg: 'bg-emerald-500/15',
        border: 'border-emerald-500/40',
        focusMetrics: ['亏损概率', '95% VaR'],
        explanation: `保守视角下，该项目尾部风险可控：亏损概率 ${formatPercentage(lossProbability)}，95% VaR 为 ${formatNumber(var95)}。下行空间有限但仍需关注极端情景。`,
      };
    }
    return {
      level: '低风险',
      color: 'text-monte-safe',
      bg: 'bg-monte-safe/15',
      border: 'border-monte-safe/40',
      focusMetrics: ['95% VaR', '尾部稳定性'],
      explanation: `保守视角下，该项目尾部风险极低：亏损概率仅 ${formatPercentage(lossProbability)}，95% VaR 为 ${formatNumber(var95)}。即使极端情景下结果仍然稳健。`,
    };
  }

  if (preference === 'aggressive') {
    if (mean < 0 && lossProbability > 0.5) {
      return {
        level: '高风险',
        color: 'text-monte-danger',
        bg: 'bg-monte-danger/15',
        border: 'border-monte-danger/40',
        focusMetrics: ['期望均值', '上行空间'],
        explanation: `进取视角下，该项目均值 ${formatNumber(mean)} 为负，不具备上行价值。即使关注增长潜力，负期望项目也不应参与。`,
      };
    }
    if (lossProbability > 0.5 || (mean > 0 && cv > 1.0)) {
      return {
        level: '中高风险',
        color: 'text-monte-warn',
        bg: 'bg-monte-warn/15',
        border: 'border-monte-warn/40',
        focusMetrics: ['期望均值', '变异系数', '上行空间'],
        explanation: `进取视角下，该项目波动较大（变异系数 ${formatPercentage(cv / 100)}），但均值 ${formatNumber(mean)} 为正，上行空间到 ${formatNumber(percentiles.p95)}。高波动意味着高机会，需评估上行空间是否值得承担风险。`,
      };
    }
    if (mean > 0 && cv > 0.5) {
      return {
        level: '中等风险',
        color: 'text-emerald-300',
        bg: 'bg-emerald-500/15',
        border: 'border-emerald-500/40',
        focusMetrics: ['期望均值', '上行空间', '变异系数'],
        explanation: `进取视角下，该项目具有正向期望 ${formatNumber(mean)}，上行空间可达 ${formatNumber(percentiles.p95)}（上行比率 ${formatNumber(upsideRatio, 2)}x）。波动带来机会，适合寻求增长的投资者。`,
      };
    }
    return {
      level: '低风险',
      color: 'text-monte-safe',
      bg: 'bg-monte-safe/15',
      border: 'border-monte-safe/40',
      focusMetrics: ['期望均值', '上行确定性'],
      explanation: `进取视角下，该项目期望稳定 ${formatNumber(mean)}，波动小、确定性高。上行空间 ${formatNumber(percentiles.p95)} 虽然有限，但正回报几乎确定，适合稳健进取型配置。`,
    };
  }

  if (lossProbability < 0.1) {
    return {
      level: '低风险',
      color: 'text-monte-safe',
      bg: 'bg-monte-safe/15',
      border: 'border-monte-safe/40',
      focusMetrics: ['亏损概率', '期望均值'],
      explanation: `均衡视角下，该项目风险较低：亏损概率 ${formatPercentage(lossProbability)}，期望值 ${formatNumber(mean)}。综合下行风险与上行收益，项目整体表现稳健。`,
    };
  }
  if (lossProbability < 0.3) {
    return {
      level: '中低风险',
      color: 'text-emerald-300',
      bg: 'bg-emerald-500/15',
      border: 'border-emerald-500/40',
      focusMetrics: ['亏损概率', '期望均值', '95% VaR'],
      explanation: `均衡视角下，该项目风险适中偏低：亏损概率 ${formatPercentage(lossProbability)}，期望值 ${formatNumber(mean)}，95% VaR 为 ${formatNumber(var95)}。需关注但不必过度担忧。`,
    };
  }
  if (lossProbability < 0.5) {
    return {
      level: '中等风险',
      color: 'text-monte-warn',
      bg: 'bg-monte-warn/15',
      border: 'border-monte-warn/40',
      focusMetrics: ['亏损概率', '期望均值', '95% VaR'],
      explanation: `均衡视角下，该项目风险处于中等水平：亏损概率 ${formatPercentage(lossProbability)}，期望值 ${formatNumber(mean)}。风险与收益并存，需综合评估。`,
    };
  }
  return {
    level: '高风险',
    color: 'text-monte-danger',
    bg: 'bg-monte-danger/15',
    border: 'border-monte-danger/40',
    focusMetrics: ['亏损概率', '95% VaR', '期望均值'],
    explanation: `均衡视角下，该项目风险显著：亏损概率达 ${formatPercentage(lossProbability)}，95% VaR 为 ${formatNumber(var95)}，期望值 ${formatNumber(mean)}。下行风险突出，需慎重决策。`,
  };
}
