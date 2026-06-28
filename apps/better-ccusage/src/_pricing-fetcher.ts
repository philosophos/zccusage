import type { ModelPricing } from '@better-ccusage/internal/pricing';
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
 * Returns an empty object if no file is found or the file is malformed
 * (malformed entries are skipped silently with a warning). Keys are preserved
 * verbatim from the file (`{providerId}/{model_id}`).
 */
export function loadUserPricing(pricingPath?: string): Record<string, ModelPricing> {
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
		logger.warn(`User pricing file ${filePath}: expected an object`);
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
}

if (import.meta.vitest != null) {
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
