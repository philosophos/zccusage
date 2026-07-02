# Structured Pricing Input Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users define per-(reseller, model) custom pricing via a structured array format in `better-ccusage-pricing.json`, with `region`/`plan` as optional specificity overrides, prices entered per-million tokens in a chosen currency.

**Architecture:** All work in `apps/zccusage/src/_pricing-fetcher.ts`. New pure helpers (`toModelPricingFromPerM`, `matchProfiles`, `expandArrayRules`) convert array rules into the existing `{providerId}/{model_id}` → `ModelPricing` map. `loadUserPricing` gains an optional `profiles` param and branches on `Array.isArray`. `mergedOfflineLoader` loads provider profiles + applies schedule planType overrides before calling `loadUserPricing`. Downstream (`getModelPricingForProvider`, `calculateProviderAwareCost`, all commands) unchanged.

**Tech Stack:** TypeScript, valibot, vitest (in-source, globals enabled, `.ts` imports, no `await import()`), `@praha/byethrow` Result type (not needed here — pure sync helpers).

**Spec:** `docs/superpowers/specs/2026-07-02-structured-pricing-input-design.md`

---

## File Structure

**Modify only:** `apps/zccusage/src/_pricing-fetcher.ts`

New internal (non-exported) helpers added in this file:
- `userPricingArrayEntrySchema` + `UserPricingArrayEntry` (exported type)
- `toModelPricingFromPerM(entry)` — per-M → per-token conversion
- `matchProfiles(rule, profiles)` — fuzzy reseller + exact region/plan
- `specificityScore(rule)` — 0/1/2
- `expandArrayRules(rules, profiles)` — specificity resolution + conflict throw

Modified:
- `userPricingFileSchema` → `union(array, record)`
- `loadUserPricing(pricingPath?, profiles?)` — adds profiles param + array branch
- `mergedOfflineLoader` — loads profiles + schedule overrides, passes to `loadUserPricing`

**No changes to:** `getModelPricingForProvider`, `CcusagePricingFetcher`, `calculateProviderAwareCost`, `calculateCostForEntry`, any command file, `_types.ts`.

### Key facts (verified, do not re-verify)

- `ProviderProfile` (from `./_types.ts`): required fields `id`, `name`, `appType`; optional `platform`, `region`, `planType`, `baseUrl`, `isCurrent`, etc.
- `loadProviderProfiles({})` returns `ProviderProfile[]` from cc-switch.db; `[]` if DB missing. Async.
- `loadProviderSchedule()` returns `ProviderScheduleEntry[]` (sync, from `provider_schedule.json`).
- `buildPlanOverrides(schedule)` returns `Map<providerId, planType>` (sync).
- Profile `planType` is id-derived (`derivePlanType`): `bailian-aliyun-singapore` → `undefined`; `aliyun-bailian-beijing-token-plan` → `'token plan'`. Schedule override sets saving plan etc. for ids with no plan token.
- `DEFAULT_BILLING_CURRENCY` is `'USD'` (from `./_consts.ts`).
- `ModelPricing` (from `@better-ccusage/internal/pricing`): `{ input_cost_per_token, output_cost_per_token, cache_creation_input_token_cost?, cache_read_input_token_cost?, currency? }`.
- In-source tests use vitest globals (`describe`, `it`, `expect`) — no imports. Tests access non-exported helpers in the same file.

### Test profile fixture (reused across tasks)

All tests for `matchProfiles` / `expandArrayRules` use this literal array (no DB access):

```ts
const TEST_PROFILES: ProviderProfile[] = [
  { id: 'bailian-aliyun-singapore', name: 'Aliyun_bailian-Singapore', appType: 'claude', platform: 'bailian', region: 'singapore', planType: undefined },
  { id: 'bailian-aliyun-beijing', name: 'Aliyun_bailian-Beijing', appType: 'claude', platform: 'bailian', region: 'beijing', planType: undefined },
  { id: 'aliyun-bailian-beijing-token-plan', name: 'Aliyun_bailian-Beijing-Token_Plan', appType: 'claude', platform: 'bailian', region: 'beijing', planType: 'token plan' },
  { id: 'volcengine-ark-beijing-agent-plan', name: 'Volcengine_ark-Beijing-Agent_Plan', appType: 'claude', platform: 'volcengine', region: 'beijing', planType: 'agent plan' },
];
```

