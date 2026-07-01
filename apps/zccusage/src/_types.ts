import type { TupleToUnion } from 'type-fest';
import * as v from 'valibot';

/**
 * Branded Valibot schemas for type safety using brand markers.
 */

// Core identifier schemas
export const modelNameSchema = v.pipe(
	v.string(),
	v.minLength(1, 'Model name cannot be empty'),
	v.brand('ModelName'),
);

export const sessionIdSchema = v.pipe(
	v.string(),
	v.minLength(1, 'Session ID cannot be empty'),
	v.brand('SessionId'),
);

export const requestIdSchema = v.pipe(
	v.string(),
	v.minLength(1, 'Request ID cannot be empty'),
	v.brand('RequestId'),
);

export const messageIdSchema = v.pipe(
	v.string(),
	v.minLength(1, 'Message ID cannot be empty'),
	v.brand('MessageId'),
);

// Date and timestamp schemas
const isoTimestampRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
export const isoTimestampSchema = v.pipe(
	v.string(),
	v.regex(isoTimestampRegex, 'Invalid ISO timestamp'),
	v.brand('ISOTimestamp'),
);

const yyyymmddRegex = /^\d{4}-\d{2}-\d{2}$/;
export const dailyDateSchema = v.pipe(
	v.string(),
	v.regex(yyyymmddRegex, 'Date must be in YYYY-MM-DD format'),
	v.brand('DailyDate'),
);

export const activityDateSchema = v.pipe(
	v.string(),
	v.regex(yyyymmddRegex, 'Date must be in YYYY-MM-DD format'),
	v.brand('ActivityDate'),
);

const yyyymmRegex = /^\d{4}-\d{2}$/;
export const monthlyDateSchema = v.pipe(
	v.string(),
	v.regex(yyyymmRegex, 'Date must be in YYYY-MM format'),
	v.brand('MonthlyDate'),
);

export const weeklyDateSchema = v.pipe(
	v.string(),
	v.regex(yyyymmddRegex, 'Date must be in YYYY-MM-DD format'),
	v.brand('WeeklyDate'),
);

const filterDateRegex = /^\d{8}$/;
export const filterDateSchema = v.pipe(
	v.string(),
	v.regex(filterDateRegex, 'Date must be in YYYYMMDD format'),
	v.brand('FilterDate'),
);

// Other domain-specific schemas
export const projectPathSchema = v.pipe(
	v.string(),
	v.minLength(1, 'Project path cannot be empty'),
	v.brand('ProjectPath'),
);

export const sourceSchema = v.pipe(
	v.string(),
	v.picklist(['claude/droid', 'claude', 'droid']),
	v.brand('Source'),
);

const versionRegex = /^\d+\.\d+\.\d+/;
export const versionSchema = v.pipe(
	v.string(),
	v.regex(versionRegex, 'Invalid version format'),
	v.brand('Version'),
);

/**
 * Inferred branded types from schemas
 */
export type ModelName = v.InferOutput<typeof modelNameSchema>;
export type SessionId = v.InferOutput<typeof sessionIdSchema>;
export type RequestId = v.InferOutput<typeof requestIdSchema>;
export type MessageId = v.InferOutput<typeof messageIdSchema>;
export type ISOTimestamp = v.InferOutput<typeof isoTimestampSchema>;
export type DailyDate = v.InferOutput<typeof dailyDateSchema>;
export type ActivityDate = v.InferOutput<typeof activityDateSchema>;
export type MonthlyDate = v.InferOutput<typeof monthlyDateSchema>;
export type WeeklyDate = v.InferOutput<typeof weeklyDateSchema>;
export type Bucket = MonthlyDate | WeeklyDate;
export type FilterDate = v.InferOutput<typeof filterDateSchema>;
export type ProjectPath = v.InferOutput<typeof projectPathSchema>;
export type Source = v.InferOutput<typeof sourceSchema>;
export type Version = v.InferOutput<typeof versionSchema>;

/**
 * Helper functions to create branded values by parsing and validating input strings
 * These functions should be used when converting plain strings to branded types
 */
