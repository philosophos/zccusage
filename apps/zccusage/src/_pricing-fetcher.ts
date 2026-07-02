import type { ModelPricing } from '@better-ccusage/internal/pricing';
import type { ProviderProfile } from './_types.ts';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { PricingFetcher } from '@better-ccusage/internal/pricing';
import { loadMergedPricing } from '@better-ccusage/internal/remote-pricing';
import { Result } from '@praha/byethrow';
import * as v from 'valibot';
import { DEFAULT_BILLING_CURRENCY, PRICING_FILE_NAME } from './_consts.ts';
import { getClaudePaths } from './data-loader.ts';
import { logger } from './logger.ts';

// ─── User pricing file (per-platform billing-currency price list) ───────────
//
// Keys are `{providerId}/{model_id}` where `model_id` is the raw string from
// JSONL `message.model` (it may itself contain a `/` supplier prefix, e.g.
// `bailian-aliyun-singapore/ZHIPU/GLM-5.2` — three segments). Values carry the
// platform's billing-currency per-token prices, which override the bundled USD
// static pricing for that (provider, model) pair.

/**
 * A single user-supplied pricing entry. Field names are camelCase for
 * ergonomics; they are mapped to `ModelPricing`'s snake_case keys on load.
 */
const userPricingEntrySchema = v.object({
	currency: v.optional(v.string()),
	inputCostPerToken: v.number(),
	outputCostPerToken: v.number(),
	cacheCreationInputTokenCost: v.optional(v.number()),
	cacheReadInputTokenCost: v.optional(v.number()),
});
export type UserPricingEntry = v.InferOutput<typeof userPricingEntrySchema>;

const userPricingFileSchema = v.record(v.string(), userPricingEntrySchema);

/**
 * A single structured pricing rule (new array format). Prices are per-million
 * tokens in the chosen currency. `region`/`plan` are optional specificity
 * overrides; omit them for a default that covers all the reseller's regions/plans.
 */
const userPricingArrayEntrySchema = v.object({
	reseller: v.pipe(v.string(), v.minLength(1)),
	model: v.string(),
	region: v.optional(v.string()),
	plan: v.optional(v.string()),
	currency: v.optional(v.string()),
	inputCostPerMTokens: v.number(),
	outputCostPerMTokens: v.number(),
	cacheCreationCostPerMTokens: v.optional(v.number()),
	cacheReadCostPerMTokens: v.optional(v.number()),
});
export type UserPricingArrayEntry = v.InferOutput<typeof userPricingArrayEntrySchema>;

const PER_MILLION = 1_000_000;

/**
 * Convert a per-million-token array entry into a `ModelPricing` (per-token).
 * Mirrors `toModelPricing` but divides by 1e6.
 */
function toModelPricingFromPerM(entry: UserPricingArrayEntry): ModelPricing {
	return {
		input_cost_per_token: entry.inputCostPerMTokens / PER_MILLION,
		output_cost_per_token: entry.outputCostPerMTokens / PER_MILLION,
		cache_creation_input_token_cost: entry.cacheCreationCostPerMTokens != null
			? entry.cacheCreationCostPerMTokens / PER_MILLION
			: undefined,
		cache_read_input_token_cost: entry.cacheReadCostPerMTokens != null
			? entry.cacheReadCostPerMTokens / PER_MILLION
			: undefined,
		currency: entry.currency ?? DEFAULT_BILLING_CURRENCY,
	};
}

/**
 * Match a structured pricing rule against loaded provider profiles.
 *
 * `reseller` is matched fuzzily (bidirectional substring) against the profile's
 * platform, id segments, and name — so `Aliyun`, `bailian`, `Aliyun_bailian`
 * all hit the same bailian profiles. `region`/`plan`, when provided, must match
 * the profile's derived field exactly; a profile with `region === undefined`
 * does not match a rule that specifies `region`.
 */
function matchProfiles(rule: UserPricingArrayEntry, profiles: ProviderProfile[]): ProviderProfile[] {
	const resellerLower = rule.reseller.toLowerCase();
	if (resellerLower === '') {
		return [];
	}
	const regionLower = rule.region?.toLowerCase();
	const planLower = rule.plan?.toLowerCase();
	return profiles.filter((p) => {
		const candidates = [
			p.platform,
			...(p.id != null ? p.id.split('-') : []),
			p.name,
		]
			.map(s => (s ?? '').toLowerCase())
			.filter(s => s !== '');
		const resellerHit = candidates.some(c => c.includes(resellerLower) || resellerLower.includes(c));
		if (!resellerHit) {
			return false;
		}
		if (regionLower != null && (p.region == null || p.region.toLowerCase() !== regionLower)) {
			return false;
		}
		if (planLower != null && (p.planType == null || p.planType.toLowerCase() !== planLower)) {
			return false;
		}
		return true;
	});
}

