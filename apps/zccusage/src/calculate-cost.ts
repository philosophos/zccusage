/**
 * @fileoverview Cost calculation utilities for usage data analysis
 *
 * This module provides functions for calculating costs and aggregating token usage
 * across different time periods and models. It handles both pre-calculated costs
 * and dynamic cost calculations based on model pricing.
 *
 * @module calculate-cost
 */

import type { AggregatedTokenCounts } from './_token-utils.ts';
import type { DailyUsage, MonthlyUsage, SessionUsage, WeeklyUsage } from './data-loader.ts';
import { getTotalTokens } from './_token-utils.ts';
import {
	createActivityDate,
	createDailyDate,
	createModelName,
	createProjectPath,
	createSessionId,
	createVersion,
} from './_types.ts';

/**
 * Alias for AggregatedTokenCounts from shared utilities
 * @deprecated Use AggregatedTokenCounts from _token-utils.ts instead
 */
type TokenData = AggregatedTokenCounts;

/**
 * Token totals including cost information
 */
type TokenTotals = TokenData & {
	totalCost: number;
	costByCurrency: Record<string, number>;
};

/**
 * Complete totals object with token counts, cost, and total token sum
 */
type TotalsObject = TokenTotals & {
	totalTokens: number;
};

/**
 * Merge a per-item cost-by-currency map into the accumulator. When an item
 * lacks `costByCurrency`, fall back to `{ USD: item.totalCost }` so legacy
 * rows (and codex/opencode) remain representable. Sums amounts per currency.
 */
function mergeCostByCurrency(
	acc: Record<string, number>,
	item: { totalCost: number; costByCurrency?: Record<string, number> },
): Record<string, number> {
	const source = item.costByCurrency ?? { USD: item.totalCost };
	for (const [currency, amount] of Object.entries(source)) {
		acc[currency] = (acc[currency] ?? 0) + amount;
	}
	return acc;
}

/**
 * Calculates total token usage and cost across multiple usage data entries
 * @param data - Array of daily, monthly, or session usage data
 * @returns Aggregated token totals and cost
 *
 * Invariant: `totalCost === sum(costByCurrency.values)` while every item's
 * costs are denominated in USD (the legacy default). Multi-currency items
 * (step 6) populate `costByCurrency` with their billing currency; the display
 * layer converts to the statistics currency, at which point `totalCost`
 * becomes the statistics-currency projection of `costByCurrency`.
 */
export function calculateTotals(
	data: Array<DailyUsage | MonthlyUsage | WeeklyUsage | SessionUsage>,
): TokenTotals {
	return data.reduce(
		(acc, item) => ({
			inputTokens: acc.inputTokens + item.inputTokens,
			outputTokens: acc.outputTokens + item.outputTokens,
			cacheCreationTokens: acc.cacheCreationTokens + item.cacheCreationTokens,
			cacheReadTokens: acc.cacheReadTokens + item.cacheReadTokens,
			totalCost: acc.totalCost + item.totalCost,
			costByCurrency: mergeCostByCurrency(acc.costByCurrency, item),
		}),
		{
			inputTokens: 0,
			outputTokens: 0,
			cacheCreationTokens: 0,
			cacheReadTokens: 0,
			totalCost: 0,
			costByCurrency: {},
		},
	);
}

// Re-export getTotalTokens from shared utilities for backward compatibility
export { getTotalTokens };

/**
 * Creates a complete totals object by adding total token count to existing totals
 * @param totals - Token totals with cost information
 * @returns Complete totals object including total token sum
 */
export function createTotalsObject(totals: TokenTotals): TotalsObject {
	return {
		...totals,
		totalTokens: getTotalTokens(totals),
	};
}