export const createModelName = (value: string): ModelName => v.parse(modelNameSchema, value);
export const createSessionId = (value: string): SessionId => v.parse(sessionIdSchema, value);
export const createRequestId = (value: string): RequestId => v.parse(requestIdSchema, value);
export const createMessageId = (value: string): MessageId => v.parse(messageIdSchema, value);
export const createISOTimestamp = (value: string): ISOTimestamp => v.parse(isoTimestampSchema, value);
export const createDailyDate = (value: string): DailyDate => v.parse(dailyDateSchema, value);
export const createActivityDate = (value: string): ActivityDate => v.parse(activityDateSchema, value);
export const createMonthlyDate = (value: string): MonthlyDate => v.parse(monthlyDateSchema, value);
export const createWeeklyDate = (value: string): WeeklyDate => v.parse(weeklyDateSchema, value);
export const createFilterDate = (value: string): FilterDate => v.parse(filterDateSchema, value);
export const createProjectPath = (value: string): ProjectPath => v.parse(projectPathSchema, value);
export const createSource = (value: string): Source => v.parse(sourceSchema, value);
export const createVersion = (value: string): Version => v.parse(versionSchema, value);

export function createBucket(value: string): Bucket {
	const weeklyResult = v.safeParse(weeklyDateSchema, value);
	if (weeklyResult.success) {
		return weeklyResult.output;
	}
	return createMonthlyDate(value);
};

/**
 * Available cost calculation modes
 * - auto: Use pre-calculated costs when available, otherwise calculate from tokens
 * - calculate: Always calculate costs from token counts using model pricing
 * - display: Always use pre-calculated costs, show 0 for missing costs
 */
export const CostModes = ['auto', 'calculate', 'display'] as const;

/**
 * Union type for cost calculation modes
 */
export type CostMode = TupleToUnion<typeof CostModes>;

/**
 * Available sort orders for data presentation
 */
export const SortOrders = ['desc', 'asc'] as const;

/**
 * Union type for sort order options
 */
export type SortOrder = TupleToUnion<typeof SortOrders>;

/**
 * Valibot schema for Claude Code statusline hook JSON data
 */
export const statuslineHookJsonSchema = v.object({
	session_id: v.string(),
	transcript_path: v.string(),
	cwd: v.string(),
	model: v.object({
		id: v.string(),
		display_name: v.string(),
	}),
	workspace: v.object({
		current_dir: v.string(),
		project_dir: v.string(),
	}),
	version: v.optional(v.string()),
	cost: v.optional(v.object({
		total_cost_usd: v.number(),
		total_duration_ms: v.optional(v.number()),
		total_api_duration_ms: v.optional(v.number()),
		total_lines_added: v.optional(v.number()),
		total_lines_removed: v.optional(v.number()),
	})),
});

/**
 * Type definition for Claude Code statusline hook JSON data
 */
export type StatuslineHookJson = v.InferOutput<typeof statuslineHookJsonSchema>;

/**
 * Type definition for transcript usage data from Claude messages
 */

// ─── Multi-currency & provider types ────────────────────────────────────────

/**
 * Branded ISO 4217 currency code (e.g. "USD", "CNY").
 */
export const currencyCodeSchema = v.pipe(
	v.string(),
	v.minLength(3, 'Currency code must be 3 letters'),
	v.maxLength(3, 'Currency code must be 3 letters'),
	v.transform(value => value.toUpperCase()),
	v.brand('CurrencyCode'),
);
export type CurrencyCode = v.InferOutput<typeof currencyCodeSchema>;
export const createCurrencyCode = (value: string): CurrencyCode => v.parse(currencyCodeSchema, value);

/**
 * Subscription / billing plan types offered by sales platforms.
 * Finite set per user spec; `custom` allows manual free-form entry.
 */
export const PlanTypes = ['coding plan', 'saving plan', 'token plan', 'agent plan', 'pay-as-you-go', 'custom'] as const;
export type PlanType = TupleToUnion<typeof PlanTypes>;

/**
 * Cost display dimensions ("口径") shown as parallel columns in reports.
 * - billing: per-token list price in the platform's billing currency
 * - payable: actual money paid, from the per-transaction payment log
 * - stats:   usage costs converted to a single user-chosen statistics currency
 */
export const CostColumns = ['billing', 'payable', 'stats'] as const;
export type CostColumn = TupleToUnion<typeof CostColumns>;

/**
 * Output formats for usage reports.
 * - table: cli-table3 tabular view (default)
 * - json:  structured JSON for programmatic consumption
 * - tree:  hierarchical Unicode tree view (per `--tree-group` dimensions)
 */
export const OutputFormats = ['table', 'json', 'tree'] as const;
export type OutputFormat = TupleToUnion<typeof OutputFormats>;

