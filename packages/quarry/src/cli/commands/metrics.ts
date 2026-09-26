/**
 * Metrics Command - Show provider metrics
 *
 * Displays LLM provider usage metrics including token counts,
 * estimated costs, session counts, and error rates.
 *
 * Cost estimates use per-model pricing from @stoneforge/core's
 * model pricing configuration, covering all 4 token categories.
 */

import type { Command, GlobalOptions, CommandResult, CommandOption } from '../types.js';
import { success, failure, ExitCode } from '../types.js';
import { createAPI } from '../db.js';
import type { StorageBackend } from '@stoneforge/storage';
import {
  type CostBreakdown,
  calculateCostFromPricing,
  lookupModelPricing,
} from '@stoneforge/core';

// ============================================================================
// Types
// ============================================================================

interface AggregateRow {
  [key: string]: unknown;
  group_key: string;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_creation_tokens: number;
  session_count: number;
  usage_session_count: number;
  legacy_session_count: number;
  avg_duration_ms: number;
  failed_count: number;
  rate_limited_count: number;
}

/** Per-model token breakdown for cost aggregation within a group */
interface ModelTokenRow {
  [key: string]: unknown;
  group_key: string;
  model: string | null;
  session_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
}

interface Coverage {
  usageStatus: 'available' | 'partial' | 'unavailable' | 'unknown';
  usageSessionCount: number;
  legacySessionCount: number;
  estimatedCostStatus: 'available' | 'partial' | 'unavailable';
  pricedSessionCount: number;
}

function coverage(count: number, observed: number, legacy: number, priced: number): Coverage {
  return {
    usageStatus: count > 0 && observed === count ? 'available' : observed > 0 ? 'partial'
      : legacy > 0 ? 'unknown' : 'unavailable',
    usageSessionCount: observed,
    legacySessionCount: legacy,
    estimatedCostStatus: count > 0 && priced === count ? 'available' : priced > 0 ? 'partial' : 'unavailable',
    pricedSessionCount: priced,
  };
}

function usageValue(value: number, status: Coverage['usageStatus']): string {
  return status === 'available' ? formatNumber(value)
    : status === 'partial' ? `${formatNumber(value)} (partial; recorded subtotal)` : status;
}

function costValue(value: number, status: Coverage['estimatedCostStatus']): string {
  return status === 'available' ? formatCost(value)
    : status === 'partial' ? `${formatCost(value)} (partial; priced subtotal)` : status;
}

function coverageText(m: Coverage & { sessionCount: number }): string {
  return `Usage observed: ${m.usageSessionCount}/${m.sessionCount} metric records; legacy unknown: ${m.legacySessionCount}; priced: ${m.pricedSessionCount}/${m.sessionCount}`;
}