if (import.meta.vitest != null) {
	describe('token aggregation utilities', () => {
		it('calculateTotals should aggregate daily usage data', () => {
			const dailyData: DailyUsage[] = [
				{
					date: createDailyDate('2024-01-01'),
					inputTokens: 100,
					outputTokens: 50,
					cacheCreationTokens: 25,
					cacheReadTokens: 10,
					totalCost: 0.01,
					modelsUsed: [createModelName('claude-sonnet-4-20250514')],
					modelBreakdowns: [],
				},
				{
					date: createDailyDate('2024-01-02'),
					inputTokens: 200,
					outputTokens: 100,
					cacheCreationTokens: 50,
					cacheReadTokens: 20,
					totalCost: 0.02,
					modelsUsed: [createModelName('claude-opus-4-20250514')],
					modelBreakdowns: [],
				},
			];

			const totals = calculateTotals(dailyData);
			expect(totals.inputTokens).toBe(300);
			expect(totals.outputTokens).toBe(150);
			expect(totals.cacheCreationTokens).toBe(75);
			expect(totals.cacheReadTokens).toBe(30);
			expect(totals.totalCost).toBeCloseTo(0.03);
		});

		it('calculateTotals should aggregate daily usage data with claude-sonnet-4-5-20250929', () => {
			const dailyData: DailyUsage[] = [
				{
					date: createDailyDate('2024-01-01'),
					inputTokens: 100,
					outputTokens: 50,
					cacheCreationTokens: 25,
					cacheReadTokens: 10,
					totalCost: 0.01,
					modelsUsed: [createModelName('claude-sonnet-4-5-20250929')],
					modelBreakdowns: [],
				},
				{
					date: createDailyDate('2024-01-02'),
					inputTokens: 200,
					outputTokens: 100,
					cacheCreationTokens: 50,
					cacheReadTokens: 20,
					totalCost: 0.02,
					modelsUsed: [createModelName('claude-sonnet-4-5-20250929')],
					modelBreakdowns: [],
				},
			];

			const totals = calculateTotals(dailyData);
			expect(totals.inputTokens).toBe(300);
			expect(totals.outputTokens).toBe(150);
			expect(totals.cacheCreationTokens).toBe(75);
			expect(totals.cacheReadTokens).toBe(30);
			expect(totals.totalCost).toBeCloseTo(0.03);
		});

		it('calculateTotals should aggregate session usage data', () => {
			const sessionData: SessionUsage[] = [
				{
					sessionId: createSessionId('session-1'),
					projectPath: createProjectPath('project/path'),
					inputTokens: 100,
					outputTokens: 50,
					cacheCreationTokens: 25,
					cacheReadTokens: 10,
					totalCost: 0.01,
					lastActivity: createActivityDate('2024-01-01'),
					versions: [createVersion('1.0.3')],
					modelsUsed: [createModelName('claude-sonnet-4-20250514')],
					modelBreakdowns: [],
				},
				{
					sessionId: createSessionId('session-2'),
					projectPath: createProjectPath('project/path'),
					inputTokens: 200,
					outputTokens: 100,
					cacheCreationTokens: 50,
					cacheReadTokens: 20,
					totalCost: 0.02,
					lastActivity: createActivityDate('2024-01-02'),
					versions: [createVersion('1.0.3'), createVersion('1.0.4')],
					modelsUsed: [createModelName('claude-opus-4-20250514')],
					modelBreakdowns: [],
				},
			];

			const totals = calculateTotals(sessionData);
			expect(totals.inputTokens).toBe(300);
			expect(totals.outputTokens).toBe(150);
			expect(totals.cacheCreationTokens).toBe(75);
			expect(totals.cacheReadTokens).toBe(30);
			expect(totals.totalCost).toBeCloseTo(0.03);
		});

		it('calculateTotals should aggregate session usage data with claude-sonnet-4-5-20250929', () => {
			const sessionData: SessionUsage[] = [
				{
					sessionId: createSessionId('session-1'),
					projectPath: createProjectPath('project/path'),
					inputTokens: 100,
					outputTokens: 50,
					cacheCreationTokens: 25,
					cacheReadTokens: 10,
					totalCost: 0.01,
					lastActivity: createActivityDate('2024-01-01'),
					versions: [createVersion('1.0.3')],
					modelsUsed: [createModelName('claude-sonnet-4-5-20250929')],
					modelBreakdowns: [],
				},
				{
					sessionId: createSessionId('session-2'),
					projectPath: createProjectPath('project/path'),
					inputTokens: 200,
					outputTokens: 100,
					cacheCreationTokens: 50,
					cacheReadTokens: 20,
					totalCost: 0.02,
					lastActivity: createActivityDate('2024-01-02'),
					versions: [createVersion('1.0.3'), createVersion('1.0.4')],
					modelsUsed: [createModelName('claude-sonnet-4-5-20250929')],
					modelBreakdowns: [],
				},
			];

			const totals = calculateTotals(sessionData);
			expect(totals.inputTokens).toBe(300);
			expect(totals.outputTokens).toBe(150);
			expect(totals.cacheCreationTokens).toBe(75);
			expect(totals.cacheReadTokens).toBe(30);
			expect(totals.totalCost).toBeCloseTo(0.03);
		});

		it('getTotalTokens should sum all token types', () => {
			const tokens = {
				inputTokens: 100,
				outputTokens: 50,
				cacheCreationTokens: 25,
				cacheReadTokens: 10,
			};

			const total = getTotalTokens(tokens);
			expect(total).toBe(185);
		});

		it('getTotalTokens should handle zero values', () => {
			const tokens = {
				inputTokens: 0,
				outputTokens: 0,
				cacheCreationTokens: 0,
				cacheReadTokens: 0,
			};

			const total = getTotalTokens(tokens);
			expect(total).toBe(0);
		});

		it('createTotalsObject should create complete totals object', () => {
			const totals = {
				inputTokens: 100,
				outputTokens: 50,
				cacheCreationTokens: 25,
				cacheReadTokens: 10,
				totalCost: 0.01,
				costByCurrency: { USD: 0.01 },
			};

			const totalsObject = createTotalsObject(totals);
			expect(totalsObject).toEqual({
				inputTokens: 100,
				outputTokens: 50,
				cacheCreationTokens: 25,
				cacheReadTokens: 10,
				totalTokens: 185,
				totalCost: 0.01,
				costByCurrency: { USD: 0.01 },
			});
		});

		it('calculateTotals should handle empty array', () => {
			const totals = calculateTotals([]);
			expect(totals).toEqual({
				inputTokens: 0,
				outputTokens: 0,
				cacheCreationTokens: 0,
				cacheReadTokens: 0,
				totalCost: 0,
				costByCurrency: {},
			});
		});

		it('calculateTotals should merge costByCurrency across items', () => {
			const dailyData: DailyUsage[] = [
				{
					date: createDailyDate('2024-01-01'),
					inputTokens: 100,
					outputTokens: 50,
					cacheCreationTokens: 0,
					cacheReadTokens: 0,
					totalCost: 0.01,
					costByCurrency: { USD: 0.01 },
					modelsUsed: [createModelName('claude-sonnet-4-20250514')],
					modelBreakdowns: [],
				},
				{
					date: createDailyDate('2024-01-02'),
					inputTokens: 0,
					outputTokens: 0,
					cacheCreationTokens: 0,
					cacheReadTokens: 0,
					totalCost: 0.02,
					costByCurrency: { CNY: 0.14 },
					modelsUsed: [createModelName('glm-4.5')],
					modelBreakdowns: [],
				},
			];

			const totals = calculateTotals(dailyData);
			// Invariant: USD-only items sum to totalCost; multi-currency items
			// carry their own currency bucket.
			expect(totals.costByCurrency).toEqual({ USD: 0.01, CNY: 0.14 });
			expect(totals.totalCost).toBeCloseTo(0.03);
		});
	});
}