/**
 * Specificity = number of optional discriminators provided. Higher wins;
 * a tie at the top for the same (providerId, model) is an error.
 */
function specificityScore(rule: UserPricingArrayEntry): number {
	return (rule.region != null ? 1 : 0) + (rule.plan != null ? 1 : 0);
}

/**
 * Expand structured array rules into the `{providerId}/{model}` → `ModelPricing`
 * map. For each key, the highest-specificity rule wins. A tie at the top
 * specificity throws an error listing the conflicting rules. Rules that match
 * no profile are warned and skipped. Resolution is order-independent: only a
 * genuine tie at the highest specificity for a key is a conflict.
 */
function expandArrayRules(
	rules: UserPricingArrayEntry[],
	profiles: ProviderProfile[],
): Record<string, ModelPricing> {
	// Pass 1: collect every (key, rule, pricing, score) hit into a per-key list.
	const perKey = new Map<string, { rule: UserPricingArrayEntry; pricing: ModelPricing; score: number }[]>();
	for (const rule of rules) {
		const hits = matchProfiles(rule, profiles);
		if (hits.length === 0) {
			logger.warn(`Pricing rule for reseller "${rule.reseller}" matched no provider profile; skipped`);
			continue;
		}
		const pricing = toModelPricingFromPerM(rule);
		const score = specificityScore(rule);
		for (const p of hits) {
			const key = `${p.id}/${rule.model}`;
			let bucket = perKey.get(key);
			if (bucket == null) {
				bucket = [];
				perKey.set(key, bucket);
			}
			bucket.push({ rule, pricing, score });
		}
	}

	// Pass 2: per key, the unique top-score rule wins; ≥2 top-score rules conflict.
	const out: Record<string, ModelPricing> = {};
	const conflicts: { key: string; rules: UserPricingArrayEntry[] }[] = [];
	for (const [key, bucket] of perKey) {
		let maxScore = -1;
		for (const e of bucket) {
			if (e.score > maxScore) {
				maxScore = e.score;
			}
		}
		const topRules = bucket.filter(e => e.score === maxScore);
		if (topRules.length === 1) {
			out[key] = topRules[0]!.pricing;
		}
		else {
			conflicts.push({ key, rules: topRules.map(e => e.rule) });
		}
	}

	if (conflicts.length > 0) {
		const lines = conflicts.map((c) => {
			const desc = c.rules.map(r => JSON.stringify({ reseller: r.reseller, region: r.region, plan: r.plan, model: r.model })).join(' vs ');
			return `  ${c.key}: ${desc}`;
		});
		throw new Error(`Ambiguous pricing rules (same specificity match same providerId/model):\n${lines.join('\n')}`);
	}
	return out;
}

/**
 * Build candidate user-pricing file paths, mirroring the config search order:
 * 1. `./.better-ccusage/better-ccusage-pricing.json`
 * 2. `<each claude config dir>/better-ccusage-pricing.json`
 */
function buildPricingSearchPaths(): string[] {
	const dirs = [path.join(process.cwd(), '.better-ccusage')];
	try {
		dirs.push(...getClaudePaths());
	}
	catch {
		// getClaudePaths throws if no valid Claude dir exists — user pricing is
		// optional, so fall back to just the local cwd candidate.
	}
	return dirs.map(dir => path.join(dir, PRICING_FILE_NAME));
}

/**
 * Resolve the user-pricing file path: explicit `pricingPath` if given,
 * otherwise the first existing candidate from the search paths.
 */
function resolvePricingPath(pricingPath?: string): string | undefined {
	if (pricingPath != null && pricingPath !== '') {
		return existsSync(pricingPath) ? pricingPath : undefined;
	}
	for (const candidate of buildPricingSearchPaths()) {
		if (existsSync(candidate)) {
			return candidate;
		}
	}
	return undefined;
}

function toModelPricing(entry: UserPricingEntry): ModelPricing {
	return {
		input_cost_per_token: entry.inputCostPerToken,
		output_cost_per_token: entry.outputCostPerToken,
		cache_creation_input_token_cost: entry.cacheCreationInputTokenCost,
		cache_read_input_token_cost: entry.cacheReadInputTokenCost,
		currency: entry.currency ?? DEFAULT_BILLING_CURRENCY,
	};
}

