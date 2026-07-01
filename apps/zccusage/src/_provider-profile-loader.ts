import type { Database, SqlJsStatic, SqlValue } from 'sql.js';
import type { PlanType, ProviderHistoryEntry, ProviderProfile, ProviderScheduleEntry } from './_types.ts';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import initSqlJs from 'sql.js';
import * as v from 'valibot';
import { CC_SWITCH_DB_PATHS, resolveCcSwitchConfigDir } from './_consts.ts';
import { providerScheduleEntrySchema } from './_types.ts';
import { logger } from './logger.ts';

/**
 * Provider profile loader — auto-reads the cc-switch SQLite DB to build
 * `ProviderProfile` objects (the *sales platforms* that bill for API usage).
 *
 * A profile is identified by BASE_URL. The model *supplier* is NOT a profile
 * field: it is encoded in the per-entry `model_id` string, so
 * `(providerId, model_id)` fully determines `(platform, supplier, model)`.
 *
 * DB is opened read-only via `sql.js` (pure WASM, no native binding). If the
 * DB is missing or unreadable, this degrades to an empty list (callers then
 * rely on user-supplied `providerProfiles` config).
 */

// Resolve sql.js's WASM payload via the node module path (source/dev mode).
// ⚠️ Build-time bundling (tsdown) must emit sql-wasm.wasm as a bundled asset
//    and adjust `locateFile` accordingly — see plan high-risk point #5.
const nodeRequire = createRequire(import.meta.url);
let sqlEnginePromise: Promise<SqlJsStatic> | undefined;
async function getSqlEngine(): Promise<SqlJsStatic> {
	if (sqlEnginePromise == null) {
		sqlEnginePromise = initSqlJs({
			locateFile: (file: string) => {
				try {
					return nodeRequire.resolve(`sql.js/dist/${file}`);
				}
				catch {
					return nodeRequire.resolve(`sql.js/${file}`);
				}
			},
		});
	}
	return sqlEnginePromise;
}

/**
 * Slot env vars in cc-switch `settings_config.env` that map Claude Code's
 *  alias slots to the actual model_id served by the platform.
 */
const SLOT_ENV_KEYS = [
	'ANTHROPIC_DEFAULT_OPUS_MODEL',
	'ANTHROPIC_DEFAULT_SONNET_MODEL',
	'ANTHROPIC_DEFAULT_HAIKU_MODEL',
	'ANTHROPIC_MODEL',
	'ANTHROPIC_REASONING_MODEL',
] as const;

const SLOT_NAMES: Record<string, string> = {
	ANTHROPIC_DEFAULT_OPUS_MODEL: 'opus',
	ANTHROPIC_DEFAULT_SONNET_MODEL: 'sonnet',
	ANTHROPIC_DEFAULT_HAIKU_MODEL: 'haiku',
	ANTHROPIC_MODEL: 'default',
	ANTHROPIC_REASONING_MODEL: 'reasoning',
};

export type LoadProviderProfileOptions = {
	ccSwitchDbPath?: string; // explicit override
	appType?: string; // filter by app_type (default: 'claude')
	allAppTypes?: boolean; // load every app_type (for the `agent` tree dimension)
};

/**
 * Resolve the cc-switch DB path: explicit override, else the first existing
 * default candidate.
 */
function resolveDbPath(ccSwitchDbPath?: string): string | undefined {
	if (ccSwitchDbPath != null && ccSwitchDbPath !== '') {
		return ccSwitchDbPath;
	}
	for (const candidate of CC_SWITCH_DB_PATHS) {
		try {
			readFileSync(candidate); // exists + readable
			return candidate;
		}
		catch {
			continue;
		}
	}
	return undefined;
}

/**
 * Parse a cc-switch `settings_config` JSON blob into the profile fields we
 * care about (base_url + slot→model_id alias map).
 */
function parseSettingsConfig(raw: string | null | undefined): {
	baseUrl?: string;
	modelAliasMap?: Record<string, string>;
} {
	if (raw == null || raw === '') {
		return {};
	}
	let cfg: Record<string, unknown>;
	try {
		cfg = JSON.parse(raw) as Record<string, unknown>;
	}
	catch {
		return {};
	}
	const env = (cfg.env ?? {}) as Record<string, unknown>;
	const baseUrl = typeof env.ANTHROPIC_BASE_URL === 'string' ? env.ANTHROPIC_BASE_URL : undefined;
	const modelAliasMap: Record<string, string> = {};
	for (const key of SLOT_ENV_KEYS) {
		const value = env[key];
		if (typeof value === 'string' && value !== '') {
			const slot = SLOT_NAMES[key] ?? key;
			modelAliasMap[slot] = value;
		}
	}
	return { baseUrl, modelAliasMap };
}

