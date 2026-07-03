# Update Docs for New Features — Design Spec

- **Date**: 2026-06-30
- **Status**: Written — pending user review
- **Scope**: Documentation only (no code changes)

## Background

A series of completed features have landed in `apps/zccusage` without corresponding user-facing guide documentation:

- Structured pricing input (`zccusage-pricing.json` array format) — commits `e315037`..`81a64ae`
- DuckDB OLAP integration — commits `75cb0a7`, `cb0ad6a`
- `tree-table` output format + `--group` unification — commits `3d97ea0`, `7177d46`
- Grayscale rendering + billing currency behavior — commits `68476bd`, `74be98a`, `9623a05`

A scan of `docs/guide/` (22 files) confirms none mention `zccusage-pricing`, `DuckDB`, `tree-table`, or `grayscale`. The existing `cli-options.md` Output Format section (line 24) covers only `--json`/`--breakdown`; `config-files.md` File Locations (line 83) lists only `zccusage.json`; `cost-modes.md` lacks any billing-display behavior section.

> **Out of scope by user decision**: better-ccusage rename residue cleanup (incl. broken `README.md`/`LICENSE` symlinks pointing at `apps/better-ccusage/`). That is tracked separately.

## Goal

Add user-facing guide documentation for the 4 feature groups, **appended to existing pages only** — no new pages, no sidebar changes. Mechanism-oriented writing with abstract examples (no real scraped prices that would go stale).

## File Append Map

| File | Append | Features |
|---|---|---|
| `docs/guide/cli-options.md` | extend Output Format + new Group & Nesting + new DuckDB OLAP Store | `--format/-f`, `--tree`, `--group`, tree-table, `--db-path`/`--no-duckdb`/`--rebuild` |
| `docs/guide/config-files.md` | extend File Locations + new Structured Pricing | pricing/payments file paths, array schema, specificity matching, conflict throw |
| `docs/guide/cost-modes.md` | new Billing Display Behavior | grayscale tiers, billing `+` join, drop `cost_usd` priority, pricing-error surfacing |
| `docs/guide/index.md` | Key Features +4 entries | one-line overview per feature group |

## Detailed Append Structure

### `cli-options.md`

**1. Extend "Output Format" (from line 24)**
- `--format` / `-f`: `table` (default) | `json` | `tree` | `tree-table`
- `--json`/`-j`, `--tree` as shorthands (`--format` wins when set)
- tree-table: column-aligned tabular tree + grayscale (see cost-modes.md)

**2. New `### Group & Nesting`**
- `--group`: comma-separated; a time-bucket (`daily|weekly|monthly|session`) selects the data loader and occupies the time nesting slot; remaining are nesting dims: `project,provider,agent,reseller,region,plan,model`
- Omitting a bucket loads all records with no time aggregation
- Default: `daily` (→ `time,model`)
- Abstract example: `zccusage --group agent,reseller,region,plan,model,weekly`

**3. New `### DuckDB OLAP Store`**
- `--db-path` (default `~/.cc-switch-tui/zccusage.duckdb`)
- `--no-duckdb`: disable DuckDB, fall back to direct JSONL reads
- `--rebuild`: rebuild the DuckDB store (schema change / corruption)
- Default enabled; `--no-duckdb` for debugging or when OLAP acceleration is unneeded

### `config-files.md`

**1. Extend "Configuration File Locations" (from line 83)**
- Add `zccusage-pricing.json` and `zccusage-payments.json` paths
- Actual search paths follow `_consts.ts` — pricing/payments may resolve under the cc-switch config dir rather than `~/.claude/` (confirm at implementation time)

**2. New `## Structured Pricing`**
- Field table: `reseller` (required, minLen 1) / `model` (required) / `region?` / `plan?` / `currency?` (default) / `inputCostPerMTokens` (required) / `outputCostPerMTokens` (required) / `cacheCreationCostPerMTokens?` / `cacheReadCostPerMTokens?`
- Matching: `reseller` fuzzy bidirectional substring; `region`/`plan` exact; specificity = region+plan count; higher specificity overrides lower
- Conflict: ≥2 rules sharing max specificity for the same key → throw (surfaced, not silent)
- Abstract example (placeholder prices, not real)

### `cost-modes.md`

**New `## Billing Display Behavior`**
- Grayscale tiers: currency symbol + token digits 4-6 = mid-gray (251); token last-3 digits + decimals = low-gray (245); hierarchy 245 < 251 < default. Markdown cannot render ANSI, so use rule description + ASCII示意
- Billing multi-currency: output in provider's billing currency as-is, join with `+`, sorted via `localeCompare` for stable order
- Drop cc-switch `cost_usd` priority: `mode=auto` no longer uses `cc-switch.db` `total_cost_usd`; uses provider pricing currency instead
- Pricing error surfacing: on load failure, `logger.error` prints details, then falls back to bundled static pricing (no silent swallow)

### `index.md`

**Key Features +4 entries**: DuckDB OLAP acceleration / tree-table + `--group` multi-dim aggregation / structured pricing config / billing display polish (grayscale + multi-currency)

## Validation

- `pnpm --filter @zccusage/docs build`: VitePress build with no broken links / errors
- Content self-check: each feature covers "parameter/field + abstract example + behavior/boundary"
- Pure doc change — no `typecheck` / `test` runs
- No new screenshots (grayscale via ASCII, tree-table via code block)

## Implementation Confirmations Required (read code, do not write from memory)

| Item | Source | Current Inference |
|---|---|---|
| DuckDB default on/off | `_shared-args.ts` noDuckdb default + `commands/*.ts` | default on (inferred from `--no-duckdb`) |
| pricing/payments search path | `_consts.ts` + pricing loader | possibly cc-switch dir, not `~/.claude/` |
| grayscale constants | `_tree-renderer.ts` | GRAY_LOW=245, GRAY_MID=251 |
| `--group` default + nesting | `_shared-args.ts` | default daily(→time,model) |
| billing `+` join + sort | `_tree-renderer.ts` formatBilling | localeCompare stable |
| pricing error surfacing | `_pricing-fetcher.ts` getModelPricingForProvider | logger.error then fallback |

## Risks & Boundaries

- Abstract examples may drift from schema evolution → docs note "follow `_pricing-fetcher.ts` schema as source of truth"
- If DuckDB behavior contradicts inference → correct docs to match code, not inference
- Command names in docs uniformly use `zccusage` (consistent with existing guide)

## Out of Scope

- better-ccusage rename residue cleanup (broken symlinks, CLAUDE.md, package.json, config.ts URLs, app READMEs) — separate effort
- New independent guide pages, sidebar changes
- `docs/superpowers/specs/` and `plans/` historical documents
- API docs (typedoc auto-generated)
- Screenshots for new features
