# Structured Pricing Input Design

**Date:** 2026-07-02
**Scope:** `apps/zccusage/src/_pricing-fetcher.ts` (+ tests, no downstream changes)
**Branch:** `feature/multi-currency`

## Goal

Let users define per-(reseller, model) custom pricing in a human-friendly structured format, with `region`/`plan` as optional specificity overrides. Prices are entered per-million tokens in a chosen currency (e.g. CNY/百万 token). The structured rules are resolved to the existing `{providerId}/{model_id}` pricing map at load time, so downstream cost calculation (`getModelPricingForProvider`, `calculateProviderAwareCost`) needs zero changes.

## Background (verified facts)

- Custom pricing mechanism **already exists**:
  - File `better-ccusage-pricing.json`, key = `{providerId}/{model_id}`, value = `ModelPricing` (per-token).
  - `loadUserPricing(pricingPath)` loads the file (`_pricing-fetcher.ts:86`).
  - `mergedOfflineLoader` merges `remote < static < user` (`_pricing-fetcher.ts:144`).
  - `CcusagePricingFetcher.getModelPricingForProvider(providerId, modelName)` looks up `{providerId}/{model}` first, falls back to static USD (`_pricing-fetcher.ts:215`).
  - `calculateProviderAwareCost` already uses it (`data-loader.ts:766`).
  - `ModelPricing` schema already has `currency` field (`packages/internal/src/pricing.ts:61`).
  - CLI arg `--pricing-path` already exists (`_shared-args.ts:151`).
- `providerId` encodes reseller + region (e.g. `bailian-aliyun-singapore`) but **not plan**. Plan comes from `derivePlanType(id)` or schedule `planType` override.
- `loadProviderProfiles({ ccSwitchDbPath, allAppTypes })` loads all profiles from cc-switch.db (10 providers confirmed, each with `platform`, `region`, `planType?`, `isCurrent?`).

### Verified provider inventory (cc-switch.db `providers` table)

| providerId | platform (reseller) | region | planType (derived) |
|---|---|---|---|
| `claude-official` | anthropic | — | — |
| `bailian-aliyun-singapore` | bailian | singapore | — (saving plan via schedule) |
| `bailian-aliyun-beijing` | bailian | beijing | — |
| `aliyun-bailian-beijing-token-plan` | bailian | beijing | token plan |
| `volcengine-ark-beijing-agent-plan` | volcengine | beijing | agent plan |
| `poe-philosophos` | poe | — | — |

### Out of scope (explicit non-goals)

- **Plan pricing engine** (Saving plan tiered discounts, Token plan credit conversion, Agent plan AFP conversion) — deferred to a separate spec. Plan is only a *disambiguator* here.
- **Per-request base_url attribution** — session JSONL has no base_url (confirmed by grep + `_types.ts:320` comment). Attribution stays on the existing 4-layer chain (schedule → watcher history → is_current → undefined, by timestamp).
- **`glm-5.2` vs `Zhipu/GLM-5.2` auto-merge** — these are distinct JSONL `message.model` strings and stay distinct pricing keys (different channels, different prices).

## Design

### 1. Input format

`better-ccusage-pricing.json` — two formats auto-detected via `Array.isArray`:

**New format (array of structured rules):**

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
    "model": "Zhipu/GLM-5.2",
    "currency": "CNY",
    "inputCostPerMTokens": 28,
    "outputCostPerMTokens": 110
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

**Old format (key-value, unchanged, backward compatible):**

```json
{
  "bailian-aliyun-singapore/glm-5.2": {
    "currency": "CNY",
    "inputCostPerToken": 3e-5,
    "outputCostPerToken": 1.2e-4
  }
}
```

### 2. Array entry schema