/**
 * Nesting dimensions for the tree output format. `--tree-group` accepts a
 * comma-separated subset of these in any order.
 * - time:     the report period (date / week / month / sessionId). Selected by
 *             the command name (daily/weekly/monthly/session), NOT the literal
 *             "time". Kept as the internal dimension name.
 * - project:  project directory
 * - provider: sales platform id (providerId)
 * - reseller: platform / reseller (profile.platform — bailian | zhipu | anthropic | ...)
 * - region:   sales region (profile.region — singapore | beijing | us | ...)
 * - plan:     subscription plan (profile.planType — coding plan | saving plan | ...)
 * - model:    model name (exploded from modelBreakdowns; recommended last)
 *
 * `reseller` / `region` / `plan` are derived from the provider profile that
 * backs each row's `providerId`; rows without a profile resolve to `(unknown)`.
 */
export const TreeDimensions = ['time', 'project', 'provider', 'agent', 'reseller', 'region', 'plan', 'model'] as const;
export type TreeDimension = TupleToUnion<typeof TreeDimensions>;

/**
 * Time-bucket values accepted by `--group`. A bucket selects the data loader
 * (daily/weekly/monthly/session) and occupies the `time` dimension slot in the
 * tree at the position it appears in the `--group` list. Omitting a bucket
 * loads all records with no time aggregation.
 */
export const TreeBuckets = ['daily', 'weekly', 'monthly', 'session'] as const;
export type TreeBucket = TupleToUnion<typeof TreeBuckets>;

/**
 * A provider profile — the *sales platform* that bills for API usage.
 * Identified by BASE_URL. The model *supplier* is NOT a profile field:
 * it is encoded in the per-entry `model_id` string (e.g. `glm-5.2` vs
 * `ZHIPU/GLM-5.2` on the same platform), so `(providerId, model_id)`
 * fully determines `(platform, supplier, model)`.
 *
 * Profiles are auto-loaded from the cc-switch SQLite DB; any field here may
 * be overridden or manually supplied via `providerOverrides` / `providerProfiles` config.
 */
export type ProviderProfile = {
	id: string; // natural key, e.g. "bailian-aliyun-singapore" (matches cc-switch providers.id)
	name: string;
	appType: string; // claude | codex | gemini | ...
	category?: string; // official | custom | ...
	baseUrl?: string; // ANTHROPIC_BASE_URL — identifies the sales platform
	modelAliasMap?: Record<string, string>; // slot (opus/sonnet/haiku/...) → actual model_id
	costMultiplier?: number; // per-provider cost multiplier (default 1)
	limitDailyUsd?: number;
	limitMonthlyUsd?: number;
	providerType?: string;
	isCurrent?: boolean;
	// Derived / user-supplied fields:
	platform?: string; // bailian | anthropic | openai | google | zhipu | moonshot | minimax | deepseek | ...
	region?: string; // singapore | beijing | us | ...
	workspace?: string; // extracted from base_url or user-supplied
	planType?: PlanType;
	billingCurrency?: string; // ISO 4217 — the currency this platform bills in
	note?: string; // manual user note for readability
};

/**
 * A single per-transaction payment record. Decoupled from usage entries:
 * payments happen at payment time, not usage time. The dual-currency
 * (billingAmount in billingCurrency, paymentAmount in paymentCurrency) pair
 * implicitly captures the effective FX rate at payment time.
 */
export const paymentRecordSchema = v.object({
	id: v.optional(v.string()),
	paymentTime: isoTimestampSchema,
	providerId: v.optional(v.string()), // which platform this payment topped up
	billingCurrency: currencyCodeSchema,
	billingAmount: v.number(),
	paymentCurrency: currencyCodeSchema,
	paymentAmount: v.number(),
	note: v.optional(v.string()),
	coversRange: v.optional(v.object({
		from: isoTimestampSchema,
		to: isoTimestampSchema,
	})),
});
export type PaymentRecord = v.InferOutput<typeof paymentRecordSchema>;

/**
 * User-declared temporal mapping: "during [from, to] I used provider X".
 * The reliable fallback for historical provider disambiguation, since
 * JSONL has no base_url and cc-switch stores no switch history.
 */
export const providerScheduleEntrySchema = v.object({
	from: isoTimestampSchema,
	to: isoTimestampSchema,
	providerId: v.string(),
	// Optional plan override: when the cc-switch provider id carries no plan
	// token (e.g. `bailian-aliyun-singapore`), the schedule entry can declare
	// the plan active during this period so the `plan` tree dimension resolves
	// correctly instead of falling back to (unknown).
	planType: v.optional(v.string()),
});
export type ProviderScheduleEntry = v.InferOutput<typeof providerScheduleEntrySchema>;

/**
 * One observed provider switch (from the watcher). `ts` is epoch milliseconds
 * (the live-config file mtime at switch time). Used by `resolveProviderId` as
 * priority layer 2: the most recent entry with `ts <= entry timestamp` wins.
 */
export type ProviderHistoryEntry = {
	ts: number;
	providerId: string;
};
