/**
 * @fileoverview Hierarchical tree output for usage reports.
 *
 * A third output format (alongside `table` and `json`). Aggregates usage data
 * into a configurable nesting order (`--tree-group`), then renders it with
 * Unicode box-drawing characters. Each node shows token counts plus a
 * billing value (per-currency) and, when a statistics currency is set, a
 * stats value projected into that currency.
 *
 * The grouper is generic over a flat `TreeItem[]` shape; each command maps
 * its own data (daily/weekly/monthly/session) into that shape before calling
 * `buildTree` + `renderTree`.
 */

import type { ConversionContext } from './_currency-convert.ts';
import type { TreeDimension } from './_types.ts';
import type { ModelBreakdown } from './data-loader.ts';
import { formatMoney } from '@better-ccusage/terminal/table';
import { sumToCurrency } from './_currency-convert.ts';
import { loadPaymentRecords } from './_payments-loader.ts';
import { TreeDimensions } from './_types.ts';
import { parseRateArg } from './data-loader.ts';

/**
 * Flat row fed into the grouper. Commands construct one row per usage entry
 * (daily/weekly/monthly) or per session, setting `time` to the period key
 * (date / week / month / sessionId) and `project` to the project directory.
 */
export type TreeItem = {
	time: string;
	project?: string;
	providerId?: string;
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	totalTokens: number;
	totalCost: number;
	costByCurrency?: Record<string, number>;
	modelBreakdowns: ModelBreakdown[];
};

/**
 * A nested node in the rendered tree. Non-leaf nodes aggregate their
 * children; leaf nodes carry the per-group totals directly.
 */
export type TreeNode = {
	label: string;
	depth: number;
	children: TreeNode[];
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	totalTokens: number;
	costByCurrency: Record<string, number>;
	providerId?: string;
	isLeaf: boolean;
};

type TreeCmdKind = 'daily' | 'weekly' | 'monthly' | 'session';

/**
 * Internal row used during grouping. After a `model` dimension explodes a
 * `TreeItem`'s `modelBreakdowns`, each fragment carries `modelLabel` (the
 * breakdown's model name) and an empty `modelBreakdowns` so it cannot be
 * exploded again. Inherited fields (`time`, `project`) are preserved so that
 * dimensions ordered after `model` can still group on them.
 */
type Row = TreeItem & { modelLabel?: string };

function sumTokens(r: { inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number }): number {
	return r.inputTokens + r.outputTokens + r.cacheCreationTokens + r.cacheReadTokens;
}

/**
 * Build a breakdown fragment that inherits temporal/project context from its
 * parent item but takes token/cost figures from the breakdown itself.
 */
function toFragment(parent: TreeItem, b: ModelBreakdown): Row {
	return {
		time: parent.time,
		project: parent.project,
		providerId: b.providerId ?? parent.providerId,
		inputTokens: b.inputTokens,
		outputTokens: b.outputTokens,
		cacheCreationTokens: b.cacheCreationTokens,
		cacheReadTokens: b.cacheReadTokens,
		totalTokens: sumTokens(b),
		totalCost: b.cost,
		costByCurrency: b.costByCurrency ?? { USD: b.cost },
		modelBreakdowns: [],
		modelLabel: b.modelName,
	};
}

/**
 * Merge a per-row cost-by-currency map into the accumulator. Same semantics
 * as `mergeCostByCurrency` in calculate-cost.ts, duplicated here to avoid
 * exporting a private helper and to keep this module self-contained.
 */
function mergeCostByCurrency(acc: Record<string, number>, row: { totalCost: number; costByCurrency?: Record<string, number> }): Record<string, number> {
	const source = row.costByCurrency ?? { USD: row.totalCost };
	for (const [currency, amount] of Object.entries(source)) {
		acc[currency] = (acc[currency] ?? 0) + amount;
	}
	return acc;
}

function uniformProviderId(rows: Row[]): string | undefined {
	let value: string | undefined;
	for (const r of rows) {
		if (r.providerId == null) {
			return undefined;
		}
		if (value == null) {
			value = r.providerId;
		}
		else if (value !== r.providerId) {
			return undefined;
		}
	}
	return value;
}