function toNumber(value: SqlValue | undefined): number | undefined {
	if (typeof value === 'number') {
		return value;
	}
	if (typeof value === 'string' && value !== '') {
		const n = Number(value);
		return Number.isFinite(n) ? n : undefined;
	}
	return undefined;
}

function toBoolean(value: SqlValue | undefined): boolean | undefined {
	if (typeof value === 'number') {
		return value !== 0;
	}
	if (typeof value === 'boolean') {
		return value;
	}
	if (typeof value === 'string') {
		return value === '1' || value.toLowerCase() === 'true';
	}
	return undefined;
}

function rowToProfile(row: Record<string, SqlValue>): ProviderProfile {
	const settings = parseSettingsConfig(typeof row.settings_config === 'string' ? row.settings_config : null);
	const id = String(row.id ?? '');
	const baseUrl = settings.baseUrl;
	const derived = deriveProfileFields(id, baseUrl);
	const profile: ProviderProfile = {
		id,
		name: String(row.name ?? ''),
		appType: String(row.app_type ?? ''),
		category: typeof row.category === 'string' ? row.category : undefined,
		baseUrl,
		modelAliasMap: settings.modelAliasMap,
		costMultiplier: toNumber(row.cost_multiplier),
		limitDailyUsd: toNumber(row.limit_daily_usd),
		limitMonthlyUsd: toNumber(row.limit_monthly_usd),
		providerType: typeof row.provider_type === 'string' ? row.provider_type : undefined,
		isCurrent: toBoolean(row.is_current),
		platform: derived.platform,
		region: derived.region,
		planType: derived.planType,
	};
	return profile;
}

// ─── Derived field inference (platform / region / planType) ──────────────────
//
// cc-switch stores only `id` + `settings_config.base_url` per provider; the
// `platform` / `region` / `planType` sales-platform attributes are NOT columns.
// They are encoded in the `id` (e.g. `volcengine-ark-beijing-agent-plan`) and,
// for region, often also in the base_url host (`*.cn-beijing.*`, `*.ap-southeast-1.*`).
// We infer them here so tree `--tree-group reseller,region,plan` works without
// a user-supplied `providerProfiles` config. Explicit config overrides always win
// (callers layer those on top of this list).

const PLATFORM_ALIASES: Record<string, string> = {
	anthropic: 'anthropic',
	claude: 'anthropic',
	official: 'anthropic',
	bailian: 'bailian',
	aliyun: 'bailian',
	dashscope: 'bailian',
	volcengine: 'volcengine',
	ark: 'volcengine',
	doubao: 'volcengine',
	zhipu: 'zhipu',
	glm: 'zhipu',
	moonshot: 'moonshot',
	kimi: 'moonshot',
	minimax: 'minimax',
	deepseek: 'deepseek',
	openai: 'openai',
	google: 'google',
	gemini: 'google',
	poe: 'poe',
};

// Known region tokens. Matched against id segments and base_url host substrings.
const REGIONS = [
	'singapore',
	'beijing',
	'shanghai',
	'hangzhou',
	'shenzhen',
	'guangzhou',
	'us',
	'us-east',
	'us-west',
	'eu',
	'hk',
	'hongkong',
	'tokyo',
	'frankfurt',
	'london',
	'sydney',
	'mumbai',
	'seoul',
] as const;

// base_url host substrings → region (covers Alibaba `ap-southeast-1` etc.)
const HOST_REGION_PATTERNS: Array<{ pattern: string; region: string }> = [
	{ pattern: 'ap-southeast-1', region: 'singapore' },
	{ pattern: 'cn-beijing', region: 'beijing' },
	{ pattern: 'cn-shanghai', region: 'shanghai' },
	{ pattern: 'cn-hangzhou', region: 'hangzhou' },
	{ pattern: 'cn-shenzhen', region: 'shenzhen' },
	{ pattern: 'cn-hongkong', region: 'hk' },
	{ pattern: 'us-east', region: 'us-east' },
	{ pattern: 'us-west', region: 'us-west' },
	{ pattern: 'eu-west', region: 'eu' },
	{ pattern: 'ap-northeast-1', region: 'tokyo' },
	{ pattern: 'eu-central', region: 'frankfurt' },
];

