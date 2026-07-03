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
import type { ProviderProfile, TreeBucket, TreeDimension } from './_types.ts';
import type { ModelBreakdown } from './data-loader.ts';
import process from 'node:process';
import { formatMoney } from '@zccusage/terminal/table';
import stringWidth from 'string-width';
import { sumToCurrency } from './_currency-convert.ts';
import { loadPaymentRecords } from './_payments-loader.ts';
import { TreeBuckets, TreeDimensions } from './_types.ts';
import { parseRateArg } from './data-loader.ts';

/**
 * Thousands separator style for token counts in the tree renderer.
 * - `combining`: U+0332 combining low line, overlaid under the preceding
 *   digit (`1̲063̲628`). Renders as "an underline drawn beneath the digits"
 *   in modern terminals. Zero display width, so columns stay compact — but
 *   column-width math must use `string-width`, not `String.length`.
 * - `comma`: ASCII comma (`1,063,628`). The portable fallback for terminals
 *   that misrender combining marks (boxes / offsets). One column wide.
 */
export type TreeSeparator = 'combining' | 'comma';

/**
 * Heuristic: does the current stdout look like a modern terminal that renders
 * combining marks correctly? Used to pick `combining` vs the `comma` fallback.
 *
 * Conservative — defaults to `comma` when in doubt (CI, pipes, dumb terminals,
 * no COLORTERM). A modern interactive terminal with truecolor (iTerm2,
 * Windows Terminal, kitty, wezterm, Alacritty, Ghostty, foot) is detected via
 * `COLORTERM=truecolor` plus a known modern `TERM` fragment. tmux/screen are
 * accepted (they pass through combining marks to the outer terminal).
 *
 * `TREE_SEPARATOR` env var overrides the heuristic (`combining` | `comma`).
 */
export function detectTreeSeparator(stream: { isTTY?: boolean } | NodeJS.WriteStream = process.stdout): TreeSeparator {
	const override = process.env.TREE_SEPARATOR;
	if (override === 'combining') {
		return 'combining';
	}
	if (override === 'comma') {
		return 'comma';
	}
	if (process.env.CI === 'true' || process.env.CI === '1') {
		return 'comma';
	}
	if (stream.isTTY !== true) {
		return 'comma';
	}
	const colorTerm = process.env.COLORTERM ?? '';
	const term = process.env.TERM ?? '';
	if (colorTerm !== 'truecolor' && colorTerm !== '24bit') {
		return 'comma';
	}
	const modern = ['xterm', 'kitty', 'alacritty', 'wezterm', 'ghostty', 'foot', 'tmux', 'screen', 'rio', 'contour'];
	return modern.some(m => term.includes(m)) ? 'combining' : 'comma';
}

/**
 * Flat row fed into the grouper. Commands construct one row per usage entry
 * (daily/weekly/monthly) or per session, setting `time` to the period key
 * (date / week / month / sessionId) and `project` to the project directory.
 */