/**
 * Load the user-supplied per-platform pricing overrides.
 *
 * Two formats, auto-detected via `Array.isArray`:
 *  - Array (new): structured rules `{reseller, model, region?, plan?, ...}`.
 *    Expanded into `{providerId}/{model}` keys by matching `profiles`. Requires
 *    `profiles` to resolve reseller→providerId; without profiles, returns `{}`.
 *  - Record (old, backward compatible): `{providerId}/{model}: {...}` keyed
 *    verbatim, per-token prices.
 *
 * Returns an empty object if no file is found or the file is malformed.
 */
export function loadUserPricing(
	pricingPath?: string,
	profiles?: ProviderProfile[],
): Record<string, ModelPricing> {
	const filePath = resolvePricingPath(pricingPath);
	if (filePath == null) {
		return {};
	}

	let raw: string;
	try {
		raw = readFileSync(filePath, 'utf-8');
	}
	catch (err) {
		logger.warn(`Failed to read user pricing file ${filePath}: ${(err as Error).message}`);
		return {};
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	}
	catch (err) {
		logger.warn(`User pricing file ${filePath} is not valid JSON: ${(err as Error).message}`);
		return {};
	}

	// New array format.
	if (Array.isArray(parsed)) {
		const rulesResult = v.safeParse(v.array(userPricingArrayEntrySchema), parsed);
		if (rulesResult.success) {
			return expandArrayRules(rulesResult.output, profiles ?? []);
		}
		// Fall back to per-entry validation: keep valid ones, drop the rest.
		logger.warn(`User pricing file ${filePath}: some array entries are invalid; dropping invalid entries`);
		const valid: UserPricingArrayEntry[] = [];
		for (const item of parsed) {
			const r = v.safeParse(userPricingArrayEntrySchema, item);
			if (r.success) {
				valid.push(r.output);
			}
		}
		return expandArrayRules(valid, profiles ?? []);
	}

	// Old record format (existing logic, unchanged).
	const result = v.safeParse(userPricingFileSchema, parsed);
	if (result.success) {
		const out: Record<string, ModelPricing> = {};
		for (const [key, entry] of Object.entries(result.output)) {
			out[key] = toModelPricing(entry);
		}
		return out;
	}

	// Fall back to per-entry validation: keep the valid ones, drop the rest.
	if (typeof parsed !== 'object' || parsed === null) {
		logger.warn(`User pricing file ${filePath}: expected an object or array`);
		return {};
	}
	const out: Record<string, ModelPricing> = {};
	const entries = Object.entries(parsed as Record<string, unknown>);
	let dropped = 0;
	for (const [key, value] of entries) {
		const entryResult = v.safeParse(userPricingEntrySchema, value);
		if (entryResult.success) {
			out[key] = toModelPricing(entryResult.output);
		}
		else {
			dropped++;
		}
	}
	if (dropped > 0) {
		logger.warn(`User pricing file ${filePath}: loaded ${entries.length - dropped}/${entries.length} entries (dropped ${dropped} invalid)`);
	}
	return out;
}

// ─── Merged offline loader: remote < static < user file (highest priority) ───

async function mergedOfflineLoader(pricingPath?: string): Promise<Record<string, ModelPricing>> {
	const base = await loadMergedPricing();
	const userPricing = loadUserPricing(pricingPath);
	// User entries (keyed `providerId/model_id`) override base entries keyed by
	// bare model name only when the keys collide; in practice they coexist —
	// provider-aware lookup in `data-loader` queries the qualified key directly.
	return { ...base, ...userPricing };
}

// ─── Shared singleton pricing Map (keyed by pricingPath) ────────────────────

const _sharedPricingCache = new Map<string, Promise<Map<string, ModelPricing>>>();

/**
 * Get (or create) the shared singleton pricing Map for a given `pricingPath`.
 * Cached per `pricingPath` so different paths do not pollute each other.
 */
async function getSharedPricingMap(pricingPath?: string): Promise<Map<string, ModelPricing>> {
	const cacheKey = pricingPath ?? '';
	let promise = _sharedPricingCache.get(cacheKey);
	if (promise == null) {
		promise = (async () => new Map(Object.entries(await mergedOfflineLoader(pricingPath))))();
		_sharedPricingCache.set(cacheKey, promise);
	}
	return promise;
}

/**
 * Create a PricingFetcher that shares a singleton pricing Map across all instances.
 * Use this when multiple fetchers are needed in the same process (e.g. statusline).
 */
export function createSharedPricingFetcher(options?: { pricingPath?: string }): CcusagePricingFetcher {
	const pricingPath = options?.pricingPath;
	return new CcusagePricingFetcher({
		pricingPath,
		preloadedPricing: async () => getSharedPricingMap(pricingPath),
		logger,
	});
}