```ts
const userPricingArrayEntrySchema = v.object({
  reseller: v.string(),                              // required, fuzzy match
  model: v.string(),                                 // required, verbatim JSONL message.model
  region: v.optional(v.string()),                    // optional exception
  plan: v.optional(v.string()),                      // optional exception, disambiguator only
  currency: v.optional(v.string()),                  // default DEFAULT_BILLING_CURRENCY
  inputCostPerMTokens: v.number(),                   // required, per-million
  outputCostPerMTokens: v.number(),                  // required, per-million
  cacheCreationCostPerMTokens: v.optional(v.number()),  // optional
  cacheReadCostPerMTokens: v.optional(v.number()),      // optional
});
export type UserPricingArrayEntry = v.InferOutput<typeof userPricingArrayEntrySchema>;

const userPricingFileSchema = v.union([
  v.array(userPricingArrayEntrySchema),   // new format
  v.record(v.string(), userPricingEntrySchema),  // old format (unchanged)
]);
```

### 3. Field semantics

**`reseller` (fuzzy match):**

For each loaded `ProviderProfile`, build the candidate set:
```
candidates = { profile.platform, ...profile.id.split('-'), profile.name }
             .map(s => s.toLowerCase())
             .filter(s => s !== '')
```

A rule's `reseller` value `R` (lowercased) matches a profile iff:
```
∃ c ∈ candidates: c.includes(R) || R.includes(c)
```

This bidirectional substring match lets `Aliyun`, `bailian`, `Aliyun_bailian` all match `bailian-aliyun-singapore` (platform=`bailian`, name contains `Aliyun_bailian`).

**`model` (verbatim):**

Copied verbatim into the `{providerId}/{model}` key. No normalization. `glm-5.2` and `Zhipu/GLM-5.2` produce different keys and must be priced separately (different channels).

**`region` (optional, exact):**

- If provided → must match `profile.region?.toLowerCase()` exactly. A profile with `region === undefined` does **not** match a rule that specifies `region`.
- If omitted → matches any region (including `undefined`).

**`plan` (optional, exact, disambiguator only):**

- If provided → must match `profile.planType?.toLowerCase()` exactly. A profile with `planType === undefined` does **not** match a rule that specifies `plan`.
- If omitted → matches any planType, including `undefined`.
- Does **not** affect pricing math — this spec has no plan tier/discount engine.

**`currency`:**

Stored verbatim into `ModelPricing.currency`. Defaults to `DEFAULT_BILLING_CURRENCY` when absent.

### 4. Matching logic (specificity wins)

For each array rule, find all matching profiles. For each matched profile, generate a `{providerId}/{model}` key.

When multiple rules produce the **same** `(providerId, model)` key, resolve by specificity:

```
score = (region provided ? 1 : 0) + (plan provided ? 1 : 0)
```

- Keep the rule with the highest `score`.
- If two or more rules tie at the highest score → **throw an error** listing the conflicting rules and the target key (do not silently pick one).

Effect:
- `{Aliyun, glm-5.2, 30 CNY}` matches all bailian providers → all three get 30 CNY.
- `{Aliyun, region:singapore, glm-5.2, 4 USD}` overrides singapore to 4 USD (score 1 > 0).
- `{Aliyun, plan:token plan, glm-5.2, 20}` overrides beijing-token-plan to 20 (score 1).
- `{Aliyun, region:beijing, plan:token plan, glm-5.2, 18}` would override beijing-token-plan to 18 (score 2).

### 5. Unit conversion

Input is per-million tokens (e.g. `30` = 30 CNY per million tokens). Loader internally divides by `1_000_000` to get per-token (`3e-5`) matching existing `ModelPricing.input_cost_per_token`.

```ts
function toModelPricingFromPerM(entry: UserPricingArrayEntry): ModelPricing {
  const M = 1_000_000;
  return {
    input_cost_per_token: entry.inputCostPerMTokens / M,
    output_cost_per_token: entry.outputCostPerMTokens / M,
    cache_creation_input_token_cost: entry.cacheCreationCostPerMTokens != null
      ? entry.cacheCreationCostPerMTokens / M : undefined,
    cache_read_input_token_cost: entry.cacheReadCostPerMTokens != null
      ? entry.cacheReadCostPerMTokens / M : undefined,
    currency: entry.currency ?? DEFAULT_BILLING_CURRENCY,
  };
}
```

### 6. Error handling