export type TreeItem = {
	time: string;
	project?: string;
	providerId?: string;
	agent?: string;
	reseller?: string;
	region?: string;
	plan?: string;
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
		// Prefer the breakdown's own profile fields (attached per-fragment in
		// attachProfileFields) so a monthly item spanning multiple providers
		// splits correctly by reseller/region/plan. Fall back to the parent only
		// when the breakdown had no resolvable providerId.
		agent: b.agent ?? parent.agent,
		reseller: b.reseller ?? parent.reseller,
		region: b.region ?? parent.region,
		plan: b.plan ?? parent.plan,
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

/**
 * Platform id → display name map. The `reseller` dimension derives from
 * `profile.platform` (e.g. `bailian`, `volcengine`) which is a terse internal
 * token; users expect the branded reseller name. Input is case-insensitive
 * (matched lowercase), output is the cased display name.
 */
const PLATFORM_DISPLAY_NAMES: Record<string, string> = {
	anthropic: 'Anthropic_claude',
	bailian: 'Aliyun_bailian',
	volcengine: 'Volcengine_ark',
	poe: 'POE',
	zhipu: 'Zhipu',
	moonshot: 'Moonshot',
	minimax: 'MiniMax',
	deepseek: 'DeepSeek',
	openai: 'OpenAI',
	google: 'Google',
};

/**
 * Capitalize only the first character of the string, leaving the rest intact
 * (so `agent plan` → `Agent plan`, `beijing` → `Beijing`, `pay-as-you-go` →
 * `Pay-as-you-go`). Underscores, hyphens, and internal casing are preserved.
 */
function capitalizeFirst(value: string): string {
	return value.length === 0 ? value : value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * Format a dimension value for display: reseller maps through the platform
 * display-name table; region/plan/agent get word-capitalized. `model` and
 * `time` are returned verbatim (model names have their own casing convention).
 */
function formatDimValue(dim: TreeDimension, value: string | undefined | null): string {
	if (value == null || value === '') {
		return '(unknown)';
	}
	if (dim === 'reseller') {
		const mapped = PLATFORM_DISPLAY_NAMES[value.toLowerCase()];
		return mapped ?? capitalizeFirst(value);
	}
	if (dim === 'region' || dim === 'plan' || dim === 'agent') {
		return capitalizeFirst(value);
	}
	return value;
}

function dimKey(row: Row, dim: TreeDimension): string {
	switch (dim) {
		case 'time': return row.time;
		case 'project': return row.project ?? '(no project)';
		case 'provider': return row.providerId ?? 'unknown';
		case 'agent': return formatDimValue('agent', row.agent);
		case 'reseller': return formatDimValue('reseller', row.reseller);
		case 'region': return formatDimValue('region', row.region);
		case 'plan': return formatDimValue('plan', row.plan);
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
	const dim = dims[0];
	if (dim == null) {
		return [makeNode('(all)', depth, [], rows)];
	}
	const rest = dims.slice(1);
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
 *
 * If the dims include any provider-derived dimension (`reseller` / `region` /
 * `plan` / `agent`) or `model`, the items are first exploded into per-model
 * fragments. A single time-bucketed item (e.g. one month) can span multiple
 * providers — without exploding first, the provider-derived dims would all
 * collapse to the item's single uniform `providerId` and lose the per-provider
 * split. After explosion, each fragment carries its own `providerId` /
 * `reseller` / `region` / `plan` (attached by `attachProfileFields`), so every
 * dimension groups correctly.
 */
export function buildTree(items: TreeItem[], dims: TreeDimension[]): TreeNode[] {
	const needsExplode = dims.some(d => d === 'model' || d === 'reseller' || d === 'region' || d === 'plan' || d === 'agent');
	const rows: Row[] = needsExplode
		? items.flatMap(r => (r.modelBreakdowns.length > 0 ? r.modelBreakdowns.map(b => toFragment(r, b)) : [r as Row]))
		: items as Row[];
	return buildLevel(rows, dims, 0);
}

/**
 * Attach `reseller` / `region` / `plan` fields to each item by looking up its
 * `providerId` in the supplied provider profiles. Items whose `providerId` has
 * no matching profile (or no `providerId`) are left untouched — downstream
 * `dimKey` resolves them to `(unknown)`.
 *
 * Mutates and returns the input array (no copy) so callers can chain.
 */
export function attachProfileFields(
	items: TreeItem[],
	profiles: ProviderProfile[],
	planOverrides?: Map<string, string>,
): TreeItem[] {
	if (profiles.length === 0) {
		return items;
	}
	const map = new Map<string, ProviderProfile>();
	for (const p of profiles) {
		map.set(p.id, p);
	}
	// Attach reseller/region/plan/agent to both the item (top-level providerId,
	// used when `provider`/`reseller`/`region`/`plan` dims group at item level)
	// AND each modelBreakdown (per-fragment providerId, used when the `model` dim
	// explodes breakdowns into fragments — a single monthly item can span
	// multiple providers, so the fragment must carry its own profile fields
	// rather than inherit the item's uniform providerId).
	// `plan` prefers a schedule-declared override (planOverrides) when the
	// provider id carries no plan token (e.g. `bailian-aliyun-singapore`).
	const attach = (providerId: string | undefined, target: { reseller?: string; region?: string; plan?: string; agent?: string }): void => {
		if (providerId == null) {
			return;
		}
		const p = map.get(providerId);
		if (p == null) {
			return;
		}
		target.reseller = p.platform;
		target.region = p.region;
		target.plan = planOverrides?.get(providerId) ?? p.planType;
		target.agent = p.appType;
	};
	for (const it of items) {
		attach(it.providerId, it);
		for (const bd of it.modelBreakdowns) {
			attach(bd.providerId, bd);
		}
	}
	return items;
}

/**
 * Parse `--group` into a time-bucket (optional) and a list of tree dimensions.
 *
 * `--group` values are either:
 *  - a **time-bucket**: `daily` | `weekly` | `monthly` | `session` — selects the
 *    data loader and occupies the `time` dimension slot at the position it
 *    appears in the list. At most one bucket is allowed (multiple → throws).
 *  - a **dimension**: `project` | `provider` | `agent` | `reseller` | `region`
 *    | `plan` | `model`.
 *
 * The literal `time` is rejected (the bucket name is the time selector).
 *
 * Empty/undefined → `{ bucket: defaultBucket, dims }` where `dims` is
 * `project,model` for session, otherwise `time,model`.
 *
 * Unknown values are dropped. Duplicates keep their first occurrence.
 * When no bucket is present, `bucket` is `null` (load all records, no time
 * aggregation) and `dims` contains no `time`.
 */
export function parseGroup(
	s: string | undefined,
	defaultBucket: TreeBucket,
): { bucket: TreeBucket | null; dims: TreeDimension[] } {
	if (s == null || s.trim() === '') {
		const dims = defaultBucket === 'session'
			? (['project', 'model'] as TreeDimension[])
			: (['time', 'model'] as TreeDimension[]);
		return { bucket: defaultBucket, dims };
	}
	const validDims = new Set<string>(TreeDimensions);
	const buckets = new Set<string>(TreeBuckets);
	let bucket: TreeBucket | null = null;
	const seenDims = new Set<string>();
	const dims: TreeDimension[] = [];
	for (const raw of s.split(',')) {
		const value = raw.trim().toLowerCase();
		if (value === '') {
			continue;
		}
		if (buckets.has(value)) {
			if (bucket != null && bucket !== value) {
				throw new Error(`--group: multiple time buckets (${bucket}, ${value}) are not allowed; pick one of daily/weekly/monthly/session.`);
			}
			bucket = value as TreeBucket;
			// The bucket occupies the `time` dimension slot at this position.
			if (!seenDims.has('time')) {
				seenDims.add('time');
				dims.push('time');
			}
			continue;
		}
		// Literal `time` is rejected — the bucket name is the time selector.
		if (value === 'time') {
			continue;
		}
		if (validDims.has(value) && !seenDims.has(value)) {
			seenDims.add(value);
			dims.push(value as TreeDimension);
		}
	}
	return { bucket, dims };
}

export type RenderTreeOptions = {
	statsCurrency?: string;
	paymentsPath?: string;
	rate?: string;
	rates?: Record<string, number>;
	locale?: string;
	title: string;
	separator?: TreeSeparator;
	wrap?: boolean;
};

function formatBilling(costByCurrency: Record<string, number>, locale?: string): string {
	const entries = Object.entries(costByCurrency).sort(([a], [b]) => a.localeCompare(b));
	if (entries.length === 0) {
		return formatMoney(0, 'USD', locale);
	}
	return entries.map(([currency, amount]) => formatMoney(amount, currency, locale)).join(' + ');
}

const COMBINING_LOW_LINE = '̲';

/**
 * Format a token count with thousands separators. The separator style is
 * controlled by `opts.separator`:
 * - `combining` (default): U+0332 combining low line overlaid under the
 *   preceding digit (`1̲063̲628`) — reads as an underline beneath the digits,
 *   zero display width. Column math must use `string-width`.
 * - `comma`: ASCII comma (`1,063,628`) — the portable fallback.
 *
 * Values < 1000 are returned bare. Zero is `0`.
 */
function formatTokens(n: number, separator: TreeSeparator): string {
	if (!Number.isFinite(n)) {
		return String(n);
	}
	const sign = n < 0 ? '-' : '';
	const abs = Math.abs(Math.trunc(n));
	const s = String(abs);
	if (s.length <= 3) {
		return `${sign}${s}`;
	}
	const sep = separator === 'combining' ? COMBINING_LOW_LINE : ',';
	// Group from the right in threes. For the combining style, the separator
	// is appended AFTER each group's last digit (it overlays that digit), so
	// join with empty string and append sep to every group except the last.
	const groups: string[] = [];
	for (let i = s.length; i > 0; i -= 3) {
		groups.push(s.slice(Math.max(0, i - 3), i));
	}
	groups.reverse();
	if (separator === 'combining') {
		// Overlay underline under the last digit of each group except the final
		// group (no trailing separator). e.g. ["1","063","628"] → "1̲063̲628".
		return `${sign}${groups.map((g, i) => i < groups.length - 1 ? `${g}${sep}` : g).join('')}`;
	}
	return `${sign}${groups.join(',')}`;
}

/**
 * Pad `s` on the left with spaces to reach `targetWidth` display columns.
 * Uses `string-width` so combining marks (zero-width) are accounted for —
 * `String.prototype.padStart` would over-pad combined strings and break
 * column alignment.
 */
function padLeftToWidth(s: string, targetWidth: number): string {
	const w = stringWidth(s);
	if (w >= targetWidth) {
		return s;
	}
	return ' '.repeat(targetWidth - w) + s;
}

/**
 * Pad `s` on the right with spaces to reach `targetWidth` display columns.
 * Right-pads the label column so the following `in:` header starts at a
 * fixed column across all rows.
 */
function padRightToWidth(s: string, targetWidth: number): string {
	const w = stringWidth(s);
	if (w >= targetWidth) {
		return s;
	}
	return s + ' '.repeat(targetWidth - w);
}

/**
 * A node is "empty" when it carries no tokens and no cost. Such nodes are
 * pruned from the rendered tree (they are noise — e.g. `<synthetic>` rows or
 * dimension combinations with no usage). A non-empty descendant keeps an
 * otherwise-empty ancestor alive (it aggregates real usage).
 */
function isNodeEmpty(node: TreeNode): boolean {
	return node.inputTokens === 0
		&& node.outputTokens === 0
		&& node.cacheCreationTokens === 0
		&& node.cacheReadTokens === 0
		&& Object.values(node.costByCurrency).every(v => v === 0);
}

/**
 * Return a pruned copy of `nodes` where empty leaves are dropped and empty
 * internal nodes are dropped when they have no non-empty descendant. The root
 * list is filtered the same way.
 */
function pruneEmptyNodes(nodes: TreeNode[]): TreeNode[] {
	const out: TreeNode[] = [];
	for (const node of nodes) {
		const children = pruneEmptyNodes(node.children);
		if (children.length === 0 && isNodeEmpty(node)) {
			continue;
		}
		out.push({ ...node, children });
	}
	return out;
}

type CellRow = {
	skeleton: string; // depth-indent + branch (┗┳━ / ┣┳━ / ┗━ / ┣━)
	label: string;
	// Wrap-mode continuation gutter: a vertical trunk (`┃`/space) per ancestor
	// level, aligned under the parent's `┳` so the second data line hangs off
	// the skeleton. Empty for leaf rows that are the last descendant chain.
	contGutter: string;
	isLeaf: boolean;
	in: string;
	out: string;
	cacheCreate: string;
	cacheRead: string;
	billing: string;
	stats: string | null; // null = no stats column on this row
};

function statsForNode(node: TreeNode, opts: RenderTreeOptions, ctx: ConversionContext): string {
	const statsCurrency = opts.statsCurrency as string;
	const { total, unconverted } = sumToCurrency(node.costByCurrency, statsCurrency, ctx);
	return unconverted.length === 0
		? formatMoney(total, statsCurrency, opts.locale)
		: `${formatMoney(total, statsCurrency, opts.locale)} (unconverted: ${unconverted.join(',')})`;
}

/**
 * Build cell rows from the tree using the `┗┳━` skeleton. Each level indents by
 * one space; non-leaf nodes use `┗┳━` (last child) or `┣┳━`, leaf nodes use
 * `┗━ ` (last) or `┣━ ` — leaf branches carry a trailing space separating the
 * label from the `━` connector. `ancestorIsLast` records, per ancestor (excluding self),
 * whether that ancestor was its parent's last child — it drives the wrap-mode
 * continuation gutter's vertical trunk.
 */
function collectRows(node: TreeNode, depth: number, isLast: boolean, ancestorIsLast: boolean[], rows: CellRow[], opts: RenderTreeOptions, ctx: ConversionContext | null, statsEnabled: boolean): void {
	const isLeaf = node.children.length === 0;
	// Leaf branches carry a trailing space so the label is visually separated
	// from the `━` connector (e.g. `┗━ m1` instead of `┗━m1`). Non-leaf branches
	// keep `┗┳━`/`┣┳━` (no trailing space — the `┳` already separates).
	const branch = isLeaf
		? (isLast ? '┗━ ' : '┣━ ')
		: (isLast ? '┗┳━' : '┣┳━');
	// Ancestor trunk prefix: align each ancestor's `┃` under that ancestor's
	// BRANCH connector (column `ancestorDepth`) — the same column the ancestor's
	// `┣`/`┗` occupies in its own row. This is standard box-drawing: a non-last
	// ancestor's trunk continues straight down through its descendants at the
	// ancestor's branch column, in line with its `┣`. (The immediate parent at
	// column `depth - 1` is included — it does NOT collide with this node's own
	// branch at column `depth`.) col 0 = root ancestor's branch column.
	let prefix = '';
	for (let j = 0; j < depth; j++) {
		prefix += ancestorIsLast[j] === false ? '┃' : ' ';
	}
	const skeleton = `${prefix}${branch}`;
	// Wrap continuation gutter: vertical trunks `┃` at each non-last ancestor's
	// branch column (`i`) plus this node's own trunk. Self trunk sits under the
	// node's child-connector `┳` (column `depth + 1`) for non-leaf nodes (the
	// descent to children), or under the node's own branch column (`depth`) for
	// a non-last leaf (the link to its next sibling). A last leaf draws no self
	// trunk (skeleton terminates).
	const trunkCols = new Set<number>();
	for (let i = 0; i < ancestorIsLast.length; i++) {
		if (ancestorIsLast[i] === false) {
			trunkCols.add(i);
		}
	}
	// Node's own branch column (`depth`): the trunk continues down to younger
	// siblings when this node is NOT the last child. A last child's branch (`┗`)
	// terminates, so no trunk. This applies to both leaf and non-leaf nodes.
	if (!isLast) {
		trunkCols.add(depth);
	}
	// Non-leaf descent (`depth + 1`): the trunk descends from this node's `┳`
	// down to its children. Leaves have no `┳`, so no descent trunk.
	if (!isLeaf) {
		trunkCols.add(depth + 1);
	}
	const maxCol = Math.max(depth + (isLeaf ? 0 : 1), depth - 1);
	let contGutter = '';
	for (let c = 0; c <= maxCol; c++) {
		contGutter += trunkCols.has(c) ? '┃' : ' ';
	}
	const sep = opts.separator ?? 'combining';
	rows.push({
		skeleton,
		label: node.label,
		contGutter,
		isLeaf,
		in: formatTokens(node.inputTokens, sep),
		out: formatTokens(node.outputTokens, sep),
		cacheCreate: formatTokens(node.cacheCreationTokens, sep),
		cacheRead: formatTokens(node.cacheReadTokens, sep),
		billing: formatBilling(node.costByCurrency, opts.locale),
		stats: statsEnabled && ctx != null ? statsForNode(node, opts, ctx) : null,
	});
	for (let i = 0; i < node.children.length; i++) {
		const child = node.children[i];
		if (child == null) {
			break;
		}
		collectRows(child, depth + 1, i === node.children.length - 1, [...ancestorIsLast, isLast], rows, opts, ctx, statsEnabled);
	}
}

/**
 * Render the collected cell rows with right-aligned numeric columns. The label
 * (left of `in:`) keeps its tree indentation; each numeric column is padded to
 * the max width across all rows so digits line up. `billing` / `stats` are
 * right-aligned too (they are currency strings). Column headers are omitted —
 * the `in:` / `out:` / `cache_create:` / `cache_read:` / `billing:` / `stats:`
 * prefixes are the labels.
 */
function renderRows(rows: CellRow[], wrap: boolean): string[] {
	// Display-width (string-width) max per column — NOT String.length, so that
	// combining-mark separators (zero display width) don't inflate the column
	// and break alignment.
	const w = (sel: (r: CellRow) => string): number => rows.reduce((m, r) => Math.max(m, stringWidth(sel(r))), 0);
	// The label column is `skeleton + label` as a whole — padded so the `in:`
	// header starts at the same column on every row, regardless of tree depth
	// or label length. This makes `in:`/`out:`/`cache_create:`/`cache_read:`/
	// `billing:` line up vertically, with each numeric field right-aligned
	// (units digit in a fixed column).
	const wLabel = w(r => `${r.skeleton}${r.label}`);
	const wIn = w(r => r.in);
	const wOut = w(r => r.out);
	const wCc = w(r => r.cacheCreate);
	const wCr = w(r => r.cacheRead);
	const wBilling = w(r => r.billing);
	const wStats = rows.some(r => r.stats != null) ? w(r => r.stats ?? '') : 0;
	// Wrap continuation: gutter (vertical trunk aligned under parent `┳`) then
	// data padded out to the label column so `cache_create:` lines up under
	// `in:`. The gutter's display width is `2 * (depth + 1)`; pad it to wLabel.
	const lines: string[] = [];
	for (const r of rows) {
		const pad = (s: string, width: number): string => padLeftToWidth(s, width);
		const labelField = padRightToWidth(`${r.skeleton}${r.label}`, wLabel);
		if (wrap) {
			// Line 1: label + in + out + billing [+ stats].
			// Line 2 (continuation): gutter + cache_create + cache_read.
			let line1 = `${labelField}  in:${pad(r.in, wIn)} out:${pad(r.out, wOut)}  billing: ${pad(r.billing, wBilling)}`;
			if (wStats > 0) {
				const stats = r.stats ?? '';
				line1 += `  stats:${stats.length > 0 ? ` ${pad(stats, wStats)}` : ''}`;
			}
			lines.push(line1);
			const gutterField = padRightToWidth(r.contGutter, wLabel);
			lines.push(`${gutterField}  cache_create:${pad(r.cacheCreate, wCc)} cache_read:${pad(r.cacheRead, wCr)}`);
		}
		else {
			let line = `${labelField}  in:${pad(r.in, wIn)} out:${pad(r.out, wOut)} cache_create:${pad(r.cacheCreate, wCc)} cache_read:${pad(r.cacheRead, wCr)}  billing: ${pad(r.billing, wBilling)}`;
			if (wStats > 0) {
				const stats = r.stats ?? '';
				line += `  stats:${stats.length > 0 ? ` ${pad(stats, wStats)}` : ''}`;
			}
			lines.push(line);
		}
	}
	return lines;
}

/**
 * Render a tree of nodes to a string. Shows a title header, the nested
 * nodes, and a final root aggregate line. Empty subtrees (all-zero tokens and
 * cost, no non-empty descendant) are pruned for readability. Numeric columns
 * are right-aligned across all rows.
 */
export function renderTree(nodes: TreeNode[], opts: RenderTreeOptions): string {
	const statsCurrency = opts.statsCurrency;
	const statsEnabled = statsCurrency != null && statsCurrency !== '';
	const separator = opts.separator ?? 'combining';
	const wrap = opts.wrap === true;
	const ctx: ConversionContext | null = statsEnabled
		? {
				paymentRecords: loadPaymentRecords(opts.paymentsPath),
				configRates: opts.rates ?? parseRateArg(opts.rate),
			}
		: null;
	const pruned = pruneEmptyNodes(nodes);
	const rows: CellRow[] = [];
	for (let i = 0; i < pruned.length; i++) {
		const node = pruned[i];
		if (node == null) {
			break;
		}
		collectRows(node, 0, i === pruned.length - 1, [], rows, opts, ctx, statsEnabled);
	}
	const lines: string[] = [];
	lines.push(`Claude Code Token Usage Report - ${opts.title} (Tree)`);
	lines.push('');
	lines.push(...renderRows(rows, wrap));
	// Root aggregate line (computed from pruned nodes so totals match what is shown).
	const rootAgg = aggregateNodeTotals(pruned);
	const rootIn = formatTokens(rootAgg.inputTokens, separator);
	const rootOut = formatTokens(rootAgg.outputTokens, separator);
	const rootCc = formatTokens(rootAgg.cacheCreationTokens, separator);
	const rootCr = formatTokens(rootAgg.cacheReadTokens, separator);
	const rootBilling = formatBilling(rootAgg.costByCurrency, opts.locale);
	// Align root totals with the same column display widths as the body rows.
	const w = (sel: (r: CellRow) => string): number => rows.reduce((m, r) => Math.max(m, stringWidth(sel(r))), 0);
	const pad = (s: string, width: number): string => padLeftToWidth(s, width);
	const wLabel = w(r => `${r.skeleton}${r.label}`);
	const totalLabel = padRightToWidth('Total', wLabel);
	const totalCont = ' '.repeat(wLabel);
	let totalLine: string;
	let totalLine2: string | null = null;
	if (wrap) {
		totalLine = `${totalLabel}  in:${pad(rootIn, w(r => r.in))} out:${pad(rootOut, w(r => r.out))}  billing: ${pad(rootBilling, w(r => r.billing))}`;
		if (statsEnabled && ctx != null) {
			const rootStats = formatMoney(sumToCurrency(rootAgg.costByCurrency, opts.statsCurrency as string, ctx).total, opts.statsCurrency as string, opts.locale);
			const wStats = w(r => r.stats ?? '');
			totalLine += `  stats: ${pad(rootStats, wStats)}`;
		}
		totalLine2 = `${totalCont}  cache_create:${pad(rootCc, w(r => r.cacheCreate))} cache_read:${pad(rootCr, w(r => r.cacheRead))}`;
	}
	else {
		totalLine = `${totalLabel}  in:${pad(rootIn, w(r => r.in))} out:${pad(rootOut, w(r => r.out))} cache_create:${pad(rootCc, w(r => r.cacheCreate))} cache_read:${pad(rootCr, w(r => r.cacheRead))}  billing: ${pad(rootBilling, w(r => r.billing))}`;
		if (statsEnabled && ctx != null) {
			const rootStats = formatMoney(sumToCurrency(rootAgg.costByCurrency, opts.statsCurrency as string, ctx).total, opts.statsCurrency as string, opts.locale);
			const wStats = w(r => r.stats ?? '');
			totalLine += `  stats: ${pad(rootStats, wStats)}`;
		}
	}
	lines.push('');
	lines.push(totalLine);
	if (totalLine2 != null) {
		lines.push(totalLine2);
	}
	return lines.join('\n');
}

/**
 * Render a tree of nodes as a borderless aligned-column table: the tree
 * skeleton + label on the left, numeric columns on the right, with a header
 * row. Numeric columns are right-aligned across all rows; the label column is
 * padded so the `in` header and every body row's `in` value start at the same
 * column. The `--wrap` option is ignored (the columns are already compact).
 *
 * Differs from `renderTree` in that the column headers are a row above the
 * body (not inline `in:`/`out:` prefixes), and no `:` separators are emitted.
 */
export function renderTreeTable(nodes: TreeNode[], opts: RenderTreeOptions): string {
	const statsCurrency = opts.statsCurrency;
	const statsEnabled = statsCurrency != null && statsCurrency !== '';
	const separator = opts.separator ?? 'combining';
	const ctx: ConversionContext | null = statsEnabled
		? {
				paymentRecords: loadPaymentRecords(opts.paymentsPath),
				configRates: opts.rates ?? parseRateArg(opts.rate),
			}
		: null;
	const pruned = pruneEmptyNodes(nodes);
	const rows: CellRow[] = [];
	for (let i = 0; i < pruned.length; i++) {
		const node = pruned[i];
		if (node == null) {
			break;
		}
		collectRows(node, 0, i === pruned.length - 1, [], rows, opts, ctx, statsEnabled);
	}
	const w = (sel: (r: CellRow) => string): number => rows.reduce((m, r) => Math.max(m, stringWidth(sel(r))), 0);
	const wLabel = w(r => `${r.skeleton}${r.label}`);
	const wIn = w(r => r.in);
	const wOut = w(r => r.out);
	const wCc = w(r => r.cacheCreate);
	const wCr = w(r => r.cacheRead);
	const wBilling = w(r => r.billing);
	const wStats = rows.some(r => r.stats != null) ? w(r => r.stats ?? '') : 0;
	const pad = (s: string, width: number): string => padLeftToWidth(s, width);
	const lines: string[] = [];
	lines.push(`Claude Code Token Usage Report - ${opts.title} (Tree-Table)`);
	lines.push('');
	// Header row: blank label field + right-aligned column names.
	const headerLabel = ' '.repeat(wLabel);
	let header = `${headerLabel}  ${pad('in', wIn)} ${pad('out', wOut)} ${pad('cache_create', wCc)} ${pad('cache_read', wCr)}  ${pad('billing', wBilling)}`;
	if (wStats > 0) {
		header += `  ${pad('stats', wStats)}`;
	}
	lines.push(header);
	// Body rows.
	for (const r of rows) {
		const labelField = padRightToWidth(`${r.skeleton}${r.label}`, wLabel);
		let line = `${labelField}  ${pad(r.in, wIn)} ${pad(r.out, wOut)} ${pad(r.cacheCreate, wCc)} ${pad(r.cacheRead, wCr)}  ${pad(r.billing, wBilling)}`;
		if (wStats > 0) {
			const stats = r.stats ?? '';
			line += `  ${pad(stats, wStats)}`;
		}
		lines.push(line);
	}
	// Root aggregate line.
	const rootAgg = aggregateNodeTotals(pruned);
	const rootIn = formatTokens(rootAgg.inputTokens, separator);
	const rootOut = formatTokens(rootAgg.outputTokens, separator);
	const rootCc = formatTokens(rootAgg.cacheCreationTokens, separator);
	const rootCr = formatTokens(rootAgg.cacheReadTokens, separator);
	const rootBilling = formatBilling(rootAgg.costByCurrency, opts.locale);
	const totalLabel = padRightToWidth('Total', wLabel);
	let totalLine = `${totalLabel}  ${pad(rootIn, wIn)} ${pad(rootOut, wOut)} ${pad(rootCc, wCc)} ${pad(rootCr, wCr)}  ${pad(rootBilling, wBilling)}`;
	if (statsEnabled && ctx != null) {
		const rootStats = formatMoney(sumToCurrency(rootAgg.costByCurrency, opts.statsCurrency as string, ctx).total, opts.statsCurrency as string, opts.locale);
		const wStats2 = w(r => r.stats ?? '');
		totalLine += `  ${pad(rootStats, wStats2)}`;
	}
	lines.push('');
	lines.push(totalLine);
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

	describe('detectTreeSeparator', () => {
		const origEnv = { ...process.env };
		afterEach(() => {
			process.env = { ...origEnv };
		});

		it('returns comma when TREE_SEPARATOR=comma override is set', () => {
			process.env.TREE_SEPARATOR = 'comma';
			expect(detectTreeSeparator({ isTTY: true })).toBe('comma');
		});

		it('returns combining when TREE_SEPARATOR=combining override is set', () => {
			process.env.TREE_SEPARATOR = 'combining';
			expect(detectTreeSeparator({ isTTY: false })).toBe('combining');
		});

		it('returns comma in CI environment', () => {
			delete process.env.TREE_SEPARATOR;
			process.env.CI = 'true';
			process.env.COLORTERM = 'truecolor';
			process.env.TERM = 'xterm-256color';
			expect(detectTreeSeparator({ isTTY: true })).toBe('comma');
		});

		it('returns comma when stdout is not a TTY', () => {
			delete process.env.TREE_SEPARATOR;
			delete process.env.CI;
			process.env.COLORTERM = 'truecolor';
			process.env.TERM = 'xterm-256color';
			expect(detectTreeSeparator({ isTTY: false })).toBe('comma');
		});

		it('returns combining for a modern TTY with truecolor', () => {
			delete process.env.TREE_SEPARATOR;
			delete process.env.CI;
			process.env.COLORTERM = 'truecolor';
			process.env.TERM = 'xterm-256color';
			expect(detectTreeSeparator({ isTTY: true })).toBe('combining');
		});

		it('returns comma when COLORTERM is absent even on a TTY', () => {
			delete process.env.TREE_SEPARATOR;
			delete process.env.CI;
			delete process.env.COLORTERM;
			process.env.TERM = 'xterm-256color';
			expect(detectTreeSeparator({ isTTY: true })).toBe('comma');
		});
	});

	describe('parseGroup', () => {
		it('default for daily', () => {
			expect(parseGroup(undefined, 'daily')).toEqual({ bucket: 'daily', dims: ['time', 'model'] });
		});
		it('default for session', () => {
			expect(parseGroup(undefined, 'session')).toEqual({ bucket: 'session', dims: ['project', 'model'] });
		});
		it('translates a bucket to the time dim at its position', () => {
			expect(parseGroup('provider,daily,project,model', 'daily')).toEqual({ bucket: 'daily', dims: ['provider', 'time', 'project', 'model'] });
		});
		it('drops unknown dims and keeps order', () => {
			expect(parseGroup('daily,bogus,provider', 'daily')).toEqual({ bucket: 'daily', dims: ['time', 'provider'] });
		});
		it('dedups a repeated bucket', () => {
			expect(parseGroup('daily,daily,model', 'daily')).toEqual({ bucket: 'daily', dims: ['time', 'model'] });
		});
		it('rejects literal "time" in favor of a bucket', () => {
			expect(parseGroup('time,model', 'daily')).toEqual({ bucket: null, dims: ['model'] });
		});
		it('accepts each bucket name as the time keyword', () => {
			expect(parseGroup('weekly,model', 'weekly')).toEqual({ bucket: 'weekly', dims: ['time', 'model'] });
			expect(parseGroup('monthly,provider', 'monthly')).toEqual({ bucket: 'monthly', dims: ['time', 'provider'] });
			expect(parseGroup('session,project,model', 'session')).toEqual({ bucket: 'session', dims: ['time', 'project', 'model'] });
		});
		it('empty string falls back to default', () => {
			expect(parseGroup('  ', 'weekly')).toEqual({ bucket: 'weekly', dims: ['time', 'model'] });
		});
		it('no bucket → null bucket, no time dim', () => {
			expect(parseGroup('agent,model', 'daily')).toEqual({ bucket: null, dims: ['agent', 'model'] });
		});
		it('multiple different buckets throw', () => {
			expect(() => parseGroup('daily,weekly', 'daily')).toThrow();
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
			const timeNode = nodes[0]!;
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
			const timeNode = nodes[0]!;
			expect(timeNode.children.map(c => c.label).sort()).toEqual(['proj-a', 'proj-b']);
			const projA = timeNode.children.find(c => c.label === 'proj-a');
			expect(projA?.children).toHaveLength(1);
			expect(projA?.children[0]?.label).toBe('m1');
			expect(projA?.children[0]?.inputTokens).toBe(10);
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

		it('attachProfileFields fills reseller/region/plan from profiles', () => {
			const items = [
				mkItem({ providerId: 'bailian-sg' }),
				mkItem({ providerId: 'claude-official' }),
				mkItem({}),
			];
			const profiles = [
				{ id: 'bailian-sg', name: 'Bailian SG', appType: 'claude', platform: 'bailian', region: 'singapore', planType: 'coding plan' } as never,
				{ id: 'claude-official', name: 'Official', appType: 'codex', platform: 'anthropic', region: 'us', planType: 'pay-as-you-go' } as never,
			];
			attachProfileFields(items, profiles);
			expect(items[0]?.reseller).toBe('bailian');
			expect(items[0]?.region).toBe('singapore');
			expect(items[0]?.plan).toBe('coding plan');
			expect(items[0]?.agent).toBe('claude');
			expect(items[1]?.reseller).toBe('anthropic');
			expect(items[1]?.plan).toBe('pay-as-you-go');
			expect(items[1]?.agent).toBe('codex');
			expect(items[2]?.reseller).toBeUndefined();
			expect(items[2]?.agent).toBeUndefined();
		});

		it('attachProfileFields no-op when profiles empty', () => {
			const items = [mkItem({ providerId: 'bailian-sg' })];
			attachProfileFields(items, []);
			expect(items[0]?.reseller).toBeUndefined();
		});

		it('reseller/region/plan dims group by attached fields', () => {
			const items = [
				mkItem({ providerId: 'bailian-sg', reseller: 'bailian', region: 'singapore', plan: 'coding plan' }),
				mkItem({ providerId: 'claude-official', reseller: 'anthropic', region: 'us', plan: 'pay-as-you-go' }),
			];
			const nodes = buildTree(items, ['reseller', 'region', 'plan']);
			// reseller values are formatted via PLATFORM_DISPLAY_NAMES (bailian→Aliyun_bailian,
			// anthropic→Anthropic_claude); region/plan are word-capitalized.
			expect(nodes.map(n => n.label).sort()).toEqual(['Aliyun_bailian', 'Anthropic_claude']);
			const bailian = nodes.find(n => n.label === 'Aliyun_bailian');
			expect(bailian?.children.map(c => c.label)).toEqual(['Singapore']);
			expect(bailian?.children[0]?.children.map(c => c.label)).toEqual(['Coding plan']);
		});

		it('rows without profile resolve to (unknown) for reseller/region/plan', () => {
			const items = [mkItem({})];
			const nodes = buildTree(items, ['reseller', 'region', 'plan']);
			expect(nodes[0]?.label).toBe('(unknown)');
			expect(nodes[0]?.children[0]?.label).toBe('(unknown)');
			expect(nodes[0]?.children[0]?.children[0]?.label).toBe('(unknown)');
		});

		it('agent dim groups by attached appType', () => {
			const items = [
				mkItem({ providerId: 'bailian-sg', agent: 'claude' }),
				mkItem({ providerId: 'codex-bailian', agent: 'codex' }),
				mkItem({}),
			];
			const nodes = buildTree(items, ['agent']);
			// agent values are word-capitalized: claude→Claude, codex→Codex.
			expect(nodes.map(n => n.label).sort()).toEqual(['(unknown)', 'Claude', 'Codex']);
		});

		it('agent dim inherits down to model fragments', () => {
			const items = [
				mkItem({
					providerId: 'bailian-sg',
					agent: 'claude',
					modelBreakdowns: [{ modelName: 'claude-sonnet-4-6' as never, inputTokens: 5, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 0 }],
				}),
			];
			const nodes = buildTree(items, ['agent', 'model']);
			expect(nodes[0]?.label).toBe('Claude');
			expect(nodes[0]?.children[0]?.label).toBe('claude-sonnet-4-6');
		});

		it('multi-currency aggregation merges costByCurrency', () => {
			const items = [
				mkItem({ costByCurrency: { USD: 1, CNY: 7 } }),
				mkItem({ costByCurrency: { USD: 2, CNY: 14 } }),
			];
			const nodes = buildTree(items, ['time']);
			expect(nodes[0]?.costByCurrency).toEqual({ USD: 3, CNY: 21 });
		});

		it('empty items returns empty', () => {
			expect(buildTree([], ['time', 'model'])).toEqual([]);
		});
	});

	describe('renderTreeTable', () => {
		it('renders header row + body + total with aligned columns', () => {
			const items = [
				mkItem({
					time: '2026-01-01',
					modelBreakdowns: [
						{ modelName: 'm1' as never, inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 0.01, costByCurrency: { USD: 0.01 } },
						{ modelName: 'm2' as never, inputTokens: 20, outputTokens: 10, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 0.02, costByCurrency: { USD: 0.02 } },
					],
				}),
			];
			const out = renderTreeTable(buildTree(items, ['time', 'model']), { title: 'Daily' });
			expect(out).toContain('Claude Code Token Usage Report - Daily (Tree-Table)');
			// Header row with column names.
			expect(out).toMatch(/in\s+out\s+cache_create\s+cache_read\s+billing/);
			// Body tree skeleton + labels.
			expect(out).toContain('┗┳━2026-01-01');
			expect(out).toContain('┣━ m1');
			expect(out).toContain('┗━ m2');
			// Total row.
			expect(out).toContain('Total');
			// Token values appear.
			expect(out).toContain('$0.01');
			expect(out).toContain('$0.02');
			expect(out).toContain('$0.03');
		});

		it('omits stats column when statsCurrency unset', () => {
			const items = [mkItem({ modelBreakdowns: [{ modelName: 'm1' as never, inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 0.01, costByCurrency: { USD: 0.01 } }] })];
			const out = renderTreeTable(buildTree(items, ['time', 'model']), { title: 'Daily' });
			expect(out).not.toMatch(/stats/);
		});

		it('shows stats column when statsCurrency set with rate', () => {
			const items = [mkItem({ costByCurrency: { USD: 1 }, modelBreakdowns: [{ modelName: 'm1' as never, inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 1, costByCurrency: { USD: 1 } }] })];
			const out = renderTreeTable(buildTree(items, ['time', 'model']), { title: 'Daily', statsCurrency: 'CNY', rates: { 'USD/CNY': 7.0 } });
			expect(out).toMatch(/stats/);
			expect(out).toContain('¥');
		});

		it('aligns in/out/cache_create/cache_read columns across rows', () => {
			// Use the `model` dim only so labels carry no digits (a `time` label
			// like `2026-01-01` would let the in-field regex match the label's
			// digits instead of the in value).
			const items = [
				mkItem({
					modelBreakdowns: [
						{ modelName: 'x' as never, inputTokens: 5, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 0.01, costByCurrency: { USD: 0.01 } },
						{ modelName: 'a-much-longer-model-name' as never, inputTokens: 1000, outputTokens: 10, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 0.02, costByCurrency: { USD: 0.02 } },
					],
				}),
			];
			const out = renderTreeTable(buildTree(items, ['model']), { title: 'Daily', separator: 'comma' });
			// Right-aligned `in` → every body/total row's `in` value ENDS at the
			// same column (padLeftToWidth pushes the value to the field's right edge).
			const isData = (l: string): boolean => l.startsWith('┗') || l.startsWith('┣') || l.startsWith('Total');
			const dataLines = out.split('\n').filter(isData);
			const inEndCols = dataLines.map((l) => {
				const m = l.match(/(\d[\d,]*)(\s+)(\d[\d,]*)/);
				if (m == null || m.index == null) {
					return -1;
				}
				return m.index + m[1]!.length;
			});
			expect(inEndCols.length).toBeGreaterThan(1);
			expect(inEndCols.every(c => c === inEndCols[0] && c > 0)).toBe(true);
		});

		it('prunes all-zero nodes from the rendered table', () => {
			const items = [
				mkItem({
					time: '2026-01-01',
					inputTokens: 5,
					outputTokens: 5,
					costByCurrency: { USD: 0.01 },
					modelBreakdowns: [
						{ modelName: 'zero-model' as never, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 0, costByCurrency: { USD: 0 } },
						{ modelName: 'real-model' as never, inputTokens: 5, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 0.01, costByCurrency: { USD: 0.01 } },
					],
				}),
			];
			const out = renderTreeTable(buildTree(items, ['time', 'model']), { title: 'Daily' });
			expect(out).not.toContain('zero-model');
			expect(out).toContain('real-model');
			const totalLine = out.split('\n').find(l => l.startsWith('Total'));
			expect(totalLine).toContain('$0.01');
		});

		it('root Total line sums across multiple top-level nodes', () => {
			const items = [
				mkItem({ time: '2026-01-01', inputTokens: 10, outputTokens: 5, totalTokens: 15, costByCurrency: { USD: 1 }, modelBreakdowns: [{ modelName: 'm1' as never, inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 1, costByCurrency: { USD: 1 } }] }),
				mkItem({ time: '2026-01-02', inputTokens: 20, outputTokens: 10, totalTokens: 30, costByCurrency: { USD: 2 }, modelBreakdowns: [{ modelName: 'm1' as never, inputTokens: 20, outputTokens: 10, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 2, costByCurrency: { USD: 2 } }] }),
			];
			const out = renderTreeTable(buildTree(items, ['time']), { title: 'Daily' });
			const totalLine = out.split('\n').find(l => l.startsWith('Total'));
			expect(totalLine).toMatch(/^Total\s+\d+\s+15/); // 5 + 10
			expect(out).toContain('$3.00'); // 1 + 2
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
			expect(out).toContain('┗┳━2026-01-01');
			expect(out).toContain('┣━ m1');
			expect(out).toContain('┗━ m2');
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

		it('renders cache_create and cache_read per node and in total', () => {
			const items = [
				mkItem({
					time: '2026-01-01',
					inputTokens: 10,
					outputTokens: 5,
					cacheCreationTokens: 7,
					cacheReadTokens: 3,
					modelBreakdowns: [
						{ modelName: 'm1' as never, inputTokens: 10, outputTokens: 5, cacheCreationTokens: 7, cacheReadTokens: 3, cost: 0.01, costByCurrency: { USD: 0.01 } },
					],
				}),
			];
			const out = renderTree(buildTree(items, ['time', 'model']), { title: 'Daily' });
			expect(out).toContain('cache_create:7');
			expect(out).toContain('cache_read:3');
			expect(out).toContain('in:10');
			expect(out).toContain('out:5');
			// Total line aggregates cache tokens too
			const totalLine = out.split('\n').find(l => l.startsWith('Total'));
			expect(totalLine).toContain('cache_create:7');
			expect(totalLine).toContain('cache_read:3');
		});

		it('formats token counts with combining-underline thousands separators by default', () => {
			const items = [
				mkItem({
					time: '2026-01-01',
					inputTokens: 1_063_628_719,
					outputTokens: 4_645_845,
					cacheCreationTokens: 0,
					cacheReadTokens: 0,
					modelBreakdowns: [],
				}),
			];
			const out = renderTree(buildTree(items, ['time']), { title: 'Daily' });
			// Combining low line (U+0332) overlays the preceding digit; display
			// width stays equal to the digit count, so alignment is preserved.
			expect(out).toContain('in:1̲063̲628̲719');
			expect(out).toContain('out:4̲645̲845');
		});

		it('falls back to comma thousands separators when separator is comma', () => {
			const items = [
				mkItem({
					time: '2026-01-01',
					inputTokens: 1_063_628_719,
					outputTokens: 4_645_845,
					cacheCreationTokens: 0,
					cacheReadTokens: 0,
					modelBreakdowns: [],
				}),
			];
			const out = renderTree(buildTree(items, ['time']), { title: 'Daily', separator: 'comma' });
			expect(out).toContain('in:1,063,628,719');
			expect(out).toContain('out:4,645,845');
		});

		it('keeps alignment with combining separators (string-width, not length)', () => {
			// Mixed magnitudes: 5 (1 col) vs 1_063_628_719 (10 cols display).
			// Combining marks are zero-width, so the `in:` column pads to 10 and
			// every row's in-field has the same display width (verified by
			// stripping combining marks and comparing remaining digit/Space widths).
			const items = [
				mkItem({
					time: '2026-01-01',
					inputTokens: 5,
					outputTokens: 5,
					modelBreakdowns: [
						{ modelName: 'big' as never, inputTokens: 1_063_628_719, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 0.01, costByCurrency: { USD: 0.01 } },
						{ modelName: 'small' as never, inputTokens: 5, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 0.01, costByCurrency: { USD: 0.01 } },
					],
				}),
			];
			const out = renderTree(buildTree(items, ['time', 'model']), { title: 'Daily', separator: 'combining' });
			const re = /in:(.*) out:/;
			// Display width = field length with combining marks (U+0332) removed.
			const displayWidths = out.split('\n')
				.filter(l => l.includes('in:'))
				.map(l => (re.exec(l)?.[1] ?? '').replace(/̲/g, '').length);
			expect(displayWidths.length).toBeGreaterThan(0);
			expect(displayWidths.every(w => w === displayWidths[0])).toBe(true);
		});

		it('prunes all-zero nodes from the rendered tree', () => {
			const items = [
				mkItem({
					time: '2026-01-01',
					inputTokens: 5,
					outputTokens: 5,
					cacheCreationTokens: 0,
					cacheReadTokens: 0,
					costByCurrency: { USD: 0.01 },
					modelBreakdowns: [
						{ modelName: 'zero-model' as never, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 0, costByCurrency: { USD: 0 } },
						{ modelName: 'real-model' as never, inputTokens: 5, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 0.01, costByCurrency: { USD: 0.01 } },
					],
				}),
			];
			const out = renderTree(buildTree(items, ['time', 'model']), { title: 'Daily' });
			// zero-model leaf is pruned
			expect(out).not.toContain('zero-model');
			// real-model kept
			expect(out).toContain('real-model');
			// Total reflects only the non-pruned row
			const totalLine = out.split('\n').find(l => l.startsWith('Total'));
			expect(totalLine).toContain('in:5');
		});

		it('prunes an entirely empty top-level group', () => {
			const items = [
				mkItem({ time: '2026-01-01', inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, costByCurrency: { USD: 0 }, modelBreakdowns: [] }),
				mkItem({ time: '2026-01-02', inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0, costByCurrency: { USD: 0.01 }, modelBreakdowns: [] }),
			];
			const out = renderTree(buildTree(items, ['time']), { title: 'Daily' });
			expect(out).not.toContain('2026-01-01');
			expect(out).toContain('2026-01-02');
		});

		it('aligns in:/out:/cache_create:/cache_read: headers across rows of varying label width', () => {
			// Labels of different lengths + tree depth → without label-column
			// padding the `in:` header would float. Assert every body row's `in:`
			// starts at the same column, and ditto for the Total row.
			const items = [
				mkItem({
					time: '2026-01-01',
					modelBreakdowns: [
						{ modelName: 'x' as never, inputTokens: 5, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 0.01, costByCurrency: { USD: 0.01 } },
						{ modelName: 'a-much-longer-model-name' as never, inputTokens: 1000, outputTokens: 10, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 0.02, costByCurrency: { USD: 0.02 } },
					],
				}),
			];
			const out = renderTree(buildTree(items, ['time', 'model']), { title: 'Daily', separator: 'comma' });
			const lines = out.split('\n').filter(l => l.includes('in:'));
			const inCols = lines.map(l => l.indexOf('in:'));
			const outCols = lines.map(l => l.indexOf('out:'));
			const ccCols = lines.map(l => l.indexOf('cache_create:'));
			const crCols = lines.map(l => l.indexOf('cache_read:'));
			expect(inCols.length).toBeGreaterThan(1);
			expect(inCols.every(c => c === inCols[0])).toBe(true);
			expect(outCols.every(c => c === outCols[0])).toBe(true);
			expect(ccCols.every(c => c === ccCols[0])).toBe(true);
			expect(crCols.every(c => c === crCols[0])).toBe(true);
		});

		it('wrap option splits each row after out onto a second line', () => {
			const items = [
				mkItem({
					time: '2026-01-01',
					inputTokens: 10,
					outputTokens: 5,
					cacheCreationTokens: 7,
					cacheReadTokens: 3,
					modelBreakdowns: [
						{ modelName: 'm1' as never, inputTokens: 10, outputTokens: 5, cacheCreationTokens: 7, cacheReadTokens: 3, cost: 0.01, costByCurrency: { USD: 0.01 } },
					],
				}),
			];
			const out = renderTree(buildTree(items, ['time', 'model']), { title: 'Daily', wrap: true });
			const lines = out.split('\n');
			// Line 1: label + in + out + billing (no cache_create).
			const bodyFirst = lines.find(l => l.includes('m1'));
			expect(bodyFirst).toBeDefined();
			expect(bodyFirst).toContain('in:');
			expect(bodyFirst).toContain('out:');
			expect(bodyFirst).toContain('billing:');
			expect(bodyFirst).not.toContain('cache_create:');
			// Line 2 (continuation): cache_create + cache_read (no billing).
			const cont = lines.find(l => l.startsWith(' ') && l.includes('cache_create:'));
			expect(cont).toBeDefined();
			expect(cont).toContain('cache_read:');
			expect(cont).not.toContain('billing:');
			// Non-leaf node (time) draws a vertical trunk `┃` in its continuation gutter.
			const timeCont = lines.find(l => l.includes('┃') && l.includes('cache_create:'));
			expect(timeCont).toBeDefined();
			// Leaf node (m1) terminates the skeleton: its continuation has no `┃`.
			const m1Idx = lines.findIndex(l => l.includes('m1') && l.includes('in:'));
			expect(m1Idx).toBeGreaterThan(-1);
			expect(lines[m1Idx + 1]).toContain('cache_create:');
			expect(lines[m1Idx + 1]).not.toContain('┃');
		});

		it('wrap: non-last leaf draws ┃, last leaf does not', () => {
			const items = [
				mkItem({
					time: '2026-01-01',
					modelBreakdowns: [
						{ modelName: 'first' as never, inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 0.01, costByCurrency: { USD: 0.01 } },
						{ modelName: 'last' as never, inputTokens: 2, outputTokens: 2, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 0.02, costByCurrency: { USD: 0.02 } },
					],
				}),
			];
			const out = renderTree(buildTree(items, ['time', 'model']), { title: 'Daily', wrap: true });
			const lines = out.split('\n');
			const firstIdx = lines.findIndex(l => l.includes('first') && l.includes('in:'));
			const lastIdx = lines.findIndex(l => l.includes('last') && l.includes('in:'));
			// Non-last leaf: continuation carries ┃ (skeleton continues to `last`).
			expect(lines[firstIdx + 1]).toContain('┃');
			// Last leaf: continuation has no ┃ (skeleton terminates).
			expect(lines[lastIdx + 1]).not.toContain('┃');
		});

		it('right-aligns numeric columns across rows', () => {
			const items = [
				mkItem({
					time: '2026-01-01',
					inputTokens: 1005,
					outputTokens: 15,
					modelBreakdowns: [
						{ modelName: 'aaa' as never, inputTokens: 5, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 0.01, costByCurrency: { USD: 0.01 } },
						{ modelName: 'bbb' as never, inputTokens: 1000, outputTokens: 10, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 0.02, costByCurrency: { USD: 0.02 } },
					],
				}),
			];
			const out = renderTree(buildTree(items, ['time', 'model']), { title: 'Daily', separator: 'comma' });
			// The `in:` column is right-padded to the max display width across rows,
			// so the numeric token between `in:` and `out:` has identical display
			// width on every row (label width varies, so absolute `out:` position
			// floats — we assert the in-column width is uniform instead). Uses the
			// comma separator so display width == string length here.
			const re = /in:(.*) out:/;
			const inTokens = out.split('\n')
				.filter(l => l.includes('in:'))
				.map(l => re.exec(l)?.[1] ?? '');
			expect(inTokens.length).toBeGreaterThan(0);
			expect(inTokens.every(t => t.length === inTokens[0]?.length)).toBe(true);
			// max in value 1005 → "1,005" (5 chars with comma separator) → every in
			// field is padded to 5
			expect(inTokens[0]?.length).toBe(5);
		});
	});

	// ─── Integration / end-to-end: buildTree → renderTree full pipeline ──────
	describe('integration: buildTree → renderTree', () => {
		it('4-level nesting (time,project,provider,model) aggregates up the tree', () => {
			const items = [
				mkItem({
					time: '2026-01-01',
					project: 'proj-a',
					providerId: 'bailian',
					inputTokens: 30,
					outputTokens: 15,
					totalTokens: 45,
					costByCurrency: { CNY: 85 },
					modelBreakdowns: [
						{ modelName: 'glm-5.1' as never, inputTokens: 20, outputTokens: 10, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 60, costByCurrency: { CNY: 60 } },
						{ modelName: 'glm-5.2' as never, inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 25, costByCurrency: { CNY: 25 } },
					],
				}),
				mkItem({
					time: '2026-01-01',
					project: 'proj-a',
					providerId: 'claude-official',
					inputTokens: 100,
					outputTokens: 50,
					totalTokens: 150,
					costByCurrency: { USD: 1 },
					modelBreakdowns: [
						{ modelName: 'claude-sonnet-4-5' as never, inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 1, costByCurrency: { USD: 1 } },
					],
				}),
			];
			const nodes = buildTree(items, ['time', 'project', 'provider', 'model']);
			expect(nodes).toHaveLength(1);
			const timeNode = nodes[0]!;
			expect(timeNode.label).toBe('2026-01-01');
			expect(timeNode.inputTokens).toBe(130); // 30 + 100
			expect(timeNode.costByCurrency).toEqual({ CNY: 85, USD: 1 });
			const projA = timeNode.children.find(c => c.label === 'proj-a');
			expect(projA?.inputTokens).toBe(130);
			expect(projA?.children.map(c => c.label).sort()).toEqual(['bailian', 'claude-official']);
			const bailian = projA?.children.find(c => c.label === 'bailian');
			expect(bailian?.inputTokens).toBe(30);
			expect(bailian?.costByCurrency).toEqual({ CNY: 85 });
			expect(bailian?.children.map(c => c.label).sort()).toEqual(['glm-5.1', 'glm-5.2']);
			const glm51 = bailian?.children.find(c => c.label === 'glm-5.1');
			expect(glm51?.isLeaf).toBe(true);
			expect(glm51?.inputTokens).toBe(20);
			expect(glm51?.costByCurrency).toEqual({ CNY: 60 });
		});

		it('rendered 4-level tree shows nested box chars + per-node billing', () => {
			const items = [
				mkItem({
					time: '2026-01-01',
					project: 'proj-a',
					providerId: 'bailian',
					costByCurrency: { CNY: 85 },
					totalCost: 85,
					modelBreakdowns: [{ modelName: 'glm-5.1' as never, inputTokens: 20, outputTokens: 10, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 85, costByCurrency: { CNY: 85 } }],
				}),
			];
			const out = renderTree(buildTree(items, ['time', 'project', 'provider', 'model']), { title: 'Daily' });
			expect(out).toContain('┗┳━2026-01-01');
			expect(out).toContain('┗┳━proj-a');
			expect(out).toContain('┗┳━bailian');
			expect(out).toContain('┗━ glm-5.1');
			expect(out).toContain('billing:');
			expect(out).toContain('Total');
		});

		it('stats projection math: USD cost × rate 7 → CNY amount rendered', () => {
			const items = [
				mkItem({
					costByCurrency: { USD: 2 },
					totalCost: 2,
					modelBreakdowns: [{ modelName: 'm1' as never, inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 2, costByCurrency: { USD: 2 } }],
				}),
			];
			const out = renderTree(buildTree(items, ['time', 'model']), {
				title: 'Daily',
				statsCurrency: 'CNY',
				rates: { 'USD/CNY': 7.0 },
			});
			expect(out).toContain('stats:');
			expect(out).toContain('14.00'); // USD 2 × 7 = CNY 14.00
		});

		it('multi-currency billing shows each currency on one node', () => {
			const items = [
				mkItem({
					costByCurrency: { USD: 1, CNY: 7 },
					totalCost: 8,
					modelBreakdowns: [{ modelName: 'm1' as never, inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 8, costByCurrency: { USD: 1, CNY: 7 } }],
				}),
			];
			const out = renderTree(buildTree(items, ['time', 'model']), { title: 'Daily' });
			expect(out).toContain('$1.00'); // USD
			expect(out).toContain('7.00'); // CNY
			expect(out).toContain(' / '); // billing join separator
		});

		it('stats with no rate for a currency → unconverted label', () => {
			const items = [
				mkItem({
					costByCurrency: { EUR: 5 },
					totalCost: 5,
					modelBreakdowns: [{ modelName: 'm1' as never, inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 5, costByCurrency: { EUR: 5 } }],
				}),
			];
			const out = renderTree(buildTree(items, ['time', 'model']), {
				title: 'Daily',
				statsCurrency: 'CNY',
				rates: {}, // no EUR/CNY rate
			});
			expect(out).toContain('stats:');
			expect(out).toContain('unconverted: EUR');
		});

		it('parseGroup → buildTree round-trip groups in declared order', () => {
			const items = [
				mkItem({ time: '2026-01-01', project: 'proj-a', providerId: 'p1', modelBreakdowns: [{ modelName: 'm1' as never, inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 0, costByCurrency: {} }] }),
				mkItem({ time: '2026-01-01', project: 'proj-b', providerId: 'p2', modelBreakdowns: [{ modelName: 'm2' as never, inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 0, costByCurrency: {} }] }),
			];
			const { dims } = parseGroup('provider,daily,project,model', 'daily');
			expect(dims).toEqual(['provider', 'time', 'project', 'model']);
			const nodes = buildTree(items, dims);
			expect(nodes.map(n => n.label).sort()).toEqual(['p1', 'p2']);
			const p1 = nodes.find(n => n.label === 'p1');
			expect(p1?.children[0]?.label).toBe('2026-01-01'); // time
			expect(p1?.children[0]?.children[0]?.label).toBe('proj-a'); // project
			expect(p1?.children[0]?.children[0]?.children[0]?.label).toBe('m1'); // model leaf
		});

		it('root Total line sums across multiple top-level nodes', () => {
			const items = [
				mkItem({ time: '2026-01-01', inputTokens: 10, outputTokens: 5, totalTokens: 15, costByCurrency: { USD: 1 }, modelBreakdowns: [{ modelName: 'm1' as never, inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 1, costByCurrency: { USD: 1 } }] }),
				mkItem({ time: '2026-01-02', inputTokens: 20, outputTokens: 10, totalTokens: 30, costByCurrency: { USD: 2 }, modelBreakdowns: [{ modelName: 'm1' as never, inputTokens: 20, outputTokens: 10, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 2, costByCurrency: { USD: 2 } }] }),
			];
			const out = renderTree(buildTree(items, ['time']), { title: 'Daily' });
			// Total label is right-padded to the body label column width, so match
			// with a regex that tolerates the padding spaces.
			const totalLine = out.split('\n').find(l => l.startsWith('Total'));
			expect(totalLine).toMatch(/^Total\s+in:30 out:15/); // 10+20, 5+10
			expect(out).toContain('$3.00'); // 1 + 2
		});
	});
}