/**
 * Extended PricingFetcher pre-configured with merged pricing data.
 * Merges: LiteLLM remote (24h cache) < static bundled JSON < user pricing file
 * (per-platform billing-currency overrides, keyed `{providerId}/{model_id}`).
 */
export type CcusagePricingFetcherOptions = ConstructorParameters<typeof PricingFetcher>[0] & {
	pricingPath?: string;
};

export class CcusagePricingFetcher extends PricingFetcher {
	constructor(options?: CcusagePricingFetcherOptions) {
		const { pricingPath, ...rest } = options ?? {};
		super({
			offlineLoader: async () => mergedOfflineLoader(pricingPath),
			logger,
			...rest,
		});
	}

	/**
	 * Resolve pricing for a (provider, model) pair.
	 *
	 * Looks up the exact user-pricing key `{providerId}/{model_id}` first
	 * (model_id is the raw JSONL string, may itself carry a supplier `/`
	 * segment). On miss, falls back to the base {@link getModelPricing}
	 * exact/suffix/fuzzy matching (bundled USD static pricing).
	 *
	 * @param providerId - sales platform id (e.g. `bailian-aliyun-singapore`), or undefined
	 * @param modelName - raw model_id from the usage entry
	 * @returns pricing for the pair, or null if neither qualified nor base match
	 */
	async getModelPricingForProvider(providerId: string | undefined, modelName: string): Promise<Result.Result<ModelPricing | null, Error>> {
		if (providerId != null && providerId !== '') {
			const map = await Result.unwrap(this.fetchModelPricing(), new Map<string, ModelPricing>());
			const qualified = map.get(`${providerId}/${modelName}`);
			if (qualified != null) {
				return Result.succeed(qualified);
			}
		}
		return this.getModelPricing(modelName);
	}
}