function aggregateRows(rows: Row[]): Pick<TreeNode, 'inputTokens' | 'outputTokens' | 'cacheCreationTokens' | 'cacheReadTokens' | 'totalTokens' | 'costByCurrency' | 'providerId'> {
	const costByCurrency: Record<string, number> = {};
	let inputTokens = 0;
	let outputTokens = 0;
	let cacheCreationTokens = 0;
	let cacheReadTokens = 0;
	for (const r of rows) {
		inputTokens += r.inputTokens;
		outputTokens += r.outputTokens;
		cacheCreationTokens += r.cacheCreationTokens;
		cacheReadTokens += r.cacheReadTokens;
		mergeCostByCurrency(costByCurrency, r);
	}
	return {
		inputTokens,
		outputTokens,
		cacheCreationTokens,
		cacheReadTokens,
		totalTokens: inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens,
		costByCurrency,
		providerId: uniformProviderId(rows),
	};
}

function makeNode(label: string, depth: number, children: TreeNode[], rows: Row[]): TreeNode {
	const agg = aggregateRows(rows);
	return { label, depth, children, ...agg, isLeaf: children.length === 0 };
}

/**
 * Aggregate already-built nodes into a root totals object. Each node's
 * `costByCurrency` is already a merged map, so we sum maps per-currency
 * (no `totalCost` fallback needed).
 */
function aggregateNodeTotals(nodes: TreeNode[]): Pick<TreeNode, 'inputTokens' | 'outputTokens' | 'cacheCreationTokens' | 'cacheReadTokens' | 'totalTokens' | 'costByCurrency' | 'providerId'> {
	const costByCurrency: Record<string, number> = {};
	let inputTokens = 0;
	let outputTokens = 0;
	let cacheCreationTokens = 0;
	let cacheReadTokens = 0;
	for (const n of nodes) {
		inputTokens += n.inputTokens;
		outputTokens += n.outputTokens;
		cacheCreationTokens += n.cacheCreationTokens;
		cacheReadTokens += n.cacheReadTokens;
		for (const [currency, amount] of Object.entries(n.costByCurrency)) {
			costByCurrency[currency] = (costByCurrency[currency] ?? 0) + amount;
		}
	}
	return {
		inputTokens,
		outputTokens,
		cacheCreationTokens,
		cacheReadTokens,
		totalTokens: inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens,
		costByCurrency,
		providerId: undefined,
	};
}

function dimKey(row: Row, dim: TreeDimension): string {
	switch (dim) {
		case 'time': return row.time;
		case 'project': return row.project ?? '(no project)';
		case 'provider': return row.providerId ?? 'unknown';
		case 'model': return row.modelLabel ?? '(unknown)';
	}
}

function groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
	const groups = new Map<string, T[]>();
	for (const item of items) {
		const key = keyFn(item);
		const group = groups.get(key);
		if (group != null) {
			group.push(item);
		}
		else {
			groups.set(key, [item]);
		}
	}
	return groups;
}

/**
 * Recursively build tree nodes for `items` under the nesting order `dims`.
 * `dims[0]` is the current level; remaining dims apply to children.
 */
function buildLevel(rows: Row[], dims: TreeDimension[], depth: number): TreeNode[] {
	if (rows.length === 0) {
		return [];
	}
	if (dims.length === 0) {
		// No more nesting dimensions: the current level's nodes (built by the
		// caller) are the leaves. Returning empty means the caller's nodes get
		// `children: []` and thus `isLeaf: true`.
		return [];
	}
	const [dim, ...rest] = dims;
	// `model` explodes breakdowns into fragments before grouping; other dims
	// group items directly.
	const sourceRows: Row[] = dim === 'model'
		? rows.flatMap(r => (r.modelBreakdowns.length > 0 ? r.modelBreakdowns.map(b => toFragment(r, b)) : [{ ...r, modelLabel: r.modelLabel ?? '(unknown)', modelBreakdowns: [] }]))
		: rows;
	const groups = groupBy(sourceRows, r => dimKey(r, dim));
	const nodes: TreeNode[] = [];
	for (const [key, group] of groups) {
		const children = buildLevel(group, rest, depth + 1);
		nodes.push(makeNode(key, depth, children, group));
	}
	return nodes;
}