| Condition | Behavior |
|---|---|
| Rule's `reseller` matches no profile | `logger.warn` (likely typo or unregistered provider), skip rule |
| Same `(providerId, model)` highest-score tie across rules | **throw error** listing conflicting rules + target key |
| `loadProviderProfiles` fails (cc-switch.db missing) | Array format degrades to structure-only validation (no expansion), `logger.warn`, does not block |
| Old format entry fails `userPricingEntrySchema` | Per-entry skip with warn (existing behavior) |
| New format entry fails `userPricingArrayEntrySchema` | Whole-file fall back to per-entry validation, drop invalid (mirror old format's lenient path) |

### 7. Changes

**`apps/zccusage/src/_pricing-fetcher.ts`:**

- Add `userPricingArrayEntrySchema` + `UserPricingArrayEntry` type.
- Change `userPricingFileSchema` to `union(array, record)`.
- Add `matchProfiles(rule, profiles): ProviderProfile[]` — fuzzy reseller + optional region/plan.
- Add `expandArrayRules(rules, profiles): Record<string, ModelPricing>` — specificity resolution + per-M→per-token + conflict error.
- Change `loadUserPricing(pricingPath?, profiles?)` — accept profiles, branch on format type.
- Change `mergedOfflineLoader` — `await loadProviderProfiles({})` and pass to `loadUserPricing`.
- Keep `toModelPricing` (old format) unchanged; add `toModelPricingFromPerM` (new format).
- Change `getModelPricingForProvider` — replace `Result.unwrap(this.fetchModelPricing(), new Map())` (which silently swallowed loader errors) with an explicit `isFailure` check that `logger.error`s the underlying cause (unwrapped from the base fetcher's "Failed to load pricing data" wrapper via `error.cause`) before falling back to static pricing. This surfaces ambiguity/config errors to the user instead of silently producing USD numbers.

**No changes** to:
- `CcusagePricingFetcher` constructor, `calculateProviderAwareCost`, `calculateCostForEntry`, all command files.

### 8. Tests (`if (import.meta.vitest != null)` block in `_pricing-fetcher.ts`)

1. **Specificity — default + region exception**: rule `{Aliyun, glm-5.2, 30}` + rule `{Aliyun, region:singapore, glm-5.2, 4}` → singapore provider gets 4 USD, beijing/beijing-token-plan get 30 CNY.
2. **Specificity — plan exception**: rule + `{Aliyun, plan:token plan, glm-5.2, 20}` → beijing-token-plan gets 20.
3. **Specificity — region+plan most specific**: region+plan rule beats region-only and plan-only.
4. **Ambiguity error**: two rules at same top score for same `(providerId, model)` → throws with both rules in message.
5. **Reseller fuzzy**: `Aliyun`, `bailian`, `Aliyun_bailian` each match the same set of bailian profiles.
6. **Model producer distinct**: `glm-5.2` and `Zhipu/GLM-5.2` produce two separate keys, both resolved.
7. **Per-M→per-token**: `inputCostPerMTokens: 30` → `input_cost_per_token: 3e-5`.
8. **Currency default + explicit**: absent → `DEFAULT_BILLING_CURRENCY`; present → stored verbatim.
9. **Old format compatibility**: key-value file still loads via `userPricingEntrySchema` (per-token), produces same map as before.
10. **Profile load failure degradation**: `profiles=[]` (simulated cc-switch.db missing) → array format warns, returns `{}` (no expansion), does not throw.
11. **Unmatched reseller warn**: rule `{UnknownReseller, glm-5.2}` matches no profile → warn, rule skipped, no key generated.

## Verification

1. `pnpm typecheck` passes.
2. `pnpm run test` — new + existing pricing tests pass.
3. `pnpm run format`.
4. Manual end-to-end (in `apps/zccusage`):
   - Create `better-ccusage-pricing.json` with array format (default + region exception + plan exception).
   - `./src/index.ts -f tree --group agent,reseller,region,plan,model,monthly --pricing-path ./better-ccusage-pricing.json` → tree shows per-provider pricing in chosen currencies.
   - Old key-value file still works: `./src/index.ts monthly --pricing-path ./old-format.json`.
   - Ambiguity error: two same-score rules → CLI reports conflicting rules.
