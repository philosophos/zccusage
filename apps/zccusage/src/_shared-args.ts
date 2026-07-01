import type { Args } from 'gunshi';
import type { CostMode, OutputFormat, SortOrder } from './_types.ts';
import * as v from 'valibot';
import { DEFAULT_LOCALE } from './_consts.ts';
import { CostModes, filterDateSchema, OutputFormats, SortOrders } from './_types.ts';

/**
 * Parses and validates a date argument in YYYYMMDD format
 * @param value - Date string to parse
 * @returns Validated date string
 */
function parseDateArg(value: string): string {
	return v.parse(filterDateSchema, value);
}

/**
 * Shared command line arguments used across multiple CLI commands
 */
export const sharedArgs = {
	since: {
		type: 'custom',
		short: 's',
		description: 'Filter from date (YYYYMMDD format)',
		parse: parseDateArg,
	},
	until: {
		type: 'custom',
		short: 'u',
		description: 'Filter until date (YYYYMMDD format)',
		parse: parseDateArg,
	},
	json: {
		type: 'boolean',
		short: 'j',
		description: 'Output in JSON format (shorthand for --format json)',
		default: false,
	},
	format: {
		type: 'enum',
		short: 'f',
		description: 'Output format: table, json, tree, or tree-table. Shorthands --json (=-f json) and --tree (=-f tree) override the default when --format is unset.',
		default: 'table' as const satisfies OutputFormat,
		choices: OutputFormats,
	},
	tree: {
		type: 'boolean',
		description: 'Output in hierarchical tree view (shorthand for --format tree)',
		default: false,
	},
	group: {
		type: 'string',
		description: 'Group/bucket selector, comma-separated. A time-bucket (daily|weekly|monthly|session) selects the data loader and occupies the time nesting slot at its position; the rest are nesting dims: project,provider,agent,reseller,region,plan,model. Omitting a bucket loads all records with no time aggregation. Default: daily (→ time,model). Example: --group agent,reseller,region,plan,model,weekly',
	},
	treeGroup: {
		type: 'string',
		description: 'Alias for --group (deprecated).',
	},
	wrap: {
		type: 'boolean',
		description: 'Tree view: wrap each row after the `out` column onto a second line (cache_create / cache_read / billing / stats). Reduces horizontal width.',
		default: false,
	},
	treeWrap: {
		type: 'boolean',
		description: 'Alias for --wrap (deprecated).',
		default: false,
	},
	mode: {
		type: 'enum',
		short: 'm',
		description:
			'Cost calculation mode: auto (use costUSD if exists, otherwise calculate), calculate (always calculate), display (always use costUSD)',
		default: 'auto' as const satisfies CostMode,
		choices: CostModes,
	},
	debug: {
		type: 'boolean',
		short: 'd',
		description: 'Show pricing mismatch information for debugging',
		default: false,
	},
	debugSamples: {
		type: 'number',
		description:
			'Number of sample discrepancies to show in debug output (default: 5)',
		default: 5,
	},
	order: {
		type: 'enum',
		short: 'o',
		description: 'Sort order: desc (newest first) or asc (oldest first)',
		default: 'asc' as const satisfies SortOrder,
		choices: SortOrders,
	},
	breakdown: {
		type: 'boolean',
		short: 'b',
		description: 'Show per-model cost breakdown',
		default: false,
	},
	color: { // --color and FORCE_COLOR=1 is handled by picocolors
		type: 'boolean',
		description: 'Enable colored output (default: auto). FORCE_COLOR=1 has the same effect.',
	},
	noColor: { // --no-color and NO_COLOR=1 is handled by picocolors
		type: 'boolean',
		description: 'Disable colored output (default: auto). NO_COLOR=1 has the same effect.',
	},
	timezone: {
		type: 'string',
		short: 'z',
		description: 'Timezone for date grouping (e.g., UTC, America/New_York, Asia/Tokyo). Default: system timezone',
	},
	locale: {
		type: 'string',
		short: 'l',
		description: 'Locale for date/time formatting (e.g., en-US, ja-JP, de-DE)',
		default: DEFAULT_LOCALE,
	},
	jq: {
		type: 'string',
		short: 'q',
		description: 'Process JSON output with jq command (requires jq binary, implies --json)',
	},
	config: {
		type: 'string',
		description: 'Path to configuration file (default: auto-discovery)',
	},
	compact: {
		type: 'boolean',
		description: 'Force compact mode for narrow displays (better for screenshots)',
		default: false,
	},
	// ─── Multi-currency & provider args ─────────────────────────────────────
	statsCurrency: {
		type: 'string',
		description: 'Statistics currency (ISO 4217) to project usage costs into, e.g. "CNY". Default: USD.',
	},
	paymentCurrency: {
		type: 'string',
		description: 'Payment currency (ISO 4217) for the payable column, e.g. "CNY". Default: USD.',
	},
	costColumns: {
		type: 'string',
		description: 'Comma-separated cost columns to show: billing,payable,stats. Default: billing.',
	},
	paymentsPath: {
		type: 'string',
		description: 'Path to the per-transaction payment log (better-ccusage-payments.json).',
	},
	pricingPath: {
		type: 'string',
		description: 'Path to the per-platform user pricing overrides (better-ccusage-pricing.json).',
	},
	ccSwitchDbPath: {
		type: 'string',
		description: 'Path to the cc-switch SQLite DB (provider profiles). Default: auto-discovery.',
	},
	rate: {
		type: 'string',
		description: 'Exchange rate override as "FROM/TO=rate" (comma-separated for multiple), e.g. "USD/CNY=7.0".',
	},
	provider: {
		type: 'string',
		description: 'Filter/report only the given provider id (e.g. "bailian-aliyun-singapore").',
	},
	// ─── DuckDB OLAP store args ─────────────────────────────────────────────
	dbPath: {
		type: 'string',
		description: 'Path to the DuckDB OLAP store (better-ccusage.duckdb). Default: ~/.cc-switch-tui/better-ccusage.duckdb.',
	},
	noDuckdb: {
		type: 'boolean',
		description: 'Bypass the DuckDB store and use the legacy glob+parse path (fallback / verification).',
		default: false,
	},
	rebuild: {
		type: 'boolean',
		description: 'Force a full re-ingest of the DuckDB store (drops and re-imports all rows).',
		default: false,
	},
} as const satisfies Args;

/**
 * Shared command configuration for Gunshi CLI commands
 */
export const sharedCommandConfig = {
	args: sharedArgs,
	toKebab: true,
} as const;

/**
 * Resolve the effective output format from CLI/config options.
 *
 * Priority: an explicit non-table `--format` wins; otherwise the `--json` and
 * `--tree` boolean shorthands take effect (json before tree); otherwise the
 * default `table` is used. This keeps `--json`/`--tree` as drop-in shorthands
 * for `--format json`/`--format tree` while letting `--format` override them.
 */
export function resolveFormat(opts: { format?: string; json?: boolean; tree?: boolean }): OutputFormat {
	if (opts.format != null && opts.format !== 'table') {
		return opts.format as OutputFormat;
	}
	if (opts.json === true) {
		return 'json';
	}
	if (opts.tree === true) {
		return 'tree';
	}
	return 'table';
}