`ProviderProfile` import added in Task 5; for Tasks 1-3 tests, add the import at top of file in Task 1 (type-only, harmless early).

---

### Task 1: Array entry schema + per-M → per-token conversion

**Files:**
- Modify: `apps/zccusage/src/_pricing-fetcher.ts` (add schema/type/helper near line 35, after `userPricingFileSchema`)
- Test: same file, in the `if (import.meta.vitest != null)` block

- [ ] **Step 1: Add type-only import for ProviderProfile at top**

In `apps/zccusage/src/_pricing-fetcher.ts`, change line 1 to also import `ProviderProfile` (needed for test fixture + later tasks; type-only so no runtime cost):

```ts
import type { ModelPricing } from '@better-ccusage/internal/pricing';
import type { ProviderProfile } from './_types.ts';
```

- [ ] **Step 2: Add schema, type, and helper after `userPricingFileSchema` (line 35)**

Insert after line 35 (`const userPricingFileSchema = v.record(...)`):

```ts
/**
 * A single structured pricing rule (new array format). Prices are per-million
 * tokens in the chosen currency. `region`/`plan` are optional specificity
 * overrides; omit them for a default that covers all the reseller's regions/plans.
 */
const userPricingArrayEntrySchema = v.object({
	reseller: v.string(),
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
```

- [ ] **Step 3: Write the failing test**

In the `if (import.meta.vitest != null)` block, add a new `describe('toModelPricingFromPerM', ...)` block (after the existing `describe('loadUserPricing', ...)` block, before the closing `}` of the vitest block — around line 404):

```ts
describe('toModelPricingFromPerM', () => {
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/zccusage && pnpm vitest run src/_pricing-fetcher.ts`
Expected: PASS (2 new tests + existing tests). The helper already exists from Step 2.

- [ ] **Step 5: Commit**

```bash
rtk git add apps/zccusage/src/_pricing-fetcher.ts
rtk git commit -m "feat(zccusage): add array pricing entry schema + per-M→per-token converter"
```

---

### Task 2: `matchProfiles` — fuzzy reseller + exact region/plan

**Files:**
- Modify: `apps/zccusage/src/_pricing-fetcher.ts` (add helper after `toModelPricingFromPerM`)
- Test: same file

- [ ] **Step 1: Write the failing test**

In the vitest block, add `describe('matchProfiles', ...)` (uses `TEST_PROFILES` fixture defined above — add the fixture at the top of the vitest block, right after `if (import.meta.vitest != null) {`):

```ts
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/zccusage && pnpm vitest run src/_pricing-fetcher.ts`
Expected: FAIL — `matchProfiles is not defined`.

- [ ] **Step 3: Implement `matchProfiles`**

Add after `toModelPricingFromPerM`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/zccusage && pnpm vitest run src/_pricing-fetcher.ts`
Expected: PASS (6 new tests).

- [ ] **Step 5: Commit**

```bash
rtk git add apps/zccusage/src/_pricing-fetcher.ts
rtk git commit -m "feat(zccusage): add matchProfiles (fuzzy reseller + exact region/plan)"
```

---

### Task 3: `expandArrayRules` — specificity resolution + conflict detection

**Files:**
- Modify: `apps/zccusage/src/_pricing-fetcher.ts` (add `specificityScore` + `expandArrayRules` after `matchProfiles`)
- Test: same file

- [ ] **Step 1: Write the failing test**

In the vitest block, add `describe('expandArrayRules', ...)`:

```ts
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/zccusage && pnpm vitest run src/_pricing-fetcher.ts`
Expected: FAIL — `expandArrayRules is not defined`.

- [ ] **Step 3: Implement `specificityScore` + `expandArrayRules`**

Add after `matchProfiles`:

```ts
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
 * no profile are warned and skipped.
 */