// planType tokens as they appear in id segments (kebab). Map to PlanType values.
const PLAN_TOKENS: Record<string, PlanType> = {
	'agent-plan': 'agent plan',
	'coding-plan': 'coding plan',
	'saving-plan': 'saving plan',
	'token-plan': 'token plan',
	'pay-as-you-go': 'pay-as-you-go',
	'payg': 'pay-as-you-go',
};

function derivePlatform(idSegments: string[], baseUrl?: string): string | undefined {
	// First id segment is the platform token (e.g. "volcengine", "bailian", "claude").
	const first = idSegments[0]?.toLowerCase();
	if (first != null && PLATFORM_ALIASES[first] != null) {
		return PLATFORM_ALIASES[first];
	}
	// Fall back to base_url host.
	if (baseUrl != null) {
		try {
			const host = new URL(baseUrl).hostname.toLowerCase();
			for (const [token, platform] of Object.entries(PLATFORM_ALIASES)) {
				if (host.includes(token)) {
					return platform;
				}
			}
			// host-only fallback (e.g. api.poe.com → "poe")
			const apex = host.split('.').slice(-2, -1)[0];
			if (apex != null && PLATFORM_ALIASES[apex] != null) {
				return PLATFORM_ALIASES[apex];
			}
			return apex;
		}
		catch {
			return undefined;
		}
	}
	return undefined;
}

function deriveRegion(idSegments: string[], baseUrl?: string): string | undefined {
	const lower = idSegments.map(s => s.toLowerCase());
	for (const seg of lower) {
		for (const r of REGIONS) {
			if (seg === r || seg === r.replace('-', '')) {
				return r;
			}
		}
	}
	if (baseUrl != null) {
		try {
			const host = new URL(baseUrl).hostname.toLowerCase();
			for (const { pattern, region } of HOST_REGION_PATTERNS) {
				if (host.includes(pattern)) {
					return region;
				}
			}
		}
		catch {
			// ignore
		}
	}
	return undefined;
}

function derivePlanType(id: string): PlanType | undefined {
	const lower = id.toLowerCase();
	// Prefer the longest token to avoid partial collisions.
	const matched = Object.keys(PLAN_TOKENS)
		.filter(token => lower.includes(token))
		.sort((a, b) => b.length - a.length);
	return matched[0] != null ? PLAN_TOKENS[matched[0]] : undefined;
}

export function deriveProfileFields(id: string, baseUrl?: string): { platform?: string; region?: string; planType?: PlanType } {
	const idSegments = id.split('-');
	return {
		platform: derivePlatform(idSegments, baseUrl),
		region: deriveRegion(idSegments, baseUrl),
		planType: derivePlanType(id),
	};
}

/**
 * Reverse-lookup a providerId by base_url. Tries exact match first, then a
 * loose same-host match. Returns undefined when no profile matches (e.g. the
 * base_url belongs to a provider not in cc-switch.db). Callers should still
 * record the switch with a NULL provider_id so the timestamp is preserved.
 */
export function findProviderIdByBaseUrl(
	baseUrl: string,
	profiles: ProviderProfile[],
): string | undefined {
	if (baseUrl == null || baseUrl === '') {
		return undefined;
	}
	// 1. Exact match.
	for (const p of profiles) {
		if (p.baseUrl === baseUrl) {
			return p.id;
		}
	}
	// 2. Loose match: same hostname.
	let targetHost: string;
	try {
		targetHost = new URL(baseUrl).hostname.toLowerCase();
	}
	catch {
		return undefined;
	}
	if (targetHost === '') {
		return undefined;
	}
	for (const p of profiles) {
		if (p.baseUrl == null) {
			continue;
		}
		try {
			if (new URL(p.baseUrl).hostname.toLowerCase() === targetHost) {
				return p.id;
			}
		}
		catch {
			continue;
		}
	}
	return undefined;
}

/**
 * Load provider profiles from the cc-switch DB. Returns an empty array if the
 * DB is missing/unreadable. Caller may layer `providerOverrides` /
 * `providerProfiles` config on top.
 */