/**
 * Build a tree from flat usage items.
 */
export function buildTree(items: TreeItem[], dims: TreeDimension[]): TreeNode[] {
	return buildLevel(items as Row[], dims, 0);
}

/**
 * Parse `--tree-group` into validated dimensions.
 *
 * Empty/undefined → default per command kind + `--instances`:
 *  - session: `project,model` (projectPath is the natural parent; `time`
 *    = sessionId can be added explicitly)
 *  - others: `time,model`, or `time,project,model` when `instances` is set.
 *
 * Unknown dimensions are warned and dropped. Duplicates keep their first
 * occurrence. `model` is most useful as the last dimension; when it is not,
 * downstream non-provider dims still work (fragments inherit time/project)
 * but downstream `model` is a no-op (deduped).
 */
export function parseTreeGroup(s: string | undefined, cmdKind: TreeCmdKind, instances: boolean): TreeDimension[] {
	if (s == null || s.trim() === '') {
		if (cmdKind === 'session') {
			return instances ? (['project', 'time', 'model'] as TreeDimension[]) : (['project', 'model'] as TreeDimension[]);
		}
		return instances ? (['time', 'project', 'model'] as TreeDimension[]) : (['time', 'model'] as TreeDimension[]);
	}
	const valid = new Set<string>(TreeDimensions);
	const seen = new Set<string>();
	const out: TreeDimension[] = [];
	for (const raw of s.split(',')) {
		const dim = raw.trim().toLowerCase();
		if (dim === '' || seen.has(dim)) {
			continue;
		}
		if (!valid.has(dim)) {
			continue;
		}
		seen.add(dim);
		out.push(dim as TreeDimension);
	}
	return out;
}

export type RenderTreeOptions = {
	statsCurrency?: string;
	paymentsPath?: string;
	rate?: string;
	rates?: Record<string, number>;
	locale?: string;
	title: string;
};

function formatBilling(costByCurrency: Record<string, number>, locale?: string): string {
	const entries = Object.entries(costByCurrency);
	if (entries.length === 0) {
		return formatMoney(0, 'USD', locale);
	}
	return entries.map(([currency, amount]) => formatMoney(amount, currency, locale)).join(' / ');
}

function walk(node: TreeNode, prefix: string, isLast: boolean, lines: string[], opts: RenderTreeOptions, ctx: ConversionContext | null, statsEnabled: boolean): void {
	const branch = isLast ? '└── ' : '├── ';
	const childPrefix = prefix + (isLast ? '    ' : '│   ');
	const billing = formatBilling(node.costByCurrency, opts.locale);
	let line = `${prefix}${branch}${node.label}  in:${node.inputTokens} out:${node.outputTokens}  billing: ${billing}`;
	if (statsEnabled && ctx != null) {
		const statsCurrency = opts.statsCurrency as string;
		const { total, unconverted } = sumToCurrency(node.costByCurrency, statsCurrency, ctx);
		const statsPart = unconverted.length === 0
			? formatMoney(total, statsCurrency, opts.locale)
			: `${formatMoney(total, statsCurrency, opts.locale)} (unconverted: ${unconverted.join(',')})`;
		line += `  stats: ${statsPart}`;
	}
	lines.push(line);
	for (let i = 0; i < node.children.length; i++) {
		walk(node.children[i], childPrefix, i === node.children.length - 1, lines, opts, ctx, statsEnabled);
	}
}

/**
 * Render a tree of nodes to a string. Shows a title header, the nested
 * nodes, and a final root aggregate line.
 */