function expandArrayRules(
	rules: UserPricingArrayEntry[],
	profiles: ProviderProfile[],
): Record<string, ModelPricing> {
	const bestByKey = new Map<string, { rule: UserPricingArrayEntry; pricing: ModelPricing }>();
	const conflicts: { key: string; rules: UserPricingArrayEntry[] }[] = [];

	for (const rule of rules) {
		const hits = matchProfiles(rule, profiles);
		if (hits.length === 0) {
			logger.warn(`Pricing rule for reseller "${rule.reseller}" matched no provider profile; skipped`);
			continue;
		}
		const pricing = toModelPricingFromPerM(rule);
		for (const p of hits) {
			const key = `${p.id}/${rule.model}`;
			const prev = bestByKey.get(key);
			if (prev == null) {
				bestByKey.set(key, { rule, pricing });
				continue;
			}
			const prevScore = specificityScore(prev.rule);
			const curScore = specificityScore(rule);
			if (curScore > prevScore) {
				bestByKey.set(key, { rule, pricing });
			}
			else if (curScore === prevScore) {
				conflicts.push({ key, rules: [prev.rule, rule] });
			}
		}
	}

	if (conflicts.length > 0) {
		const lines = conflicts.map((c) => {
			const desc = c.rules.map(r => JSON.stringify({ reseller: r.reseller, region: r.region, plan: r.plan, model: r.model })).join(' vs ');
			return `  ${c.key}: ${desc}`;
		});
		throw new Error(`Ambiguous pricing rules (same specificity match same providerId/model):\n${lines.join('\n')}`);
	}

	const out: Record<string, ModelPricing> = {};
	for (const [key, { pricing }] of bestByKey) {
		out[key] = pricing;
	}
	return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/zccusage && pnpm vitest run src/_pricing-fetcher.ts`
Expected: PASS (6 new tests).

- [ ] **Step 5: Commit**

```bash
rtk git add apps/zccusage/src/_pricing-fetcher.ts
rtk git commit -m "feat(zccusage): add expandArrayRules (specificity resolution + conflict throw)"
```

---

### Task 4: Wire array format into `loadUserPricing`

**Files:**
- Modify: `apps/zccusage/src/_pricing-fetcher.ts` (`loadUserPricing` signature + body, around line 86-140)
- Test: same file

- [ ] **Step 1: Write the failing test**

In the `describe('loadUserPricing', ...)` block, add (after the existing `'defaults currency to USD when absent'` test):

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/zccusage && pnpm vitest run src/_pricing-fetcher.ts`
Expected: FAIL — array format not parsed (old record schema rejects arrays), or `profiles` param not accepted.

- [ ] **Step 3: Modify `loadUserPricing` signature + body**

Replace the existing `loadUserPricing` function (lines 86-140) with:

```ts
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
```

Note: `userPricingFileSchema` stays as `v.record(...)` — the array branch is handled before it. The union is structural (Array.isArray check), not via valibot union, to keep the fallback paths simple.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/zccusage && pnpm vitest run src/_pricing-fetcher.ts`
Expected: PASS (2 new + all existing `loadUserPricing` tests still pass — old format unchanged).

- [ ] **Step 5: Commit**

```bash
rtk git add apps/zccusage/src/_pricing-fetcher.ts
rtk git commit -m "feat(zccusage): wire array pricing format into loadUserPricing"
```

---

### Task 5: Load profiles + schedule overrides in `mergedOfflineLoader`

**Files:**
- Modify: `apps/zccusage/src/_pricing-fetcher.ts` (imports + `mergedOfflineLoader` body, around line 144-151)
- Test: same file

- [ ] **Step 1: Add imports for profile loading**

In `apps/zccusage/src/_pricing-fetcher.ts`, after the existing `./_consts.ts` and `./data-loader.ts` imports (around line 10-12), add:

```ts
import type { PlanType, ProviderProfile } from './_types.ts';
import { buildPlanOverrides, loadProviderProfiles, loadProviderSchedule } from './_provider-profile-loader.ts';
```

(Remove the type-only `ProviderProfile` import added in Task 1 if it conflicts — `PlanType` joins it. Final import block has both `type` and value imports from `_provider-profile-loader.ts` and `_types.ts`.)

- [ ] **Step 2: Write the failing test**

In the vitest block, add `describe('mergedOfflineLoader', ...)`:

```ts
describe('mergedOfflineLoader', () => {
	it('expands array-format user pricing using loaded profiles', async () => {
		const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'bcu-pricing-'));
		const filePath = path.join(tmpDir, PRICING_FILE_NAME);
		writeFileSync(filePath, JSON.stringify([
			{ reseller: 'bailian', model: 'glm-5.2', currency: 'CNY', inputCostPerMTokens: 30, outputCostPerMTokens: 120 },
		]), 'utf-8');

		const map = await mergedOfflineLoader(filePath);
		// Array format expands to qualified keys for every bailian profile in the
		// real cc-switch.db (or empty if DB missing — either way no throw).
		expect(map).toBeDefined();
	});
});
```

Note: This test only asserts no-throw + returns a map; real cc-switch.db presence varies by machine. The matching correctness is already covered by Tasks 2-4 with explicit profile fixtures.

- [ ] **Step 3: Run test to verify it fails (or passes trivially)**

Run: `cd apps/zccusage && pnpm vitest run src/_pricing-fetcher.ts`
Expected: May pass trivially (current `mergedOfflineLoader` returns a map). The test is a smoke test for the new wiring; the real verification is the manual e2e in Task 6.

- [ ] **Step 4: Modify `mergedOfflineLoader` to load profiles + schedule overrides**

Replace the existing `mergedOfflineLoader` (lines 144-151) with:

```ts
async function mergedOfflineLoader(pricingPath?: string): Promise<Record<string, ModelPricing>> {
	const base = await loadMergedPricing();
	const profiles = await loadProviderProfiles({});
	// Apply schedule planType overrides so `plan` matching sees e.g. saving plan
	// for provider ids that carry no plan token (bailian-aliyun-singapore).
	const planOverrides = buildPlanOverrides(loadProviderSchedule());
	for (const p of profiles) {
		const ov = planOverrides.get(p.id);
		if (ov != null) {
			p.planType = ov as PlanType | undefined;
		}
	}
	const userPricing = loadUserPricing(pricingPath, profiles);
	// User entries (keyed `providerId/model_id`) override base entries keyed by
	// bare model name only when the keys collide; in practice they coexist —
	// provider-aware lookup in `data-loader` queries the qualified key directly.
	return { ...base, ...userPricing };
}
```

- [ ] **Step 5: Run all pricing tests to verify nothing broke**

Run: `cd apps/zccusage && pnpm vitest run src/_pricing-fetcher.ts`
Expected: PASS (all tests, including existing `CcusagePricingFetcher user-pricing merge` block which uses old record format — still works).

- [ ] **Step 6: Commit**

```bash
rtk git add apps/zccusage/src/_pricing-fetcher.ts
rtk git commit -m "feat(zccusage): load provider profiles + schedule overrides in mergedOfflineLoader"
```

---

### Task 6: Full verification + manual e2e

**Files:**
- None modified (verification only)

- [ ] **Step 1: Run typecheck**

Run: `cd apps/zccusage && pnpm typecheck`
Expected: PASS, no errors.

- [ ] **Step 2: Run format**

Run: `cd apps/zccusage && pnpm run format`
Expected: files formatted (may show no-op if already clean).

- [ ] **Step 3: Run full test suite**

Run: `cd apps/zccusage && pnpm vitest run`
Expected: PASS (all tests, 408+ passing).

- [ ] **Step 4: Manual e2e — array format with region exception**

Create `apps/zccusage/better-ccusage-pricing.json`:

```json
[
  {
    "reseller": "Aliyun",
    "model": "glm-5.2",
    "currency": "CNY",
    "inputCostPerMTokens": 30,
    "outputCostPerMTokens": 120,
    "cacheCreationCostPerMTokens": 35,
    "cacheReadCostPerMTokens": 3
  },
  {
    "reseller": "Aliyun",
    "region": "singapore",
    "model": "glm-5.2",
    "currency": "USD",
    "inputCostPerMTokens": 4,
    "outputCostPerMTokens": 15
  }
]
```

Run (from repo root):
```bash
cd apps/zccusage && ./src/index.ts -f tree --group agent,reseller,region,plan,model,monthly --pricing-path ./better-ccusage-pricing.json
```
Expected: tree renders; singapore provider costs in USD, beijing providers in CNY.

- [ ] **Step 5: Manual e2e — old format still works**

Replace the file content with old key-value format:

```json
{
  "bailian-aliyun-singapore/glm-5.2": {
    "currency": "CNY",
    "inputCostPerToken": 0.00003,
    "outputCostPerToken": 0.00012
  }
}
```

Run:
```bash
cd apps/zccusage && ./src/index.ts monthly --pricing-path ./better-ccusage-pricing.json
```
Expected: monthly table renders, no errors (backward compatible).

- [ ] **Step 6: Manual e2e — ambiguity error**

Create a file with two same-specificity rules:

```json
[
  { "reseller": "bailian", "model": "glm-5.2", "inputCostPerMTokens": 30, "outputCostPerMTokens": 120 },
  { "reseller": "Aliyun", "model": "glm-5.2", "inputCostPerMTokens": 28, "outputCostPerMTokens": 110 }
]
```

Run:
```bash
cd apps/zccusage && ./src/index.ts monthly --pricing-path ./better-ccusage-pricing.json
```
Expected: error mentioning `Ambiguous pricing rules` and listing both rules + the conflicting `providerId/model` key.

- [ ] **Step 7: Clean up e2e artifacts**

Move the test file out of the repo:
```bash
mv apps/zccusage/better-ccusage-pricing.json /tmp/better-ccusage-pricing.json
```

- [ ] **Step 8: Final commit if any formatting changed**

```bash
rtk git status
# if _pricing-fetcher.ts changed from format:
rtk git add apps/zccusage/src/_pricing-fetcher.ts
rtk git commit -m "style(zccusage): format _pricing-fetcher"
```

---

## Self-Review Checklist (completed)

**1. Spec coverage:**
- Array format input → Task 1 (schema), Task 4 (load)
- Old format compatibility → Task 4 (record branch unchanged), Task 6 Step 5
- reseller fuzzy match → Task 2
- model verbatim (producer distinct) → Task 3 test `treats glm-5.2 and Zhipu/GLM-5.2 as distinct keys`
- region/plan optional specificity → Task 3 (specificity tests)
- per-M → per-token → Task 1
- currency default + explicit → Task 1 test
- specificity wins + tie error → Task 3
- unmatched reseller warn → Task 3 test
- profile load failure degrades → Task 4 test `array format degrades to empty when profiles not provided`
- schedule planType override applied → Task 5

**2. Placeholder scan:** None. All code blocks complete.

**3. Type consistency:**
- `UserPricingArrayEntry` — defined Task 1, used Tasks 2/3/4. ✓
- `toModelPricingFromPerM` — defined Task 1, used Task 3. ✓
- `matchProfiles(rule, profiles)` — defined Task 2, used Task 3. ✓
- `expandArrayRules(rules, profiles)` — defined Task 3, used Task 4. ✓
- `loadUserPricing(pricingPath?, profiles?)` — defined Task 4, used Task 5. ✓
- `ProviderProfile` import — Task 1 (type) + Task 5 (consolidated with value imports). Note: Task 5 Step 1 says to consolidate; if Task 1 already added `import type { ProviderProfile }`, Task 5 replaces it with the full `import type { PlanType, ProviderProfile }` + value import. No duplicate. ✓
