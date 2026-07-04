/**
 * @fileoverview DuckDB query layer — SQL aggregation → existing UsageData shapes.
 *
 * `queryDailyUsage` / `queryMonthlyUsage` / `queryWeeklyUsage` mirror the legacy
 * `load*UsageData` loaders but aggregate in SQL (sub-300ms at 100k+ entries)
 * instead of JS reduce over globbed JSONL. Equivalence holds because cost is
 * linear in tokens: `SUM(tokens) × pricing === Σ per-entry cost`.
 *
 * Flow: open DB → `syncIngest` (incremental) → SQL `GROUP BY` tokens/cost_usd by
 * (period, model, provider_id, project, source) → JS synthesizes a `UsageData`
 * per row and reuses `calculateCostForEntry` to apply provider-aware pricing →
 * groups rows into period aggregates (tokens summed, `costByCurrency` merged,
 * model breakdowns built inline) → typed wrappers shape them as
 * `DailyUsage` / `MonthlyUsage` / `WeeklyUsage`.
 *
 * Aggregation helpers (`aggregateByModel`, `createModelBreakdowns`, etc. in
 * `data-loader.ts`) are file-private and take raw-entry accessors, so this layer
 * rebuilds the equivalent shapes directly from pre-aggregated SQL rows.
 *
 * Session/blocks remain on the legacy TS path (session needs per-session version
 * arrays + lastActivity; blocks needs 5-hour window logic — see main spec step 7).
 */

import type { Money } from '@zccusage/internal/pricing';
import type { CostMode, Source } from './_types.ts';
import type { DailyUsage, LoadOptions, ModelBreakdown, MonthlyUsage, SessionUsage, UsageData, WeeklyUsage } from './data-loader.ts';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { groupBy } from 'es-toolkit';
import { createFixture } from 'fs-fixture';
import { filterByDateRange, sortByDate } from './_date-utils.ts';
import { openDb, runQuery, syncIngest } from './_duckdb-store.ts';
import { CcusagePricingFetcher } from './_pricing-fetcher.ts';
import { loadProviderProfiles, loadProviderSchedule } from './_provider-profile-loader.ts';
import { createActivityDate, createDailyDate, createModelName, createMonthlyDate, createProjectPath, createSessionId, createSource, createVersion, createWeeklyDate } from './_types.ts';
import { calculateCostForEntry, loadDailyUsageData, loadMonthlyUsageData, loadSessionData, loadWeeklyUsageData } from './data-loader.ts';
import { logger } from './logger.ts';

/** Extended options: `dbPath` overrides the DuckDB file location; `rebuild` forces a full re-ingest. */
export type QueryOptions = LoadOptions & { dbPath?: string; rebuild?: boolean };

/** Period granularity for the shared aggregation query. */
type PeriodKind = 'daily' | 'monthly' | 'weekly';

type AggregatedRow = {
	period: string;
	model: string | null;
	provider_id: string | null;
	project: string;
	source: string | null;
	input_tokens: number;
	output_tokens: number;
	cache_creation_tokens: number;
	cache_read_tokens: number;
	cost_usd: number | null;
};

/** Neutral period aggregate (before shaping into DailyUsage/MonthlyUsage/WeeklyUsage). */
type AggregatedPeriod = {
	period: string;
	project?: string;
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	totalCost: number;
	costByCurrency: Record<string, number>;
	providerId?: string;
	modelsUsed: string[];
	modelBreakdowns: Array<{
		modelName: string;
		inputTokens: number;
		outputTokens: number;
		cacheCreationTokens: number;
		cacheReadTokens: number;
		cost: number;
		costByCurrency: Record<string, number>;
		providerId?: string;
	}>;
	source: string;
};

/** Merge a `Money` into a `costByCurrency` map (mutates and returns the map). */
function addCostToMap(map: Record<string, number>, money: Money): Record<string, number> {
	const cur = money.currency;
	map[cur] = (map[cur] ?? 0) + money.amount;
	return map;
}

/** Combine per-row `source` values into the `claude`/`droid`/`claude/droid` enum. */
function combineSource(sources: Set<string>): Source {
	const claude = createSource('claude');
	const droid = createSource('droid');
	if (sources.size === 0) {
		return claude;
	}
	if (sources.has(claude) && sources.has(droid)) {
		return createSource('claude/droid');
	}
	if (sources.has(droid)) {
		return droid;
	}
	return claude;
}