interface MetricsSummary {
  timeRange: { days: number; label: string };
  groupBy: string;
  metrics: Array<Coverage & {
    group: string;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCacheReadTokens: number;
    totalCacheCreationTokens: number;
    totalTokens: number;
    sessionCount: number;
    avgDurationMs: number;
    errorRate: number;
    failedCount: number;
    rateLimitedCount: number;
    estimatedCost: CostBreakdown;
  }>;
  totals: Coverage & {
    totalInputTokens: number;
    totalOutputTokens: number;
    totalTokens: number;
    sessionCount: number;
    estimatedCost: CostBreakdown;
  };
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Parse a time range string (e.g., '7d', '14d', '30d') to number of days.
 */
function parseTimeRange(value: string | undefined): number {
  if (!value) return 7;
  const match = value.match(/^(\d+)d$/);
  if (match) {
    const days = parseInt(match[1], 10);
    if (days > 0 && days <= 365) return days;
  }
  return 7;
}

/**
 * Format a number with thousands separators
 */
function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

/**
 * Format milliseconds as human-readable duration
 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

/**
 * Format cost as a dollar amount.
 * - < $0.01: show "< $0.01"
 * - < $1: show "$0.XX"
 * - < $100: show "$X.XX"
 * - >= $100: show "$XXX"
 */
function formatCost(cost: number): string {
  if (cost === 0) return '$0.00';
  if (cost < 0.01) return '< $0.01';
  if (cost < 100) return `$${cost.toFixed(2)}`;
  return `$${Math.round(cost)}`;
}

/**
 * Query aggregated metrics directly from the database
 */
function queryMetrics(
  backend: StorageBackend,
  cutoffStr: string,
  groupBy: 'provider' | 'model',
  providerFilter?: string
): AggregateRow[] {
  const groupExpr = groupBy === 'provider' ? 'provider' : "COALESCE(model, 'unknown')";
  const params: unknown[] = [cutoffStr];

  let whereClause = 'WHERE timestamp >= ?';
  if (providerFilter) {
    whereClause += ' AND provider = ?';
    params.push(providerFilter);
  }

  return backend.query<AggregateRow>(
    `SELECT
       ${groupExpr} AS group_key,
       COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
       COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
       COALESCE(SUM(cache_read_tokens), 0) AS total_cache_read_tokens,
       COALESCE(SUM(cache_creation_tokens), 0) AS total_cache_creation_tokens,
       COUNT(*) AS session_count,
       SUM(CASE WHEN usage_available = 1 THEN 1 ELSE 0 END) AS usage_session_count,
       SUM(CASE WHEN usage_available IS NULL THEN 1 ELSE 0 END) AS legacy_session_count,
       COALESCE(AVG(duration_ms), 0) AS avg_duration_ms,
       COALESCE(SUM(CASE WHEN outcome = 'failed' THEN 1 ELSE 0 END), 0) AS failed_count,
       COALESCE(SUM(CASE WHEN outcome = 'rate_limited' THEN 1 ELSE 0 END), 0) AS rate_limited_count
     FROM provider_metrics
     ${whereClause}
     GROUP BY group_key
     ORDER BY total_input_tokens + total_output_tokens DESC`,
    params
  );
}

/** Price only observed records with a matched model, for either grouping. */
function computeGroupCost(
  backend: StorageBackend,
  group: string,
  groupBy: 'provider' | 'model',
  cutoffStr: string,
  providerFilter?: string
): { estimatedCost: CostBreakdown; pricedSessionCount: number } {
  const groupExpr = groupBy === 'provider' ? 'provider' : "COALESCE(model, 'unknown')";
  const rows = backend.query<ModelTokenRow>(
    `SELECT model, COUNT(*) AS session_count,
       SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
       SUM(cache_read_tokens) AS cache_read_tokens,
       SUM(cache_creation_tokens) AS cache_creation_tokens
     FROM provider_metrics
     WHERE timestamp >= ? AND ${groupExpr} = ? AND usage_available = 1
       ${providerFilter ? 'AND provider = ?' : ''}
     GROUP BY model`,
    providerFilter ? [cutoffStr, group, providerFilter] : [cutoffStr, group]
  );
  const costs: CostBreakdown[] = [];
  let pricedSessionCount = 0;
  for (const row of rows) {
    const { pricing, matched } = lookupModelPricing(row.model ?? 'unknown');
    if (!matched) continue;
    costs.push(calculateCostFromPricing(pricing, Number(row.input_tokens),
      Number(row.output_tokens), Number(row.cache_read_tokens), Number(row.cache_creation_tokens)));
    pricedSessionCount += Number(row.session_count);
  }
  return { estimatedCost: sumCosts(costs), pricedSessionCount };
}

/**
 * Sum multiple CostBreakdown objects into a single total.
 */
function sumCosts(costs: CostBreakdown[]): CostBreakdown {
  const result: CostBreakdown = {
    inputCost: 0,
    outputCost: 0,
    cacheReadCost: 0,
    cacheCreationCost: 0,
    totalCost: 0,
  };
  for (const c of costs) {
    result.inputCost += c.inputCost;
    result.outputCost += c.outputCost;
    result.cacheReadCost += c.cacheReadCost;
    result.cacheCreationCost += c.cacheCreationCost;
    result.totalCost += c.totalCost;
  }
  return result;
}

// ============================================================================
// Handler
// ============================================================================

async function metricsHandler(
  _args: string[],
  options: GlobalOptions
): Promise<CommandResult> {
  const { backend, error } = createAPI(options);
  if (error) {
    return failure(error, ExitCode.GENERAL_ERROR);
  }

  try {
    const days = parseTimeRange(options.range as string | undefined);
    const providerFilter = options.provider as string | undefined;
    const groupBy = (options['group-by'] as string | undefined) === 'model' ? 'model' : 'provider';

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffStr = cutoff.toISOString();
    const rows = queryMetrics(backend, cutoffStr, groupBy, providerFilter);

    const metrics = rows.map(row => {
      const { estimatedCost, pricedSessionCount } = computeGroupCost(
        backend, row.group_key, groupBy, cutoffStr, providerFilter);

      return {
        ...coverage(Number(row.session_count), Number(row.usage_session_count),
          Number(row.legacy_session_count), pricedSessionCount),
        group: row.group_key,
        totalInputTokens: Number(row.total_input_tokens),
        totalOutputTokens: Number(row.total_output_tokens),
        totalCacheReadTokens: Number(row.total_cache_read_tokens),
        totalCacheCreationTokens: Number(row.total_cache_creation_tokens),
        totalTokens: Number(row.total_input_tokens) + Number(row.total_output_tokens),
        sessionCount: Number(row.session_count),
        avgDurationMs: Math.round(Number(row.avg_duration_ms)),
        errorRate: Number(row.session_count) > 0
          ? Number(row.failed_count) / Number(row.session_count)
          : 0,
        failedCount: Number(row.failed_count),
        rateLimitedCount: Number(row.rate_limited_count),
        estimatedCost,
      };
    });

    const totalCost = sumCosts(metrics.map(m => m.estimatedCost));

    const totals = {
      ...coverage(metrics.reduce((s, m) => s + m.sessionCount, 0),
        metrics.reduce((s, m) => s + m.usageSessionCount, 0),
        metrics.reduce((s, m) => s + m.legacySessionCount, 0),
        metrics.reduce((s, m) => s + m.pricedSessionCount, 0)),
      totalInputTokens: metrics.reduce((sum, m) => sum + m.totalInputTokens, 0),
      totalOutputTokens: metrics.reduce((sum, m) => sum + m.totalOutputTokens, 0),
      totalTokens: metrics.reduce((sum, m) => sum + m.totalTokens, 0),
      sessionCount: metrics.reduce((sum, m) => sum + m.sessionCount, 0),
      estimatedCost: totalCost,
    };

    const summary: MetricsSummary = {
      timeRange: { days, label: `${days}d` },
      groupBy,
      metrics,
      totals,
    };

    // Build human-readable output
    const lines: string[] = [];
    const groupLabel = groupBy === 'provider' ? 'Provider' : 'Model';

    lines.push(`Provider Metrics (last ${days} days)`);
    if (providerFilter) {
      lines.push(`Filtered by provider: ${providerFilter}`);
    }
    lines.push('');

    if (metrics.length === 0) {
      lines.push('No metrics recorded for the selected time range.');
      return success(summary, lines.join('\n'));
    }

    // Summary totals
    const totalCacheRead = metrics.reduce((s, m) => s + m.totalCacheReadTokens, 0);
    const totalCacheCreation = metrics.reduce((s, m) => s + m.totalCacheCreationTokens, 0);

    lines.push('Summary:');
    lines.push(`  ${coverageText(totals)}`);
    if (totals.legacySessionCount > 0) {
      lines.push('  Recorded token subtotals retain unverified legacy values.');
    }
    lines.push(`  Total tokens:          ${usageValue(totals.totalTokens, totals.usageStatus)}`);
    lines.push(`  Input tokens:          ${usageValue(totals.totalInputTokens, totals.usageStatus)}`);
    lines.push(`  Output tokens:         ${usageValue(totals.totalOutputTokens, totals.usageStatus)}`);
    lines.push(`  Cache read tokens:     ${usageValue(totalCacheRead, totals.usageStatus)}`);
    lines.push(`  Cache creation tokens: ${usageValue(totalCacheCreation, totals.usageStatus)}`);
    lines.push(`  Metric records:        ${formatNumber(totals.sessionCount)}`);
    lines.push(`  Estimated cost:        ${costValue(totals.estimatedCost.totalCost, totals.estimatedCostStatus)}`);
    lines.push('');

    // Per-group breakdown
    lines.push(`By ${groupLabel}:`);
    lines.push('');

    for (const m of metrics) {
      lines.push(`  ${m.group}`);
      lines.push(`    ${coverageText(m)}`);
      lines.push(`    Tokens:           ${usageValue(m.totalTokens, m.usageStatus)} total`);
      lines.push(`      Input:          ${usageValue(m.totalInputTokens, m.usageStatus)}`);
      lines.push(`      Output:         ${usageValue(m.totalOutputTokens, m.usageStatus)}`);
      lines.push(`      Cache read:     ${usageValue(m.totalCacheReadTokens, m.usageStatus)}`);
      lines.push(`      Cache creation: ${usageValue(m.totalCacheCreationTokens, m.usageStatus)}`);
      lines.push(`    Metric records:   ${formatNumber(m.sessionCount)}`);
      lines.push(`    Avg duration:     ${formatDuration(m.avgDurationMs)}`);
      lines.push(`    Error rate:       ${(m.errorRate * 100).toFixed(1)}% (${m.failedCount} failed, ${m.rateLimitedCount} rate limited)`);
      lines.push(`    Est. cost:        ${costValue(m.estimatedCost.totalCost, m.estimatedCostStatus)}`);
      lines.push(`      Input:          ${costValue(m.estimatedCost.inputCost, m.estimatedCostStatus)}`);
      lines.push(`      Output:         ${costValue(m.estimatedCost.outputCost, m.estimatedCostStatus)}`);
      lines.push(`      Cache read:     ${costValue(m.estimatedCost.cacheReadCost, m.estimatedCostStatus)}`);
      lines.push(`      Cache creation: ${costValue(m.estimatedCost.cacheCreationCost, m.estimatedCostStatus)}`);
      lines.push('');
    }

    return success(summary, lines.join('\n'));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return failure(`Failed to get metrics: ${message}`, ExitCode.GENERAL_ERROR);
  }
}

// ============================================================================
// Command Options
// ============================================================================

const metricsOptions: CommandOption[] = [
  {
    name: 'range',
    short: 'r',
    description: 'Time range (e.g., 7d, 14d, 30d)',
    hasValue: true,
  },
  {
    name: 'provider',
    short: 'p',
    description: 'Filter by provider name',
    hasValue: true,
  },
  {
    name: 'group-by',
    short: 'g',
    description: 'Group by: provider (default) or model',
    hasValue: true,
  },
];

// ============================================================================
// Command Definition
// ============================================================================

export const metricsCommand: Command = {
  name: 'metrics',
  description: 'Show provider metrics and usage statistics',
  usage: 'sf metrics [options]',
  help: `Show LLM provider usage metrics including token counts, estimated costs,
metric record counts, average duration, and error rates.
Usage: unavailable = not observed; unknown = unverified legacy data;
partial = recorded subtotal, including any unverified legacy values.
Cost subtotals include only observed usage with known model pricing.

Options:
  --range, -r    Time range (e.g., 7d, 14d, 30d). Default: 7d
  --provider, -p Filter by provider name (e.g., claude-code)
  --group-by, -g Group by: provider (default) or model

Examples:
  sf metrics                  Show metrics for last 7 days
  sf metrics --range 30d      Show metrics for last 30 days
  sf metrics --provider claude-code  Filter by provider
  sf metrics --group-by model        Group by model
  sf metrics --json           Output as JSON`,
  handler: metricsHandler,
  options: metricsOptions,
};