export function renderTree(nodes: TreeNode[], opts: RenderTreeOptions): string {
	const statsCurrency = opts.statsCurrency;
	const statsEnabled = statsCurrency != null && statsCurrency !== '';
	const ctx: ConversionContext | null = statsEnabled
		? {
				paymentRecords: loadPaymentRecords(opts.paymentsPath),
				configRates: opts.rates ?? parseRateArg(opts.rate),
			}
		: null;
	const lines: string[] = [];
	lines.push(`Claude Code Token Usage Report - ${opts.title} (Tree)`);
	lines.push('');
	for (let i = 0; i < nodes.length; i++) {
		walk(nodes[i], '', i === nodes.length - 1, lines, opts, ctx, statsEnabled);
	}
	// Root aggregate line
	const rootAgg = aggregateNodeTotals(nodes);
	lines.push('');
	lines.push(`Total  in:${rootAgg.inputTokens} out:${rootAgg.outputTokens}  billing: ${formatBilling(rootAgg.costByCurrency, opts.locale)}${statsEnabled && ctx != null ? `  stats: ${formatMoney(sumToCurrency(rootAgg.costByCurrency, opts.statsCurrency as string, ctx).total, opts.statsCurrency as string, opts.locale)}` : ''}`);
	return lines.join('\n');
}

// ─── In-source tests ─────────────────────────────────────────────────────────