if (import.meta.vitest != null) {
	const TEST_PROFILES: ProviderProfile[] = [
		{ id: 'bailian-aliyun-singapore', name: 'Aliyun_bailian-Singapore', appType: 'claude', platform: 'bailian', region: 'singapore', planType: undefined },
		{ id: 'bailian-aliyun-beijing', name: 'Aliyun_bailian-Beijing', appType: 'claude', platform: 'bailian', region: 'beijing', planType: undefined },
		{ id: 'aliyun-bailian-beijing-token-plan', name: 'Aliyun_bailian-Beijing-Token_Plan', appType: 'claude', platform: 'bailian', region: 'beijing', planType: 'token plan' },
		{ id: 'volcengine-ark-beijing-agent-plan', name: 'Volcengine_ark-Beijing-Agent_Plan', appType: 'claude', platform: 'volcengine', region: 'beijing', planType: 'agent plan' },
	];

	describe('matchProfiles', () => {
		const baseRule = { model: 'glm-5.2', inputCostPerMTokens: 1, outputCostPerMTokens: 1 };

		it('matches reseller fuzzily across Aliyun / bailian / Aliyun_bailian', () => {
			for (const reseller of ['Aliyun', 'bailian', 'Aliyun_bailian']) {
				const hits = matchProfiles({ ...baseRule, reseller }, TEST_PROFILES);
				expect(hits.map(h => h.id).sort()).toEqual([
					'aliyun-bailian-beijing-token-plan',
					'bailian-aliyun-beijing',
					'bailian-aliyun-singapore',
				]);
			}
		});

		it('filters by region when specified', () => {
			const hits = matchProfiles({ ...baseRule, reseller: 'bailian', region: 'singapore' }, TEST_PROFILES);
			expect(hits.map(h => h.id)).toEqual(['bailian-aliyun-singapore']);
		});

		it('filters by plan when specified', () => {
			const hits = matchProfiles({ ...baseRule, reseller: 'bailian', plan: 'token plan' }, TEST_PROFILES);
			expect(hits.map(h => h.id)).toEqual(['aliyun-bailian-beijing-token-plan']);
		});

		it('does not match region when profile region is undefined', () => {
			const hits = matchProfiles(
				{ ...baseRule, reseller: 'bailian', region: 'singapore' },
				[{ id: 'bailian-x', name: 'b', appType: 'claude', platform: 'bailian', region: undefined, planType: undefined }],
			);
			expect(hits).toEqual([]);
		});

		it('does not match plan when profile planType is undefined', () => {
			const hits = matchProfiles(
				{ ...baseRule, reseller: 'bailian', plan: 'saving plan' },
				[{ id: 'bailian-aliyun-singapore', name: 'Aliyun_bailian-Singapore', appType: 'claude', platform: 'bailian', region: 'singapore', planType: undefined }],
			);
			expect(hits).toEqual([]);
		});

		it('returns empty for an unknown reseller', () => {
			const hits = matchProfiles({ ...baseRule, reseller: 'NoSuchReseller' }, TEST_PROFILES);
			expect(hits).toEqual([]);
		});

		it('returns empty for an empty-string reseller', () => {
			const hits = matchProfiles({ ...baseRule, reseller: '' }, TEST_PROFILES);
			expect(hits).toEqual([]);
		});
	});

	describe('expandArrayRules', () => {
		const baseRule = { model: 'glm-5.2', inputCostPerMTokens: 1, outputCostPerMTokens: 1 };

		it('default rule covers all reseller profiles', () => {
			const out = expandArrayRules(
				[{ ...baseRule, reseller: 'bailian', currency: 'CNY', inputCostPerMTokens: 30, outputCostPerMTokens: 120 }],
				TEST_PROFILES,
			);
			expect(Object.keys(out).sort()).toEqual([
				'aliyun-bailian-beijing-token-plan/glm-5.2',
				'bailian-aliyun-beijing/glm-5.2',
				'bailian-aliyun-singapore/glm-5.2',
			]);
			expect(out['bailian-aliyun-singapore/glm-5.2']?.input_cost_per_token).toBeCloseTo(3e-5);
			expect(out['bailian-aliyun-singapore/glm-5.2']?.currency).toBe('CNY');
		});

		it('region exception overrides default for that region', () => {
			const out = expandArrayRules(
				[
					{ ...baseRule, reseller: 'bailian', inputCostPerMTokens: 30, outputCostPerMTokens: 120 },
					{ ...baseRule, reseller: 'bailian', region: 'singapore', currency: 'USD', inputCostPerMTokens: 4, outputCostPerMTokens: 15 },
				],
				TEST_PROFILES,
			);
			expect(out['bailian-aliyun-singapore/glm-5.2']?.input_cost_per_token).toBeCloseTo(4e-6);
			expect(out['bailian-aliyun-singapore/glm-5.2']?.currency).toBe('USD');
			expect(out['bailian-aliyun-beijing/glm-5.2']?.input_cost_per_token).toBeCloseTo(3e-5);
		});

		it('region+plan rule is the most specific and wins', () => {
			const out = expandArrayRules(
				[
					{ ...baseRule, reseller: 'bailian', inputCostPerMTokens: 30, outputCostPerMTokens: 120 },
					{ ...baseRule, reseller: 'bailian', region: 'beijing', inputCostPerMTokens: 25, outputCostPerMTokens: 100 },
					{ ...baseRule, reseller: 'bailian', region: 'beijing', plan: 'token plan', currency: 'CNY', inputCostPerMTokens: 18, outputCostPerMTokens: 72 },
				],
				TEST_PROFILES,
			);
			expect(out['aliyun-bailian-beijing-token-plan/glm-5.2']?.input_cost_per_token).toBeCloseTo(1.8e-5);
			expect(out['bailian-aliyun-beijing/glm-5.2']?.input_cost_per_token).toBeCloseTo(2.5e-5);
			expect(out['bailian-aliyun-singapore/glm-5.2']?.input_cost_per_token).toBeCloseTo(3e-5);
		});

		it('throws on same-specificity tie for the same providerId/model', () => {
			expect(() => expandArrayRules(
				[
					{ ...baseRule, reseller: 'bailian', inputCostPerMTokens: 30, outputCostPerMTokens: 120 },
					{ ...baseRule, reseller: 'Aliyun', inputCostPerMTokens: 28, outputCostPerMTokens: 110 },
				],
				TEST_PROFILES,
			)).toThrow(/Ambiguous pricing rules/);
		});

		it('warns and skips when reseller matches no profile', () => {
			const out = expandArrayRules(
				[{ ...baseRule, reseller: 'NoSuchReseller', inputCostPerMTokens: 1, outputCostPerMTokens: 1 }],
				TEST_PROFILES,
			);
			expect(out).toEqual({});
		});

		it('treats glm-5.2 and Zhipu/GLM-5.2 as distinct keys', () => {
			const out = expandArrayRules(
				[{ ...baseRule, reseller: 'bailian', model: 'glm-5.2', inputCostPerMTokens: 30, outputCostPerMTokens: 120 }],
				TEST_PROFILES,
			);
			expect(Object.keys(out)).toContain('bailian-aliyun-singapore/glm-5.2');
			expect(Object.keys(out)).not.toContain('bailian-aliyun-singapore/Zhipu/GLM-5.2');
		});

		it('does not throw when a lower-score tie is superseded by a higher-score rule', () => {
			// Two score-0 defaults (bailian + Aliyun both fuzzy-match all bailian profiles)
			// + score-1 region exceptions. Every key has a clear score-1 winner.
			expect(() => expandArrayRules(
				[
					{ ...baseRule, reseller: 'bailian', inputCostPerMTokens: 30, outputCostPerMTokens: 120 },
					{ ...baseRule, reseller: 'Aliyun', inputCostPerMTokens: 28, outputCostPerMTokens: 110 },
					{ ...baseRule, reseller: 'bailian', region: 'singapore', inputCostPerMTokens: 4, outputCostPerMTokens: 15 },
					{ ...baseRule, reseller: 'bailian', region: 'beijing', inputCostPerMTokens: 25, outputCostPerMTokens: 100 },
				],
				TEST_PROFILES,
			)).not.toThrow();
		});

		it('resolution is order-independent (score-1 first then score-0 tie)', () => {
			// Same rules as above but reordered — score-1 exceptions first.
			const out = expandArrayRules(
				[
					{ ...baseRule, reseller: 'bailian', region: 'singapore', inputCostPerMTokens: 4, outputCostPerMTokens: 15 },
					{ ...baseRule, reseller: 'bailian', region: 'beijing', inputCostPerMTokens: 25, outputCostPerMTokens: 100 },
					{ ...baseRule, reseller: 'bailian', inputCostPerMTokens: 30, outputCostPerMTokens: 120 },
					{ ...baseRule, reseller: 'Aliyun', inputCostPerMTokens: 28, outputCostPerMTokens: 110 },
				],
				TEST_PROFILES,
			);
			// singapore → score-1 winner (4), beijing profiles → score-1 winner (25).
			expect(out['bailian-aliyun-singapore/glm-5.2']?.input_cost_per_token).toBeCloseTo(4e-6);
			expect(out['bailian-aliyun-beijing/glm-5.2']?.input_cost_per_token).toBeCloseTo(2.5e-5);
			expect(out['aliyun-bailian-beijing-token-plan/glm-5.2']?.input_cost_per_token).toBeCloseTo(2.5e-5);
		});
	});

	describe('PricingFetcher', () => {
		it('loads pricing data successfully', async () => {
			using fetcher = new CcusagePricingFetcher();
			const pricing = await Result.unwrap(fetcher.fetchModelPricing());
			expect(pricing.size).toBeGreaterThan(0);
		});

		it('calculates cost for Claude model tokens', async () => {
			using fetcher = new CcusagePricingFetcher();
			const pricing = await Result.unwrap(fetcher.getModelPricing('claude-sonnet-4-20250514'));
			expect(pricing).not.toBeNull();
			const cost = fetcher.calculateCostFromPricing({
				input_tokens: 1000,
				output_tokens: 500,
				cache_read_input_tokens: 300,
			}, pricing!);

			expect(cost.amount).toBeGreaterThan(0);
		});

		it('calculates cost for claude-sonnet-4-5-20250929 model tokens', async () => {
			using fetcher = new CcusagePricingFetcher();
			const pricing = await Result.unwrap(fetcher.getModelPricing('claude-sonnet-4-5-20250929'));
			expect(pricing).not.toBeNull();
			const cost = fetcher.calculateCostFromPricing({
				input_tokens: 1000,
				output_tokens: 500,
				cache_read_input_tokens: 300,
			}, pricing!);

			expect(cost.amount).toBeGreaterThan(0);
		});

		it('calculates cost for GLM-4.5 model tokens', async () => {
			using fetcher = new CcusagePricingFetcher();
			const pricing = await Result.unwrap(fetcher.getModelPricing('glm-4.5'));
			expect(pricing).not.toBeNull();
			const cost = fetcher.calculateCostFromPricing({
				input_tokens: 1000,
				output_tokens: 500,
				cache_read_input_tokens: 300,
			}, pricing!);

			expect(cost.amount).toBeGreaterThan(0);
		});

		it('calculates cost for GLM-4.5 model with provider prefix', async () => {
			using fetcher = new CcusagePricingFetcher();
			const pricing = await Result.unwrap(fetcher.getModelPricing('zai/glm-4.5'));
			expect(pricing).not.toBeNull();
			const cost = fetcher.calculateCostFromPricing({
				input_tokens: 1000,
				output_tokens: 500,
				cache_read_input_tokens: 300,
			}, pricing!);

			expect(cost.amount).toBeGreaterThan(0);
		});

		it('calculates cost for GLM-4.5-Air model', async () => {
			using fetcher = new CcusagePricingFetcher();
			const pricing = await Result.unwrap(fetcher.getModelPricing('glm-4.5-air'));
			expect(pricing).not.toBeNull();
			const cost = fetcher.calculateCostFromPricing({
				input_tokens: 1000,
				output_tokens: 500,
				cache_read_input_tokens: 300,
			}, pricing!);

			expect(cost.amount).toBeGreaterThan(0);
		});
		it('calculates cost for GLM-5-Turbo model', async () => {
			using fetcher = new CcusagePricingFetcher();
			const pricing = await Result.unwrap(fetcher.getModelPricing('glm-5-turbo'));
			expect(pricing).not.toBeNull();
			const cost = fetcher.calculateCostFromPricing({
				input_tokens: 1000,
				output_tokens: 500,
				cache_read_input_tokens: 300,
			}, pricing!);

			expect(cost.amount).toBeGreaterThan(0);
		});
		it('calculates cost for GLM-5.1 model', async () => {
			using fetcher = new CcusagePricingFetcher();
			const pricing = await Result.unwrap(fetcher.getModelPricing('glm-5.1'));
			expect(pricing).not.toBeNull();
			const cost = fetcher.calculateCostFromPricing({
				input_tokens: 1000,
				output_tokens: 500,
				cache_read_input_tokens: 300,
			}, pricing!);

			expect(cost.amount).toBeGreaterThan(0);
		});
		it('calculates cost for GLM-5V-Turbo model', async () => {
			using fetcher = new CcusagePricingFetcher();
			const pricing = await Result.unwrap(fetcher.getModelPricing('glm-5v-turbo'));
			expect(pricing).not.toBeNull();
			const cost = fetcher.calculateCostFromPricing({
				input_tokens: 1000,
				output_tokens: 500,
				cache_read_input_tokens: 300,
			}, pricing!);

			expect(cost.amount).toBeGreaterThan(0);
		});

		it('shared fetchers use the same pricing Map', async () => {
			using f1 = createSharedPricingFetcher();
			using f2 = createSharedPricingFetcher();
			const p1 = await Result.unwrap(f1.fetchModelPricing());
			const p2 = await Result.unwrap(f2.fetchModelPricing());
			expect(p1).toBe(p2);
		});
	});

	describe('loadUserPricing', () => {
		it('returns empty when no file exists', () => {
			expect(loadUserPricing('/nonexistent/pricing.json')).toEqual({});
		});

		it('loads and converts user entries keyed by providerId/model_id', () => {
			const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'bcu-pricing-'));
			const filePath = path.join(tmpDir, PRICING_FILE_NAME);
			writeFileSync(filePath, JSON.stringify({
				'bailian-aliyun-singapore/glm-5.2': {
					currency: 'CNY',
					inputCostPerToken: 0.0000007,
					outputCostPerToken: 0.0000021,
				},
				'bailian-aliyun-singapore/ZHIPU/GLM-5.2': {
					currency: 'CNY',
					inputCostPerToken: 0.0000008,
					outputCostPerToken: 0.0000024,
					cacheReadInputTokenCost: 0.0000001,
				},
			}), 'utf-8');

			const loaded = loadUserPricing(filePath);
			expect(Object.keys(loaded).sort()).toEqual([
				'bailian-aliyun-singapore/ZHIPU/GLM-5.2',
				'bailian-aliyun-singapore/glm-5.2',
			]);
			expect(loaded['bailian-aliyun-singapore/glm-5.2']).toEqual({
				input_cost_per_token: 0.0000007,
				output_cost_per_token: 0.0000021,
				cache_creation_input_token_cost: undefined,
				cache_read_input_token_cost: undefined,
				currency: 'CNY',
			});
			expect(loaded['bailian-aliyun-singapore/ZHIPU/GLM-5.2']?.cache_read_input_token_cost).toBe(0.0000001);
		});

		it('drops invalid entries and keeps valid ones', () => {
			const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'bcu-pricing-'));
			const filePath = path.join(tmpDir, PRICING_FILE_NAME);
			writeFileSync(filePath, JSON.stringify({
				'prov/good': { inputCostPerToken: 1, outputCostPerToken: 2 },
				'prov/bad': { inputCostPerToken: 'not-a-number' },
			}), 'utf-8');

			const loaded = loadUserPricing(filePath);
			expect(Object.keys(loaded)).toEqual(['prov/good']);
		});

		it('defaults currency to USD when absent', () => {
			const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'bcu-pricing-'));
			const filePath = path.join(tmpDir, PRICING_FILE_NAME);
			writeFileSync(filePath, JSON.stringify({
				'prov/m': { inputCostPerToken: 1, outputCostPerToken: 2 },
			}), 'utf-8');

			const loaded = loadUserPricing(filePath);
			expect(loaded['prov/m']?.currency).toBe('USD');
		});

		it('loads array format and expands to providerId/model keys via profiles', () => {
			const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'bcu-pricing-'));
			const filePath = path.join(tmpDir, PRICING_FILE_NAME);
			writeFileSync(filePath, JSON.stringify([
				{ reseller: 'bailian', model: 'glm-5.2', currency: 'CNY', inputCostPerMTokens: 30, outputCostPerMTokens: 120 },
				{ reseller: 'bailian', region: 'singapore', model: 'glm-5.2', currency: 'USD', inputCostPerMTokens: 4, outputCostPerMTokens: 15 },
			]), 'utf-8');

			const profiles: ProviderProfile[] = [
				{ id: 'bailian-aliyun-singapore', name: 'Aliyun_bailian-Singapore', appType: 'claude', platform: 'bailian', region: 'singapore', planType: undefined },
				{ id: 'bailian-aliyun-beijing', name: 'Aliyun_bailian-Beijing', appType: 'claude', platform: 'bailian', region: 'beijing', planType: undefined },
			];
			const loaded = loadUserPricing(filePath, profiles);
			expect(loaded['bailian-aliyun-singapore/glm-5.2']?.input_cost_per_token).toBeCloseTo(4e-6);
			expect(loaded['bailian-aliyun-singapore/glm-5.2']?.currency).toBe('USD');
			expect(loaded['bailian-aliyun-beijing/glm-5.2']?.input_cost_per_token).toBeCloseTo(3e-5);
			expect(loaded['bailian-aliyun-beijing/glm-5.2']?.currency).toBe('CNY');
		});

		it('array format degrades to empty when profiles not provided', () => {
			const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'bcu-pricing-'));
			const filePath = path.join(tmpDir, PRICING_FILE_NAME);
			writeFileSync(filePath, JSON.stringify([
				{ reseller: 'bailian', model: 'glm-5.2', inputCostPerMTokens: 30, outputCostPerMTokens: 120 },
			]), 'utf-8');
			// No profiles passed → no matches → empty (warns).
			const loaded = loadUserPricing(filePath);
			expect(loaded).toEqual({});
		});
	});

	describe('toModelPricingFromPerM', () => {
		it('schema parses valid array entries with optional fields omitted', () => {
			const result = v.safeParse(userPricingArrayEntrySchema, {
				reseller: 'bailian',
				model: 'glm-5.2',
				inputCostPerMTokens: 30,
				outputCostPerMTokens: 120,
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.output.reseller).toBe('bailian');
				expect(result.output.region).toBeUndefined();
				expect(result.output.cacheCreationCostPerMTokens).toBeUndefined();
			}
		});

		it('converts per-M token prices to per-token and defaults currency to USD', () => {
			const mp = toModelPricingFromPerM({
				reseller: 'bailian',
				model: 'glm-5.2',
				inputCostPerMTokens: 30,
				outputCostPerMTokens: 120,
				cacheCreationCostPerMTokens: 35,
				cacheReadCostPerMTokens: 3,
			});
			expect(mp.input_cost_per_token).toBeCloseTo(3e-5);
			expect(mp.output_cost_per_token).toBeCloseTo(1.2e-4);
			expect(mp.cache_creation_input_token_cost).toBeCloseTo(3.5e-5);
			expect(mp.cache_read_input_token_cost).toBeCloseTo(3e-6);
			expect(mp.currency).toBe('USD');
		});

		it('uses explicit currency and leaves optional cache costs undefined', () => {
			const mp = toModelPricingFromPerM({
				reseller: 'bailian',
				model: 'glm-5.2',
				currency: 'CNY',
				inputCostPerMTokens: 30,
				outputCostPerMTokens: 120,
			});
			expect(mp.currency).toBe('CNY');
			expect(mp.cache_creation_input_token_cost).toBeUndefined();
			expect(mp.cache_read_input_token_cost).toBeUndefined();
		});
	});

	describe('CcusagePricingFetcher user-pricing merge', () => {
		it('exposes user entry via qualified-key lookup', async () => {
			const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'bcu-pricing-'));
			const filePath = path.join(tmpDir, PRICING_FILE_NAME);
			writeFileSync(filePath, JSON.stringify({
				'bailian-aliyun-singapore/test-merge-model': {
					currency: 'CNY',
					inputCostPerToken: 0.000001,
					outputCostPerToken: 0.000003,
				},
			}), 'utf-8');

			using fetcher = new CcusagePricingFetcher({ pricingPath: filePath });
			const map = await Result.unwrap(fetcher.fetchModelPricing());
			const entry = map.get('bailian-aliyun-singapore/test-merge-model');
			expect(entry).not.toBeUndefined();
			expect(entry?.currency).toBe('CNY');
			expect(entry?.input_cost_per_token).toBe(0.000001);
		});
	});
}