/** Pick a representative `providerId` for a group (first non-null, like `uniformProviderId`). */
function uniformProviderId(ids: Array<string | null | undefined>): string | undefined {
	for (const id of ids) {
		if (id != null && id !== '') {
			return id;
		}
	}
	return undefined;
}

/** DuckDB `date_trunc` unit + `strftime` format for each period kind. */
function periodSpec(kind: PeriodKind): { unit: string; fmt: string } {
	switch (kind) {
		case 'daily': {
			return { unit: 'day', fmt: '%Y-%m-%d' };
		}
		case 'monthly': {
			return { unit: 'month', fmt: '%Y-%m' };
		}
		case 'weekly': {
			// date_trunc('week', ...) snaps to Monday (ISO week). Legacy uses
			// `getDateWeek` with a configurable `startOfWeek`; divergence is
			// possible when startOfWeek != Monday — acceptable for OLAP view.
			return { unit: 'week', fmt: '%Y-%m-%d' };
		}
	}
}

/**
 * Shared aggregation query. Opens the DB, runs an incremental `syncIngest`, then
 * SQL-aggregates tokens/cost by period and applies provider-aware pricing in JS.
 * Returns neutral `AggregatedPeriod[]` (sorted by period desc); typed wrappers
 * shape the output.
 */