export async function loadProviderProfiles(options: LoadProviderProfileOptions = {}): Promise<ProviderProfile[]> {
	const dbPath = resolveDbPath(options.ccSwitchDbPath);
	if (dbPath == null) {
		logger.debug('No cc-switch DB found; provider profiles will rely on user config only');
		return [];
	}

	let db: Database;
	try {
		const SQL = await getSqlEngine();
		const data = readFileSync(dbPath);
		db = new SQL.Database(data);
	}
	catch (err) {
		logger.warn(`Failed to open cc-switch DB at ${dbPath}: ${(err as Error).message}`);
		return [];
	}

	try {
		const allAppTypes = options.allAppTypes === true;
		const appType = options.appType ?? 'claude';
		const baseSql = 'SELECT id, name, app_type, settings_config, category, cost_multiplier, limit_daily_usd, limit_monthly_usd, provider_type, is_current FROM providers';
		const stmt = allAppTypes
			? db.prepare(`${baseSql};`)
			: db.prepare(`${baseSql} WHERE app_type = ?;`);
		if (!allAppTypes) {
			stmt.bind([appType]);
		}
		const profiles: ProviderProfile[] = [];
		while (stmt.step()) {
			const row = stmt.getAsObject();
			profiles.push(rowToProfile(row));
		}
		stmt.free();
		return profiles;
	}
	catch (err) {
		logger.warn(`Failed to query cc-switch DB at ${dbPath}: ${(err as Error).message}`);
		return [];
	}
	finally {
		db.close();
	}
}

// `getSqlEngine` keeps sql.js live for bundlers; the lazy memo ensures the WASM
// init runs once per process.

// ─── Usage → Provider temporal mapping ──────────────────────────────────────
//
// JSONL has no base_url and cc-switch stores no switch history, so we map each
// usage entry (by timestamp) to a providerId via a priority chain. The model
// *supplier* is NOT resolved here — it lives in the per-entry model_id string.

export type ProviderResolutionContext = {
	profiles: ProviderProfile[];
	schedule?: ProviderScheduleEntry[];
	history?: ProviderHistoryEntry[];
};

/**
 * Resolve the providerId for a usage entry at `timestampMs` (epoch millis).
 *
 * Priority:
 *  1. User-declared `schedule` range containing the timestamp (most reliable —
 *     explicit historical disambiguation).
 *  2. Watcher `history`: the most recent entry with `ts <= timestamp` (observed
 *     switch events from the live-config watcher).
 *  3. The `is_current` profile snapshot (accurate for recent entries, i.e. the
 *     period since the last switch).
 *  4. `undefined` — caller should treat the entry as `unknown` (model_id still
 *     resolves via static USD pricing, preserving current behavior).
 */
export function resolveProviderId(
	timestampMs: number,
	ctx: ProviderResolutionContext,
): string | undefined {
	if (Number.isNaN(timestampMs)) {
		return undefined;
	}
	const ts = timestampMs;

	// 1. Explicit schedule override.
	if (ctx.schedule != null && ctx.schedule.length > 0) {
		for (const entry of ctx.schedule) {
			const from = new Date(entry.from).getTime();
			const to = new Date(entry.to).getTime();
			if (ts >= from && ts <= to) {
				return entry.providerId;
			}
		}
	}

	// 2. Watcher history: most recent entry with ts <= entry timestamp.
	if (ctx.history != null && ctx.history.length > 0) {
		let best: ProviderHistoryEntry | undefined;
		for (const entry of ctx.history) {
			if (entry.ts <= ts && (best == null || entry.ts > best.ts)) {
				best = entry;
			}
		}
		if (best != null) {
			return best.providerId;
		}
	}

	// 3. is_current snapshot.
	const current = ctx.profiles.find(p => p.isCurrent === true);
	if (current != null) {
		return current.id;
	}

	// 4. Unmapped.
	return undefined;
}

/**
 * Load the manual provider schedule from `$CC_SWITCH_CONFIG_DIR/provider_schedule.json`
 * (the R1 retrospective attribution source). The file declares `{from, to, providerId}`
 * ranges that take priority over both watcher history and the `is_current` snapshot.
 * Returns an empty array when the file is missing or unreadable (callers fall back
 * to history → is_current → undefined). Validates each entry against the valibot
 * schema; malformed entries are logged and skipped (a single bad row does not abort
 * the whole schedule).
 */
