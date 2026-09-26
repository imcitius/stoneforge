/**
 * Cost Service
 *
 * Calculates estimated costs for LLM usage based on model pricing.
 * Uses the shared pricing configuration from @stoneforge/core and
 * provides integration with the metrics service for computing costs
 * on aggregated metrics data.
 */

import type { StorageBackend } from '@stoneforge/storage';
import {
  type CostBreakdown,
  calculateCost,
  calculateCostFromPricing,
  lookupModelPricing,
} from '@stoneforge/core';
import type { AggregatedMetrics } from './metrics-service.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('cost-service');

// ============================================================================
// Types
// ============================================================================

/**
 * AggregatedMetrics enriched with cost breakdown
 */
export interface AggregatedMetricsWithCost extends AggregatedMetrics {
  /** Subtotal for sessions with observed usage and known pricing. */
  estimatedCost: CostBreakdown;
  estimatedCostStatus: 'available' | 'partial' | 'unavailable';
  pricedSessionCount: number;
}

/**
 * Database row for per-model cost aggregation query
 */
interface DbModelCostRow {
  [key: string]: unknown;
  session_count: number;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
}

// ============================================================================
// Interface
// ============================================================================

export interface CostService {
  /**
   * Calculate cost breakdown for a single model's token usage.
   *
   * @param model - Model name (full or partial)
   * @param provider - Provider name
   * @param inputTokens - Input token count
   * @param outputTokens - Output token count
   * @param cacheReadTokens - Cache read token count
   * @param cacheCreationTokens - Cache creation token count
   * @returns CostBreakdown with per-category and total costs
   */
  calculateCost(
    model: string,
    provider: string,
    inputTokens: number,
    outputTokens: number,
    cacheReadTokens: number,
    cacheCreationTokens: number
  ): CostBreakdown;

  /**
   * Enrich aggregated metrics with cost breakdowns.
   *
   * Queries observed per-model usage for every grouping; unmatched pricing
   * and unavailable usage are excluded and reported through coverage fields.
   *
   * @param metrics - Array of aggregated metrics entries
   * @param groupBy - How the metrics are grouped ('provider' | 'model' | 'agent' | 'session')
   * @param timeRange - Time range for DB queries (days)
   * @returns Metrics enriched with estimatedCost fields
   */
  enrichWithCosts(
    metrics: AggregatedMetrics[],
    groupBy: 'provider' | 'model' | 'agent' | 'session',
    timeRange?: { days: number }
  ): AggregatedMetricsWithCost[];
}

// ============================================================================
// Implementation
// ============================================================================

export function createCostService(storage: StorageBackend): CostService {
  return {
    // Preserve the standalone pricing helper's API. Metrics enrichment below
    // only estimates observed usage for models with an existing price entry.
    calculateCost(model, provider, input, output, read, creation) {
      const result = calculateCost(model, provider, input, output, read, creation);
      return { inputCost: result.inputCost, outputCost: result.outputCost,
        cacheReadCost: result.cacheReadCost, cacheCreationCost: result.cacheCreationCost,
        totalCost: result.totalCost };
    },

    enrichWithCosts(metrics, groupBy, timeRange) {
      return metrics.map(metric => {
        const estimatedCost: CostBreakdown = {
          inputCost: 0, outputCost: 0, cacheReadCost: 0, cacheCreationCost: 0, totalCost: 0,
        };
        let pricedSessionCount = 0;
        try {
          const cutoff = new Date();
          cutoff.setDate(cutoff.getDate() - (timeRange?.days ?? 7));
          const groupColumn = groupBy === 'provider' ? 'pm.provider'
            : groupBy === 'model' ? "COALESCE(pm.model, 'unknown')" : 'pm.session_id';
          const groupFilter = groupBy === 'agent'
            ? 'EXISTS (SELECT 1 FROM session_messages sm WHERE sm.session_id = pm.session_id AND sm.agent_id = ?)'
            : `${groupColumn} = ?`;
          const rows = storage.query<DbModelCostRow>(
            `SELECT pm.model, COUNT(*) AS session_count,
              SUM(pm.input_tokens) AS input_tokens, SUM(pm.output_tokens) AS output_tokens,
              SUM(pm.cache_read_tokens) AS cache_read_tokens,
              SUM(pm.cache_creation_tokens) AS cache_creation_tokens
             FROM provider_metrics pm WHERE ${groupFilter}
               AND pm.usage_available = 1 ${groupBy === 'session' ? '' : 'AND pm.timestamp >= ?'}
             GROUP BY pm.model`,
            groupBy === 'session' ? [metric.group] : [metric.group, cutoff.toISOString()]
          );
          for (const row of rows) {
            const { pricing, matched } = lookupModelPricing(row.model ?? 'unknown');
            if (!matched) continue;
            const cost = calculateCostFromPricing(pricing, Number(row.input_tokens),
              Number(row.output_tokens), Number(row.cache_read_tokens), Number(row.cache_creation_tokens));
            estimatedCost.inputCost += cost.inputCost;
            estimatedCost.outputCost += cost.outputCost;
            estimatedCost.cacheReadCost += cost.cacheReadCost;
            estimatedCost.cacheCreationCost += cost.cacheCreationCost;
            estimatedCost.totalCost += cost.totalCost;
            pricedSessionCount += Number(row.session_count);
          }
        } catch (error) {
          logger.error(`Failed to compute costs for ${groupBy} group "${metric.group}":`, error);
        }
        return { ...metric, estimatedCost, pricedSessionCount,
          estimatedCostStatus: pricedSessionCount === metric.sessionCount ? 'available' as const
            : pricedSessionCount > 0 ? 'partial' as const : 'unavailable' as const };
      });
    },
  };
}