if (import.meta.vitest != null) {
	const mkItem = (over: Partial<TreeItem> = {}): TreeItem => ({
		time: '2026-01-01',
		project: undefined,
		providerId: undefined,
		inputTokens: 10,
		outputTokens: 5,
		cacheCreationTokens: 0,
		cacheReadTokens: 0,
		totalTokens: 15,
		totalCost: 0.01,
		costByCurrency: { USD: 0.01 },
		modelBreakdowns: [],
		...over,
	});

	describe('parseTreeGroup', () => {
		it('default for daily without instances', () => {
			expect(parseTreeGroup(undefined, 'daily', false)).toEqual(['time', 'model']);
		});
		it('default for daily with instances', () => {
			expect(parseTreeGroup(undefined, 'daily', true)).toEqual(['time', 'project', 'model']);
		});
		it('default for session without instances', () => {
			expect(parseTreeGroup(undefined, 'session', false)).toEqual(['project', 'model']);
		});
		it('drops unknown dims and keeps order', () => {
			expect(parseTreeGroup('time,bogus,provider', 'daily', false)).toEqual(['time', 'provider']);
		});
		it('dedups keeping first', () => {
			expect(parseTreeGroup('time,time,model', 'daily', false)).toEqual(['time', 'model']);
		});
		it('empty string falls back to default', () => {
			expect(parseTreeGroup('  ', 'weekly', false)).toEqual(['time', 'model']);
		});
	});

	describe('buildTree', () => {
		it('time,model grouping explodes breakdowns', () => {
			const items = [
				mkItem({
					time: '2026-01-01',
					inputTokens: 30,
					outputTokens: 15,
					totalTokens: 45,
					totalCost: 0.03,
					costByCurrency: { USD: 0.03 },
					modelBreakdowns: [
						{ modelName: 'claude-sonnet-4-5' as never, inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 0.01, costByCurrency: { USD: 0.01 } },
						{ modelName: 'claude-opus-4' as never, inputTokens: 20, outputTokens: 10, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 0.02, costByCurrency: { USD: 0.02 } },
					],
				}),
			];
			const nodes = buildTree(items, ['time', 'model']);
			expect(nodes).toHaveLength(1);
			const timeNode = nodes[0];
			expect(timeNode.label).toBe('2026-01-01');
			expect(timeNode.children).toHaveLength(2);
			expect(timeNode.inputTokens).toBe(30);
			expect(timeNode.costByCurrency).toEqual({ USD: 0.03 });
			const modelLabels = timeNode.children.map(c => c.label).sort();
			expect(modelLabels).toEqual(['claude-opus-4', 'claude-sonnet-4-5']);
			const sonnet = timeNode.children.find(c => c.label === 'claude-sonnet-4-5');
			expect(sonnet?.isLeaf).toBe(true);
			expect(sonnet?.inputTokens).toBe(10);
			expect(sonnet?.costByCurrency).toEqual({ USD: 0.01 });
		});

		it('time,project,model groups by project then model', () => {
			const items = [
				mkItem({
					time: '2026-01-01',
					project: 'proj-a',
					modelBreakdowns: [
						{ modelName: 'm1' as never, inputTokens: 10, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 0.01, costByCurrency: { USD: 0.01 } },
					],
				}),
				mkItem({
					time: '2026-01-01',
					project: 'proj-b',
					modelBreakdowns: [
						{ modelName: 'm1' as never, inputTokens: 5, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 0.005, costByCurrency: { USD: 0.005 } },
					],
				}),
			];
			const nodes = buildTree(items, ['time', 'project', 'model']);
			expect(nodes).toHaveLength(1);
			const timeNode = nodes[0];
			expect(timeNode.children.map(c => c.label).sort()).toEqual(['proj-a', 'proj-b']);
			const projA = timeNode.children.find(c => c.label === 'proj-a');
			expect(projA?.children).toHaveLength(1);
			expect(projA?.children[0].label).toBe('m1');
			expect(projA?.children[0].inputTokens).toBe(10);
		});

		it('provider dim groups by providerId', () => {
			const items = [
				mkItem({ time: '2026-01-01', providerId: 'bailian', costByCurrency: { CNY: 85 }, totalCost: 85, modelBreakdowns: [] }),
				mkItem({ time: '2026-01-01', providerId: 'claude-official', costByCurrency: { USD: 0.5 }, totalCost: 0.5, modelBreakdowns: [] }),
			];
			const nodes = buildTree(items, ['provider']);
			expect(nodes.map(n => n.label).sort()).toEqual(['bailian', 'claude-official']);
			const bailian = nodes.find(n => n.label === 'bailian');
			expect(bailian?.costByCurrency).toEqual({ CNY: 85 });
		});

		it('multi-currency aggregation merges costByCurrency', () => {
			const items = [
				mkItem({ costByCurrency: { USD: 1, CNY: 7 } }),
				mkItem({ costByCurrency: { USD: 2, CNY: 14 } }),
			];
			const nodes = buildTree(items, ['time']);
			expect(nodes[0].costByCurrency).toEqual({ USD: 3, CNY: 21 });
		});

		it('empty items returns empty', () => {
			expect(buildTree([], ['time', 'model'])).toEqual([]);
		});
	});

	describe('renderTree', () => {
		it('renders tree chars and billing', () => {
			const items = [
				mkItem({
					time: '2026-01-01',
					modelBreakdowns: [
						{ modelName: 'm1' as never, inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 0.01, costByCurrency: { USD: 0.01 } },
						{ modelName: 'm2' as never, inputTokens: 20, outputTokens: 10, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 0.02, costByCurrency: { USD: 0.02 } },
					],
				}),
			];
			const out = renderTree(buildTree(items, ['time', 'model']), { title: 'Daily' });
			expect(out).toContain('Claude Code Token Usage Report - Daily (Tree)');
			expect(out).toContain('└── 2026-01-01');
			expect(out).toContain('├── m1');
			expect(out).toContain('└── m2');
			expect(out).toContain('billing:');
			expect(out).toContain('Total');
		});

		it('omits stats column when statsCurrency unset', () => {
			const items = [mkItem({ modelBreakdowns: [{ modelName: 'm1' as never, inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 0.01, costByCurrency: { USD: 0.01 } }] })];
			const out = renderTree(buildTree(items, ['time', 'model']), { title: 'Daily' });
			expect(out).not.toContain('stats:');
		});

		it('shows stats column when statsCurrency set with rate', () => {
			const items = [mkItem({ costByCurrency: { USD: 1 }, modelBreakdowns: [{ modelName: 'm1' as never, inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 1, costByCurrency: { USD: 1 } }] })];
			const out = renderTree(buildTree(items, ['time', 'model']), { title: 'Daily', statsCurrency: 'CNY', rates: { 'USD/CNY': 7.0 } });
			expect(out).toContain('stats:');
			expect(out).toContain('¥');
		});
	});
}