export function loadProviderSchedule(schedulePath?: string): ProviderScheduleEntry[] {
	const filePath = schedulePath != null && schedulePath !== ''
		? schedulePath
		: path.join(resolveCcSwitchConfigDir(), 'provider_schedule.json');
	let raw: string;
	try {
		raw = readFileSync(filePath, 'utf8');
	}
	catch {
		// Missing schedule is the common case (file is optional) — debug only.
		logger.debug(`No provider schedule at ${filePath}; schedule layer will be empty`);
		return [];
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	}
	catch (err) {
		logger.warn(`Provider schedule at ${filePath} is not valid JSON: ${(err as Error).message}`);
		return [];
	}
	if (!Array.isArray(parsed)) {
		logger.warn(`Provider schedule at ${filePath} is not a JSON array`);
		return [];
	}
	const schedule: ProviderScheduleEntry[] = [];
	for (const entry of parsed) {
		const result = v.safeParse(providerScheduleEntrySchema, entry);
		if (result.success) {
			schedule.push(result.output);
		}
		else {
			logger.warn(`Provider schedule entry skipped (invalid): ${JSON.stringify(entry)}`);
		}
	}
	return schedule;
}

/**
 * Build a `providerId → planType` override map from a loaded schedule. Entries
 * without `planType` are skipped. When the same providerId appears in multiple
 * schedule entries with different planTypes, the last entry wins (callers
 * should avoid declaring conflicting plans for the same providerId, but this
 * keeps the override well-defined). Used by `attachProfileFields` so the `plan`
 * tree dimension resolves for provider ids that carry no plan token (e.g.
 * `bailian-aliyun-singapore` → `saving plan`).
 */
export function buildPlanOverrides(schedule: ProviderScheduleEntry[]): Map<string, string> {
	const overrides = new Map<string, string>();
	for (const entry of schedule) {
		if (entry.planType != null && entry.planType !== '') {
			overrides.set(entry.providerId, entry.planType);
		}
	}
	return overrides;
}

// ─── In-source tests ─────────────────────────────────────────────────────────

