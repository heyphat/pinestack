import type { BarMagnifierSummary } from './result.js';

export interface FillModelPresentation {
  readonly line: string;
  readonly detail?: string;
}

/** Format only piner's authoritative report block; injected data presence is ignored. */
export function formatFillModel(summary: {
  calcOnOrderFills?: boolean;
  barMagnifier?: BarMagnifierSummary;
}): FillModelPresentation {
  const coof = summary.calcOnOrderFills ? ' + calc on order fills' : '';
  const block = summary.barMagnifier;
  if (!block) return { line: `fill model: standard chart OHLC${coof}` };

  const target = humanPineTimeframe(block.targetTimeframe);
  if (!block.active) {
    const reason = block.coverage === 'no-data' ? 'no covered bars' : block.coverage;
    return {
      line:
        `fill model: standard chart OHLC${coof} ` +
        `(bar magnifier requested for ${target}; inactive, ${reason})`,
    };
  }

  const processed = block.magnifiedBars + block.fallbackBars;
  const coverage = processed > 0 ? Math.min(100, (block.magnifiedBars / processed) * 100) : 0;
  return {
    line: `fill model: bar magnifier${coof}`,
    detail:
      `magnifier: ${target}; ${block.magnifiedBars.toLocaleString('en-US')}/` +
      `${processed.toLocaleString('en-US')} chart bars (${coverage.toFixed(2)}%); ` +
      `${block.intrabarsUsed.toLocaleString('en-US')} intrabars; coverage=${block.coverage}`,
  };
}

function humanPineTimeframe(timeframe: string): string {
  if (/^\d+$/.test(timeframe)) return `${timeframe}m`;
  const match = /^(\d*)([SDWMT])$/.exec(timeframe);
  if (!match) return timeframe;
  const count = match[1] || '1';
  return `${count}${match[2]!.toLowerCase()}`;
}