async function queryByPeriod(options: QueryOptions | undefined, kind: PeriodKind): Promise<AggregatedPeriod[]> {
	const tz = options?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
	const mode: CostMode = options?.mode ?? 'auto';
	const project = options?.project ?? null;
	const provider = options?.provider ?? null;
	const { unit, fmt } = periodSpec(kind);

	const conn = await openDb(options?.dbPath);
	try {
		const profiles = import.meta.vitest != null
			? []
			: await loadProviderProfiles({ ccSwitchDbPath: options?.ccSwitchDbPath });
		const schedule = import.meta.vitest != null
			? options?.providerSchedule
			: (options?.providerSchedule ?? loadProviderSchedule());
		const providerCtx = { profiles, schedule };
		// Thread claudePath through to syncIngest so tests stay hermetic (no real
		// ~ scan). When unset in production, syncIngest falls back to getClaudePaths().
		const claudePaths = options?.claudePath != null ? [options.claudePath] : undefined;
		const droidPath = options?.claudePath != null ? '' : undefined;
		await syncIngest(conn, { claudePaths, droidPath, loadOptions: options, providerContext: providerCtx, rebuild: options?.rebuild });

		const rows = await runQuery<AggregatedRow>(
			conn,
			`SELECT
				strftime(date_trunc('${unit}', timestamp AT TIME ZONE $tz), '${fmt}') AS period,
				model,
				provider_id,
				project,
				source,
				SUM(input_tokens) AS input_tokens,
				SUM(output_tokens) AS output_tokens,
				SUM(cache_creation_tokens) AS cache_creation_tokens,
				SUM(cache_read_tokens) AS cache_read_tokens,
				SUM(cost_usd) AS cost_usd
			FROM usage_facts
			WHERE ($project IS NULL OR project = $project)
				AND ($provider IS NULL OR provider_id = $provider)
			GROUP BY 1, 2, 3, 4, 5`,
			{ tz, project, provider },
		);

		if (rows.length === 0) {
			return [];
		}

		const fetcher = mode === 'display' ? null : new CcusagePricingFetcher({ pricingPath: options?.pricingPath });

		// Per-row Money (provider-aware pricing applied to aggregated tokens).
		// Keyed by row reference so group iteration (a subset of `rows`) stays
		// aligned — indexing by group position would misalign costs.
		const rowCostMap = new Map<AggregatedRow, Money>();
		await Promise.all(rows.map(async (row) => {
			const synth = {
				timestamp: '2026-01-01T00:00:00.000Z',
				message: {
					model: row.model ?? undefined,
					usage: {
						input_tokens: row.input_tokens,
						output_tokens: row.output_tokens,
						cache_creation_input_tokens: row.cache_creation_tokens,
						cache_read_input_tokens: row.cache_read_tokens,
					},
				},
				costUSD: undefined,
			} as unknown as UsageData;
			// mode=auto must NOT fall back to cc-switch's precomputed cost_usd (USD) —
			// that mixes USD into per-provider billing-currency totals and misleads.
			// Always compute from the provider's pricing currency; fetcher==null means
			// no pricing source at all, so 0 rather than a misleading USD figure.
			const money = fetcher == null
				? { amount: 0, currency: 'USD' } as Money
				: await calculateCostForEntry(synth, mode, fetcher, row.provider_id ?? undefined);
			rowCostMap.set(row, money);
		}));

		const needsProjectGrouping = options?.groupByProject === true || options?.project != null;
		const groupingKey = (row: AggregatedRow): string => needsProjectGrouping ? `${row.period}\x00${row.project}` : row.period;
		const grouped = groupBy(rows, groupingKey);

		const results: AggregatedPeriod[] = [];
		for (const [groupKey, groupRows] of Object.entries(grouped)) {
			if (groupRows == null || groupRows.length === 0) {
				continue;
			}
			const parts = groupKey.split('\x00');
			const period = parts[0] ?? groupKey;
			const projectName = parts.length > 1 ? parts[1] : undefined;

			const sources = new Set<string>();
			const modelsUsed = new Set<string>();
			const providerIds: Array<string | null | undefined> = [];
			let inputTokens = 0;
			let outputTokens = 0;
			let cacheCreationTokens = 0;
			let cacheReadTokens = 0;
			let totalCost = 0;
			const costByCurrency: Record<string, number> = {};

			const breakdownMap = new Map<string, {
				model: string;
				providerId: string | null;
				inputTokens: number;
				outputTokens: number;
				cacheCreationTokens: number;
				cacheReadTokens: number;
				cost: number;
				costByCurrency: Record<string, number>;
			}>();

			for (let i = 0; i < groupRows.length; i++) {
				const row = groupRows[i];
				if (row == null) {
					continue;
				}
				// Skip synthetic model (zero-token placeholder, never billed)
				if (row.model === '<synthetic>') {
					continue;
				}
				const cost = rowCostMap.get(row) ?? { amount: 0, currency: 'USD' } as Money;
				if (row.source != null) {
					sources.add(row.source);
				}
				if (row.model != null) {
					modelsUsed.add(row.model);
				}
				providerIds.push(row.provider_id);
				inputTokens += row.input_tokens ?? 0;
				outputTokens += row.output_tokens ?? 0;
				cacheCreationTokens += row.cache_creation_tokens ?? 0;
				cacheReadTokens += row.cache_read_tokens ?? 0;
				totalCost += cost.amount;
				addCostToMap(costByCurrency, cost);

				const bdKey = `${row.model ?? 'unknown'}\x00${row.provider_id ?? ''}`;
				const existing = breakdownMap.get(bdKey);
				if (existing == null) {
					breakdownMap.set(bdKey, {
						model: row.model ?? 'unknown',
						providerId: row.provider_id,
						inputTokens: row.input_tokens ?? 0,
						outputTokens: row.output_tokens ?? 0,
						cacheCreationTokens: row.cache_creation_tokens ?? 0,
						cacheReadTokens: row.cache_read_tokens ?? 0,
						cost: cost.amount,
						costByCurrency: { [cost.currency]: cost.amount },
					});
				}
				else {
					existing.inputTokens += row.input_tokens ?? 0;
					existing.outputTokens += row.output_tokens ?? 0;
					existing.cacheCreationTokens += row.cache_creation_tokens ?? 0;
					existing.cacheReadTokens += row.cache_read_tokens ?? 0;
					existing.cost += cost.amount;
					addCostToMap(existing.costByCurrency, cost);
				}
			}

			const modelBreakdowns = Array.from(breakdownMap.values()).map(bd => ({
				modelName: bd.model,
				inputTokens: bd.inputTokens,
				outputTokens: bd.outputTokens,
				cacheCreationTokens: bd.cacheCreationTokens,
				cacheReadTokens: bd.cacheReadTokens,
				cost: bd.cost,
				costByCurrency: bd.costByCurrency,
				providerId: bd.providerId ?? undefined,
			}));

			results.push({
				period,
				...(projectName == null ? {} : { project: projectName }),
				inputTokens,
				outputTokens,
				cacheCreationTokens,
				cacheReadTokens,
				totalCost,
				costByCurrency,
				providerId: uniformProviderId(providerIds),
				modelsUsed: Array.from(modelsUsed),
				modelBreakdowns,
				source: combineSource(sources),
			});
		}

		// Legacy loaders filter by date range post-grouping on the period string;
		// for monthly/weekly the period is YYYY-MM / YYYY-MM-DD which the same
		// filter accepts. Sort desc (legacy default).
		const sorted = results.sort((a, b) => (a.period < b.period ? 1 : a.period > b.period ? -1 : 0));
		const order = options?.order ?? 'desc';
		const ordered = order === 'asc' ? sorted.reverse() : sorted;
		// Date range filter only meaningful for daily (YYYY-MM-DD). For monthly/
		// weekly the legacy path filters on the same period string shape.
		return filterByDateRange(ordered as never, (item: never) => (item as AggregatedPeriod).period, options?.since, options?.until) as AggregatedPeriod[];
	}
	catch (error) {
		logger.warn(`queryByPeriod (${kind}) failed: ${String(error)}`);
		throw error;
	}
	finally {
		conn.closeSync();
	}
}