if (import.meta.vitest != null) {
	describe('loadProviderProfiles', () => {
		it('returns empty when DB path does not exist', async () => {
			const profiles = await loadProviderProfiles({ ccSwitchDbPath: '/nonexistent/cc-switch.db' });
			expect(profiles).toEqual([]);
		});
	});

	describe('deriveProfileFields', () => {
		it('infers platform/region/planType from a structured id', () => {
			expect(deriveProfileFields('volcengine-ark-beijing-agent-plan')).toEqual({
				platform: 'volcengine',
				region: 'beijing',
				planType: 'agent plan',
			});
		});

		it('infers bailian singapore from id', () => {
			expect(deriveProfileFields('bailian-aliyun-singapore')).toEqual({
				platform: 'bailian',
				region: 'singapore',
				planType: undefined,
			});
		});

		it('infers region from base_url host when id has none', () => {
			expect(deriveProfileFields('aliyun-bailian-beijing-token-plan', 'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic')).toEqual({
				platform: 'bailian',
				region: 'beijing',
				planType: 'token plan',
			});
		});

		it('infers region from base_url ap-southeast-1 pattern', () => {
			const r = deriveProfileFields('bailian-aliyun-singapore', 'https://ws-4u9rppj98g323w16.ap-southeast-1.maas.aliyuncs.com/apps/anthropic');
			expect(r.region).toBe('singapore');
			expect(r.platform).toBe('bailian');
		});

		it('falls back to base_url host apex for platform when id token unknown', () => {
			expect(deriveProfileFields('default', 'https://api.poe.com')?.platform).toBe('poe');
		});

		it('maps claude/official id to anthropic platform', () => {
			expect(deriveProfileFields('claude-official')?.platform).toBe('anthropic');
		});

		it('returns undefineds for unstructured id with no base_url', () => {
			expect(deriveProfileFields('default')).toEqual({
				platform: undefined,
				region: undefined,
				planType: undefined,
			});
		});

		it('matches pay-as-you-go plan token', () => {
			expect(deriveProfileFields('acme-pay-as-you-go')?.planType).toBe('pay-as-you-go');
		});
	});

	describe('findProviderIdByBaseUrl', () => {
		const profiles = [
			{ id: 'poe-philosophos', name: 'POE', appType: 'claude', baseUrl: 'https://api.poe.com/v1' } as never,
			{ id: 'bailian-aliyun-singapore', name: 'Bailian SG', appType: 'claude', baseUrl: 'https://ws-xxx.ap-southeast-1.maas.aliyuncs.com/apps/anthropic' } as never,
			{ id: 'no-url-provider', name: 'NoUrl', appType: 'claude', baseUrl: undefined } as never,
		];

		it('exact base_url match returns provider id', () => {
			expect(findProviderIdByBaseUrl('https://api.poe.com/v1', profiles)).toBe('poe-philosophos');
		});

		it('same host loose match when exact url differs', () => {
			expect(findProviderIdByBaseUrl('https://api.poe.com/v2', profiles)).toBe('poe-philosophos');
		});

		it('returns undefined when no host matches', () => {
			expect(findProviderIdByBaseUrl('https://api.unknown.com', profiles)).toBeUndefined();
		});

		it('returns undefined for invalid url', () => {
			expect(findProviderIdByBaseUrl('not-a-url', profiles)).toBeUndefined();
		});

		it('skips profiles without baseUrl', () => {
			expect(findProviderIdByBaseUrl('https://api.poe.com/v1', [profiles[2]!])).toBeUndefined();
		});
	});

	describe('resolveProviderId', () => {
		const profiles = [
			{ id: 'bailian-aliyun-singapore', name: 'Bailian SG', appType: 'claude', isCurrent: true } as never,
			{ id: 'claude-official', name: 'Official', appType: 'claude', isCurrent: false } as never,
		];

		it('schedule override wins when timestamp falls in range', () => {
			const schedule = [
				{ from: '2026-01-01T00:00:00.000Z' as never, to: '2026-01-31T23:59:59.000Z' as never, providerId: 'claude-official' } as never,
			];
			const ts = new Date('2026-01-15T00:00:00.000Z').getTime();
			expect(resolveProviderId(ts, { profiles, schedule })).toBe('claude-official');
		});

		it('falls back to is_current snapshot outside schedule ranges', () => {
			const ts = new Date('2026-06-01T00:00:00.000Z').getTime();
			expect(resolveProviderId(ts, { profiles })).toBe('bailian-aliyun-singapore');
		});

		it('returns undefined when no profiles and no schedule', () => {
			const ts = new Date('2026-06-01T00:00:00.000Z').getTime();
			expect(resolveProviderId(ts, { profiles: [] })).toBeUndefined();
		});

		it('returns undefined for invalid timestamp', () => {
			expect(resolveProviderId(Number.NaN, { profiles })).toBeUndefined();
		});

		it('history beats is_current when ts >= entry timestamp', () => {
			const history = [
				{ ts: new Date('2026-06-29T18:41:14').getTime(), providerId: 'volcengine-ark-beijing-agent-plan' } as never,
			];
			const ts = new Date('2026-06-30T00:00:00').getTime();
			// profiles[0] (bailian SG) is_current, but history should win
			expect(resolveProviderId(ts, { profiles, history })).toBe('volcengine-ark-beijing-agent-plan');
		});

		it('history ignored when ts < entry timestamp (uses is_current)', () => {
			const history = [
				{ ts: new Date('2026-06-29T18:41:14').getTime(), providerId: 'volcengine-ark-beijing-agent-plan' } as never,
			];
			const ts = new Date('2026-06-28T00:00:00').getTime(); // before the switch
			expect(resolveProviderId(ts, { profiles, history })).toBe('bailian-aliyun-singapore');
		});

		it('schedule still beats history', () => {
			const schedule = [
				{ from: '2026-06-01T00:00:00.000Z' as never, to: '2026-06-30T23:59:59.000Z' as never, providerId: 'claude-official' } as never,
			];
			const history = [
				{ ts: new Date('2026-06-15T00:00:00').getTime(), providerId: 'poe-philosophos' } as never,
			];
			const ts = new Date('2026-06-20T00:00:00').getTime();
			expect(resolveProviderId(ts, { profiles, schedule, history })).toBe('claude-official');
		});

		it('most recent history entry <= ts wins', () => {
			const history = [
				{ ts: new Date('2026-06-21T14:00:00').getTime(), providerId: 'bailian-aliyun-singapore' } as never,
				{ ts: new Date('2026-06-28T17:56').getTime(), providerId: 'aliyun-bailian-beijing-token-plan' } as never,
			];
			const ts = new Date('2026-06-29T00:00:00').getTime();
			expect(resolveProviderId(ts, { profiles, history })).toBe('aliyun-bailian-beijing-token-plan');
		});

		it('empty history array falls through to is_current', () => {
			const ts = new Date('2026-06-01T00:00:00').getTime();
			expect(resolveProviderId(ts, { profiles, history: [] })).toBe('bailian-aliyun-singapore');
		});
	});
}