/** Shape a neutral period into a model-breakdown with branded `ModelName`. */
function toBreakdowns(bds: AggregatedPeriod['modelBreakdowns']): ModelBreakdown[] {
	return bds.map(bd => ({
		modelName: createModelName(bd.modelName),
		inputTokens: bd.inputTokens,
		outputTokens: bd.outputTokens,
		cacheCreationTokens: bd.cacheCreationTokens,
		cacheReadTokens: bd.cacheReadTokens,
		cost: bd.cost,
		costByCurrency: bd.costByCurrency,
		providerId: bd.providerId,
	}));
}

/** Query daily usage. Output shape matches `loadDailyUsageData`. */
export async function queryDailyUsage(options?: QueryOptions): Promise<DailyUsage[]> {
	const periods = await queryByPeriod(options, 'daily');
	return periods.map(p => ({
		date: createDailyDate(p.period),
		inputTokens: p.inputTokens,
		outputTokens: p.outputTokens,
		cacheCreationTokens: p.cacheCreationTokens,
		cacheReadTokens: p.cacheReadTokens,
		totalCost: p.totalCost,
		costByCurrency: p.costByCurrency,
		providerId: p.providerId,
		modelsUsed: p.modelsUsed.map(m => createModelName(m)),
		modelBreakdowns: toBreakdowns(p.modelBreakdowns),
		source: p.source as Source,
		...(p.project == null ? {} : { project: p.project }),
	}));
}

/** Query monthly usage. Output shape matches `loadMonthlyUsageData`. */
export async function queryMonthlyUsage(options?: QueryOptions): Promise<MonthlyUsage[]> {
	const periods = await queryByPeriod(options, 'monthly');
	return periods.map(p => ({
		month: createMonthlyDate(p.period),
		inputTokens: p.inputTokens,
		outputTokens: p.outputTokens,
		cacheCreationTokens: p.cacheCreationTokens,
		cacheReadTokens: p.cacheReadTokens,
		totalCost: p.totalCost,
		costByCurrency: p.costByCurrency,
		providerId: p.providerId,
		modelsUsed: p.modelsUsed.map(m => createModelName(m)),
		modelBreakdowns: toBreakdowns(p.modelBreakdowns),
		source: p.source as Source,
		...(p.project == null ? {} : { project: p.project }),
	}));
}

/** Query weekly usage. Output shape matches `loadWeeklyUsageData`. */
export async function queryWeeklyUsage(options?: QueryOptions): Promise<WeeklyUsage[]> {
	const periods = await queryByPeriod(options, 'weekly');
	return periods.map(p => ({
		week: createWeeklyDate(p.period),
		inputTokens: p.inputTokens,
		outputTokens: p.outputTokens,
		cacheCreationTokens: p.cacheCreationTokens,
		cacheReadTokens: p.cacheReadTokens,
		totalCost: p.totalCost,
		costByCurrency: p.costByCurrency,
		providerId: p.providerId,
		modelsUsed: p.modelsUsed.map(m => createModelName(m)),
		modelBreakdowns: toBreakdowns(p.modelBreakdowns),
		source: p.source as Source,
		...(p.project == null ? {} : { project: p.project }),
	}));
}

// ─── Session query (separate grain: per-session, not per-period) ─────────────

type SessionRow = {
	session_id: string | null;
	project: string;
	model: string | null;
	provider_id: string | null;
	source: string | null;
	version: string | null;
	input_tokens: number;
	output_tokens: number;
	cache_creation_tokens: number;
	cache_read_tokens: number;
	cost_usd: number | null;
	last_activity: string;
};

/**
 * Query session usage from the DuckDB store. Groups by `(session_id, project,
 * model, provider_id, source, version)` in SQL, then aggregates per session in
 * JS (tokens summed, `costByCurrency` merged, per-(model,provider) breakdowns,
 * unique sorted `versions`, max `lastActivity`). Output shape matches
 * `loadSessionData`. `sessionId` comes from the JSONL `sessionId` field (matches
 * the `.jsonl` filename per Claude Code's logging convention).
 */
export async function querySessionUsage(options?: QueryOptions): Promise<SessionUsage[]> {
	const tz = options?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
	const mode: CostMode = options?.mode ?? 'auto';
	const project = options?.project ?? null;
	const provider = options?.provider ?? null;

	const conn = await openDb(options?.dbPath);
	try {
		const profiles = import.meta.vitest != null
			? []
			: await loadProviderProfiles({ ccSwitchDbPath: options?.ccSwitchDbPath });
		const schedule = import.meta.vitest != null
			? options?.providerSchedule
			: (options?.providerSchedule ?? loadProviderSchedule());
		const providerCtx = { profiles, schedule };
		const claudePaths = options?.claudePath != null ? [options.claudePath] : undefined;
		const droidPath = options?.claudePath != null ? '' : undefined;
		await syncIngest(conn, { claudePaths, droidPath, loadOptions: options, providerContext: providerCtx, rebuild: options?.rebuild });

		const rows = await runQuery<SessionRow>(
			conn,
			`SELECT
				session_id,
				project,
				model,
				provider_id,
				source,
				version,
				SUM(input_tokens) AS input_tokens,
				SUM(output_tokens) AS output_tokens,
				SUM(cache_creation_tokens) AS cache_creation_tokens,
				SUM(cache_read_tokens) AS cache_read_tokens,
				SUM(cost_usd) AS cost_usd,
				strftime(MAX(timestamp) AT TIME ZONE $tz, '%Y-%m-%d') AS last_activity
			FROM usage_facts
			WHERE ($project IS NULL OR project = $project)
				AND ($provider IS NULL OR provider_id = $provider)
			GROUP BY 1, 2, 3, 4, 5, 6`,
			{ tz, project, provider },
		);

		if (rows.length === 0) {
			return [];
		}

		const fetcher = mode === 'display' ? null : new CcusagePricingFetcher({ pricingPath: options?.pricingPath });

		const rowCostMap = new Map<SessionRow, Money>();
		await Promise.all(rows.map(async (row) => {
			const synth = {
				timestamp: '2026-01-01T00:00:00.000Z',
				message: {
					model: row.model ?? undefined,
					usage: {
						input_tokens: row.input_tokens,
						output_tokens: row.output_tokens,
						cache_creation_input_tokens: row.cache_creation_tokens,
						cache_read_input_tokens: row.cache_read_tokens,
					},
				},
				costUSD: undefined,
			} as unknown as UsageData;
			// mode=auto must NOT fall back to cc-switch's precomputed cost_usd (USD) —
			// that mixes USD into per-provider billing-currency totals and misleads.
			// Always compute from the provider's pricing currency; fetcher==null means
			// no pricing source at all, so 0 rather than a misleading USD figure.
			const money = fetcher == null
				? { amount: 0, currency: 'USD' } as Money
				: await calculateCostForEntry(synth, mode, fetcher, row.provider_id ?? undefined);
			rowCostMap.set(row, money);
		}));

		const grouped = groupBy(rows, (row: SessionRow): string => `${row.session_id ?? '\x00null'}\x00${row.project}`);

		const results: SessionUsage[] = [];
		for (const [, groupRows] of Object.entries(grouped)) {
			if (groupRows == null || groupRows.length === 0) {
				continue;
			}
			const first = groupRows[0];
			const sessionId = first?.session_id ?? 'unknown';
			const projectPath = first?.project ?? 'unknown';

			const sources = new Set<string>();
			const modelsUsed = new Set<string>();
			const versions = new Set<string>();
			const providerIds: Array<string | null | undefined> = [];
			let inputTokens = 0;
			let outputTokens = 0;
			let cacheCreationTokens = 0;
			let cacheReadTokens = 0;
			let totalCost = 0;
			let lastActivity = '';
			const costByCurrency: Record<string, number> = {};

			const breakdownMap = new Map<string, {
				model: string;
				providerId: string | null;
				inputTokens: number;
				outputTokens: number;
				cacheCreationTokens: number;
				cacheReadTokens: number;
				cost: number;
				costByCurrency: Record<string, number>;
			}>();

			for (const row of groupRows) {
				if (row == null) {
					continue;
				}
				// lastActivity must be tracked BEFORE skipping <synthetic> rows — the
				// placeholder's timestamp is real even though its tokens are zero.
				// Without this, a session whose rows are all <synthetic> leaves
				// lastActivity='' and crashes createActivityDate() below.
				if (row.last_activity != null && row.last_activity > lastActivity) {
					lastActivity = row.last_activity;
				}
				// Skip synthetic model (zero-token placeholder, never billed)
				if (row.model === '<synthetic>') {
					continue;
				}
				const cost = rowCostMap.get(row) ?? ({ amount: 0, currency: 'USD' } as Money);
				if (row.source != null) {
					sources.add(row.source);
				}
				if (row.model != null) {
					modelsUsed.add(row.model);
				}
				if (row.version != null) {
					versions.add(row.version);
				}
				providerIds.push(row.provider_id);
				inputTokens += row.input_tokens ?? 0;
				outputTokens += row.output_tokens ?? 0;
				cacheCreationTokens += row.cache_creation_tokens ?? 0;
				cacheReadTokens += row.cache_read_tokens ?? 0;
				totalCost += cost.amount;
				addCostToMap(costByCurrency, cost);

				const bdKey = `${row.model ?? 'unknown'}\x00${row.provider_id ?? ''}`;
				const existing = breakdownMap.get(bdKey);
				if (existing == null) {
					breakdownMap.set(bdKey, {
						model: row.model ?? 'unknown',
						providerId: row.provider_id,
						inputTokens: row.input_tokens ?? 0,
						outputTokens: row.output_tokens ?? 0,
						cacheCreationTokens: row.cache_creation_tokens ?? 0,
						cacheReadTokens: row.cache_read_tokens ?? 0,
						cost: cost.amount,
						costByCurrency: { [cost.currency]: cost.amount },
					});
				}
				else {
					existing.inputTokens += row.input_tokens ?? 0;
					existing.outputTokens += row.output_tokens ?? 0;
					existing.cacheCreationTokens += row.cache_creation_tokens ?? 0;
					existing.cacheReadTokens += row.cache_read_tokens ?? 0;
					existing.cost += cost.amount;
					addCostToMap(existing.costByCurrency, cost);
				}
			}

			const modelBreakdowns = Array.from(breakdownMap.values()).map(bd => ({
				modelName: createModelName(bd.model),
				inputTokens: bd.inputTokens,
				outputTokens: bd.outputTokens,
				cacheCreationTokens: bd.cacheCreationTokens,
				cacheReadTokens: bd.cacheReadTokens,
				cost: bd.cost,
				costByCurrency: bd.costByCurrency,
				providerId: bd.providerId ?? undefined,
			}));

			results.push({
				sessionId: createSessionId(sessionId),
				projectPath: createProjectPath(projectPath),
				inputTokens,
				outputTokens,
				cacheCreationTokens,
				cacheReadTokens,
				totalCost,
				costByCurrency,
				providerId: uniformProviderId(providerIds),
				lastActivity: createActivityDate(lastActivity),
				versions: Array.from(versions).sort((a, b) => a.localeCompare(b)).map(v => createVersion(v)),
				modelsUsed: Array.from(modelsUsed).map(m => createModelName(m)),
				modelBreakdowns,
				source: combineSource(sources),
			});
		}

		const dateFiltered = filterByDateRange(results, (item: SessionUsage) => item.lastActivity, options?.since, options?.until);
		return sortByDate(dateFiltered, (item: SessionUsage) => item.lastActivity, options?.order);
	}
	catch (error) {
		logger.warn(`querySessionUsage failed: ${String(error)}`);
		throw error;
	}
	finally {
		conn.closeSync();
	}
}

// ─── In-source tests ─────────────────────────────────────────────────────────

if (import.meta.vitest != null) {
	describe('duckdb-query', () => {
		it('queryDailyUsage matches loadDailyUsageData (display mode, tokens + cost)', async () => {
			const fixture = await createFixture({
				projects: {
					'test-project': {
						'session-123.jsonl': [
							JSON.stringify({ timestamp: '2026-01-01T10:00:00.000Z', sessionId: 'session-123', message: { id: 'm1', model: 'glm-5.1', usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 10, cache_read_input_tokens: 5 } }, costUSD: 0.01, requestId: 'r1' }),
							JSON.stringify({ timestamp: '2026-01-01T11:00:00.000Z', sessionId: 'session-123', message: { id: 'm2', model: 'glm-5.1', usage: { input_tokens: 200, output_tokens: 100 } }, costUSD: 0.02 }),
							JSON.stringify({ timestamp: '2026-01-02T10:00:00.000Z', sessionId: 'session-123', message: { id: 'm3', model: 'glm-5.1', usage: { input_tokens: 50, output_tokens: 25 } }, costUSD: 0.005 }),
						].join('\n'),
					},
				},
			});

			const opts = { claudePath: fixture.path, mode: 'display' as const };
			const expected = await loadDailyUsageData(opts);
			const actual = await queryDailyUsage({ ...opts, dbPath: ':memory:' });

			expect(actual).toHaveLength(expected.length);
			const byDate = (arr: DailyUsage[]): Map<string, DailyUsage> => new Map(arr.map(d => [d.date, d]));
			const expMap = byDate(expected);
			const actMap = byDate(actual);
			for (const date of expMap.keys()) {
				const e = expMap.get(date);
				const a = actMap.get(date);
				expect(a).toBeDefined();
				expect(a?.inputTokens).toBe(e?.inputTokens);
				expect(a?.outputTokens).toBe(e?.outputTokens);
				expect(a?.cacheCreationTokens).toBe(e?.cacheCreationTokens);
				expect(a?.cacheReadTokens).toBe(e?.cacheReadTokens);
				expect(a?.totalCost).toBeCloseTo(e?.totalCost ?? 0, 5);
				expect(a?.modelsUsed).toEqual(e?.modelsUsed);
			}
		});

		it('queryDailyUsage returns empty when no data', async () => {
			const fixture = await createFixture({ projects: {} });
			const actual = await queryDailyUsage({ claudePath: fixture.path, mode: 'display', dbPath: ':memory:' });
			expect(actual).toEqual([]);
		});

		it('queryDailyUsage excludes <synthetic> model from modelsUsed and breakdowns', async () => {
			const fixture = await createFixture({
				projects: {
					'test-project': {
						'session-123.jsonl': [
							JSON.stringify({ timestamp: '2026-01-01T10:00:00.000Z', sessionId: 's1', message: { id: 'm1', model: 'glm-5.1', usage: { input_tokens: 100, output_tokens: 50 } }, costUSD: 0.01 }),
							JSON.stringify({ timestamp: '2026-01-01T11:00:00.000Z', sessionId: 's1', message: { id: 'm2', model: '<synthetic>', usage: { input_tokens: 0, output_tokens: 0 } }, costUSD: 0 }),
						].join('\n'),
					},
				},
			});
			const actual = await queryDailyUsage({ claudePath: fixture.path, mode: 'display', dbPath: ':memory:' });
			expect(actual).toHaveLength(1);
			expect(actual[0]?.modelsUsed).toEqual(['glm-5.1']);
			expect(actual[0]?.modelBreakdowns.map(b => b.modelName)).toEqual(['glm-5.1']);
		});

		it('queryMonthlyUsage matches loadMonthlyUsageData (display mode, tokens)', async () => {
			const fixture = await createFixture({
				projects: {
					'test-project': {
						'session-123.jsonl': [
							JSON.stringify({ timestamp: '2026-01-05T10:00:00.000Z', sessionId: 's1', message: { id: 'm1', model: 'glm-5.1', usage: { input_tokens: 100, output_tokens: 50 } }, costUSD: 0.01 }),
							JSON.stringify({ timestamp: '2026-02-10T10:00:00.000Z', sessionId: 's1', message: { id: 'm2', model: 'glm-5.1', usage: { input_tokens: 200, output_tokens: 100 } }, costUSD: 0.02 }),
						].join('\n'),
					},
				},
			});
			const opts = { claudePath: fixture.path, mode: 'display' as const };
			const expected = await loadMonthlyUsageData(opts);
			const actual = await queryMonthlyUsage({ ...opts, dbPath: ':memory:' });
			expect(actual).toHaveLength(expected.length);
			const expMap = new Map(expected.map(d => [d.month, d]));
			const actMap = new Map(actual.map(d => [d.month, d]));
			for (const month of expMap.keys()) {
				expect(actMap.get(month)?.inputTokens).toBe(expMap.get(month)?.inputTokens);
				expect(actMap.get(month)?.outputTokens).toBe(expMap.get(month)?.outputTokens);
			}
		});

		it('queryWeeklyUsage matches loadWeeklyUsageData (display mode, tokens)', async () => {
			const fixture = await createFixture({
				projects: {
					'test-project': {
						'session-123.jsonl': [
							JSON.stringify({ timestamp: '2026-01-02T10:00:00.000Z', sessionId: 's1', message: { id: 'm1', model: 'glm-5.1', usage: { input_tokens: 100, output_tokens: 50 } }, costUSD: 0.01 }),
							JSON.stringify({ timestamp: '2026-01-09T10:00:00.000Z', sessionId: 's1', message: { id: 'm2', model: 'glm-5.1', usage: { input_tokens: 200, output_tokens: 100 } }, costUSD: 0.02 }),
						].join('\n'),
					},
				},
			});
			const opts = { claudePath: fixture.path, mode: 'display' as const };
			const expected = await loadWeeklyUsageData(opts);
			const actual = await queryWeeklyUsage({ ...opts, dbPath: ':memory:' });
			expect(actual).toHaveLength(expected.length);
			// Per-week token totals should match (week boundary may differ by
			// start-of-week convention, so compare overall totals).
			const sum = (arr: WeeklyUsage[]): number => arr.reduce((a, w) => a + w.inputTokens, 0);
			expect(sum(actual)).toBe(sum(expected));
		});

		it('queryDailyUsage --rebuild re-ingests a persistent DB and stays consistent', async () => {
			const fixture = await createFixture({
				projects: {
					p: {
						's.jsonl': [
							JSON.stringify({ timestamp: '2026-01-01T10:00:00.000Z', sessionId: 's1', message: { id: 'm1', model: 'glm-5.1', usage: { input_tokens: 100, output_tokens: 50 } }, costUSD: 0.01 }),
						].join('\n'),
					},
				},
			});
			const dbPath = join(tmpdir(), `bcu-rebuild-${process.pid}.duckdb`);
			rmSync(dbPath, { force: true });
			try {
				const opts = { claudePath: fixture.path, mode: 'display' as const, dbPath };
				// First run: full ingest into the persistent file DB.
				const r1 = await queryDailyUsage(opts);
				expect(r1).toHaveLength(1);
				expect(r1[0]?.inputTokens).toBe(100);
				// Second run with --rebuild: drops all rows + re-ingests.
				const r2 = await queryDailyUsage({ ...opts, rebuild: true });
				expect(r2).toEqual(r1);
				// Verify ingested_files was reset (1 file tracked, not duplicated).
				const conn = await openDb(dbPath);
				const files = await runQuery<{ c: number }>(conn, 'SELECT COUNT(*) AS c FROM ingested_files');
				expect(files[0]?.c).toBe(1);
				const rows = await runQuery<{ c: number }>(conn, 'SELECT COUNT(*) AS c FROM usage_facts');
				expect(rows[0]?.c).toBe(1);
				conn.closeSync();
			}
			finally {
				rmSync(dbPath, { force: true });
			}
		});

		it('querySessionUsage matches loadSessionData (display mode, tokens + versions + lastActivity)', async () => {
			const fixture = await createFixture({
				projects: {
					'proj-a': {
						'sess-1.jsonl': [
							JSON.stringify({ timestamp: '2026-01-01T10:00:00.000Z', sessionId: 'sess-1', version: '1.0.0', message: { id: 'm1', model: 'glm-5.1', usage: { input_tokens: 100, output_tokens: 50 } }, costUSD: 0.01 }),
							JSON.stringify({ timestamp: '2026-01-02T11:00:00.000Z', sessionId: 'sess-1', version: '1.1.0', message: { id: 'm2', model: 'glm-5.1', usage: { input_tokens: 200, output_tokens: 100 } }, costUSD: 0.02 }),
						].join('\n'),
					},
					'proj-b': {
						'sess-2.jsonl': [
							JSON.stringify({ timestamp: '2026-01-03T10:00:00.000Z', sessionId: 'sess-2', version: '1.0.0', message: { id: 'm3', model: 'glm-5.1', usage: { input_tokens: 50, output_tokens: 25 } }, costUSD: 0.005 }),
						].join('\n'),
					},
				},
			});
			const opts = { claudePath: fixture.path, mode: 'display' as const };
			const expected = await loadSessionData(opts);
			const actual = await querySessionUsage({ ...opts, dbPath: ':memory:' });
			expect(actual).toHaveLength(expected.length);
			expect(actual.length).toBeGreaterThan(0); // non-vacuous guard
			const expMap = new Map(expected.map(s => [`${s.sessionId}@${s.projectPath}`, s]));
			const actMap = new Map(actual.map(s => [`${s.sessionId}@${s.projectPath}`, s]));
			for (const key of expMap.keys()) {
				const e = expMap.get(key);
				const a = actMap.get(key);
				expect(a).toBeDefined();
				expect(a?.inputTokens).toBe(e?.inputTokens);
				expect(a?.outputTokens).toBe(e?.outputTokens);
				expect(a?.cacheReadTokens).toBe(e?.cacheReadTokens);
				expect(a?.totalCost).toBeCloseTo(e?.totalCost ?? 0, 5);
				expect(a?.versions).toEqual(e?.versions);
				expect(a?.lastActivity).toBe(e?.lastActivity);
				expect(a?.modelsUsed).toEqual(e?.modelsUsed);
			}
		});
	});
}
