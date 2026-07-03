# Update Docs for New Features — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Append user-facing guide documentation for 4 feature groups (structured pricing / DuckDB / tree-table+`--group` / billing display behavior) to 4 existing docs pages — no new pages, no sidebar changes.

**Architecture:** Documentation-only. Each task targets one `docs/guide/*.md` file, appends mechanism-oriented content with abstract examples, then lints and commits. No unit tests apply (docs); verification = read source for facts + `pnpm --filter @zccusage/docs build` (no broken links) + content self-check. Final task runs the full build.

**Tech Stack:** VitePress markdown, pnpm workspace (`@zccusage/docs`), ESLint for markdown lint.

**Source of truth for facts (already verified, but re-confirm if schema looks changed):**
- DuckDB args: `apps/zccusage/src/_shared-args.ts:168-181`
- Grayscale + formatBilling: `apps/zccusage/src/_tree-renderer.ts:502-582`
- Pricing schema + paths + error surfacing: `apps/zccusage/src/_pricing-fetcher.ts:44-55,189-215,400+`
- Payments paths: `apps/zccusage/src/_payments-loader.ts:37`
- `--group`: `apps/zccusage/src/_shared-args.ts:50-56`
- cc-switch dir + DuckDB default path: `apps/zccusage/src/_consts.ts:224-240`

---

### Task 1: `cli-options.md` — Output Format + Group & Nesting + DuckDB

**Files:**
- Modify: `docs/guide/cli-options.md` (extend `### Output Format` at line 24; insert `### Group & Nesting` and `### DuckDB OLAP Store` after the Output Format block)

- [ ] **Step 1: Re-confirm facts from source**

Run:
```bash
sed -n '38,56p' apps/zccusage/src/_shared-args.ts
sed -n '168,181p' apps/zccusage/src/_shared-args.ts
```
Expected: `format` accepts `table|json|tree|tree-table`; `group` description mentions time-bucket + nesting dims; `dbPath`/`noDuckdb`/`rebuild` defaults as documented.

- [ ] **Step 2: Extend the `### Output Format` section (line 24)**

Find the existing block (lines ~24-40):
````markdown
### Output Format

Control how data is displayed:

```bash
# JSON output for programmatic use
zccusage daily --json
zccusage daily -j

# Show per-model breakdown
zccusage daily --breakdown
zccusage daily -b

# Combine options
zccusage daily --json --breakdown
```
````

Replace it with:
````markdown
### Output Format

Control how data is displayed:

```bash
# JSON output for programmatic use
zccusage daily --json
zccusage daily -j

# Show per-model breakdown
zccusage daily --breakdown
zccusage daily -b

# Combine options
zccusage daily --json --breakdown
```

#### `--format` / `-f`

Select the output format explicitly:

```bash
zccusage daily -f table       # Default — pretty-printed table
zccusage daily -f json        # Structured JSON
zccusage daily -f tree        # Hierarchical tree view
zccusage daily -f tree-table  # Column-aligned tree + table
```

- `--json` / `-j` is a shorthand for `-f json`.
- `--tree` is a shorthand for `-f tree`.
- An explicit `--format` value wins over `--json` / `--tree` when both are set.

#### `tree-table`

`-f tree-table` renders the hierarchical tree with aligned columns (input/output/cache-create/cache-read/billing). Useful when you want both the nesting overview and precise per-row numbers. Token digits and currency symbols are dimmed by tier — see [Billing Display Behavior](./cost-modes.md#billing-display-behavior).
````

- [ ] **Step 3: Insert `### Group & Nesting` after the Output Format block**

Append:
````markdown
### Group & Nesting

`--group` selects both the time bucket (which data loader runs) and the nesting dimensions of the tree/tree-table output. It is a comma-separated list:

```
--group <dim1>,<dim2>,...,<time-bucket>
```

- **Time bucket** (one of `daily`, `weekly`, `monthly`, `session`): selects the data loader and occupies the time nesting slot at its position.
- **Nesting dims** (any of `project`, `provider`, `agent`, `reseller`, `region`, `plan`, `model`): control how rows are nested around the time bucket.
- Omitting a time bucket loads all records with no time aggregation.
- Default: `daily` (→ `time, model`).

```bash
# Default daily report
zccusage daily

# Weekly, nested by agent → reseller → region → plan → model
zccusage --group agent,reseller,region,plan,model,weekly

# Session bucket only
zccusage --group session
```
````

- [ ] **Step 4: Insert `### DuckDB OLAP Store` after Group & Nesting**

Append:
````markdown
### DuckDB OLAP Store

By default zccusage persists usage facts into a DuckDB columnar store for fast ad-hoc queries, and reads from it on subsequent runs.

```bash
# Use a custom DuckDB path
zccusage daily --db-path /data/zccusage.duckdb

# Bypass DuckDB and read JSONL transcripts directly (legacy glob+parse path)
zccusage daily --no-duckdb

# Force a full re-ingest (drops and re-imports all rows)
zccusage daily --rebuild
```

- `--db-path`: defaults to `~/.cc-switch-tui/zccusage.duckdb` (or `~/.cc-switch/zccusage.duckdb`), overridable via `$CC_SWITCH_CONFIG_DIR`.
- `--no-duckdb`: bypass the store and use the legacy direct-read path — useful for debugging or verifying DuckDB results against raw transcripts.
- `--rebuild`: drop and re-import all rows; use after schema changes or if the store is corrupted.
````

- [ ] **Step 5: Lint**

Run: `pnpm --filter @zccusage/docs lint`
Expected: no new errors in `cli-options.md`.

- [ ] **Step 6: Commit**

```bash
rtk git add docs/guide/cli-options.md
rtk git commit -m "docs(zccusage): document --format/--group/DuckDB in cli-options"
```

---

### Task 2: `config-files.md` — File Locations + Structured Pricing

**Files:**
- Modify: `docs/guide/config-files.md` (extend `## Configuration File Locations` at line 83; add `## Structured Pricing` section)

- [ ] **Step 1: Re-confirm facts from source**

Run:
```bash
sed -n '189,215p' apps/zccusage/src/_pricing-fetcher.ts
sed -n '44,55p' apps/zccusage/src/_pricing-fetcher.ts
sed -n '37,40p' apps/zccusage/src/_payments-loader.ts
```
Expected: `buildPricingSearchPaths` = `[cwd/.zccusage, ...getClaudePaths()]` joined with `PRICING_FILE_NAME`; schema fields match the table below; payments uses the same pattern.

- [ ] **Step 2: Extend `## Configuration File Locations` (line 83)**

Find the existing block (lines ~83-95):
````markdown
## Configuration File Locations

zccusage searches for configuration files in these locations (in priority order):

1. **Local project**: `.zccusage/zccusage.json` (higher priority)
2. **User config**: `~/.claude/zccusage.json` or `~/.config/claude/zccusage.json` (lower priority)

Configuration files are merged in priority order, with local project settings overriding user settings.
If you pass a custom config file using `--config`, it will override both local and user configs.
Note that configuration files are not required; if none are found, zccusage will use built-in defaults.
Also, if you have multiple config files, only the first one found will be used.
````

Replace with:
````markdown
## Configuration File Locations

zccusage searches for configuration files in these locations (in priority order):

1. **Local project**: `.zccusage/zccusage.json` (higher priority)
2. **User config**: `~/.claude/zccusage.json` or `~/.config/claude/zccusage.json` (lower priority)

Pricing and payments files use the same search paths under their respective names:

- `zccusage-pricing.json` — `.zccusage/` (local) or Claude config dir (user)
- `zccusage-payments.json` — `.zccusage/` (local) or Claude config dir (user)

Configuration files are merged in priority order, with local project settings overriding user settings.
If you pass a custom config file using `--config`, it will override both local and user configs.
Note that configuration files are not required; if none are found, zccusage will use built-in defaults.
Also, if you have multiple config files, only the first one found will be used.
````

- [ ] **Step 3: Add `## Structured Pricing` section**

Insert before `## Configuration Priority` (or at end of file if priority section is last):
````markdown
## Structured Pricing

`zccusage-pricing.json` overrides the bundled USD pricing with per-platform billing-currency prices. It is a JSON array of rules:

```json
[
  {
    "reseller": "aliyun",
    "model": "glm-5.2",
    "currency": "CNY",
    "inputCostPerMTokens": 8,
    "outputCostPerMTokens": 28
  },
  {
    "reseller": "aliyun",
    "model": "glm-5.2",
    "region": "singapore",
    "inputCostPerMTokens": 6,
    "outputCostPerMTokens": 22
  }
]
```

### Fields

| Field | Required | Description |
|---|---|---|
| `reseller` | ✅ | Reseller keyword (min length 1); matched fuzzily as a bidirectional substring against the provider profile. |
| `model` | ✅ | Model name to match. |
| `region` | ⬜ | Optional region override (exact match). |
| `plan` | ⬜ | Optional plan override (exact match). |
| `currency` | ⬜ | Billing currency code (e.g. `CNY`, `USD`). Defaults to the bundled default. |
| `inputCostPerMTokens` | ✅ | Input price per million tokens (in `currency`). |
| `outputCostPerMTokens` | ✅ | Output price per million tokens. |
| `cacheCreationCostPerMTokens` | ⬜ | Cache-create price per million tokens. |
| `cacheReadCostPerMTokens` | ⬜ | Cache-read price per million tokens. |

Prices are per-million tokens; zccusage converts them to per-token internally.

### Matching & Specificity

- `reseller` is matched fuzzily (bidirectional substring) against the provider profile.
- `region` and `plan` match exactly when present; omit them for a default covering all the reseller's regions/plans.
- **Specificity** = number of `region` + `plan` present. A higher-specificity rule overrides a lower one for the same `reseller` + `model`.
- **Conflict**: if two or more rules share the top specificity for the same key, zccusage throws an error (surfaced — not silently swallowed).

### Currency

Costs are reported in the rule's `currency` as-is; zccusage does not convert between currencies. Multi-currency totals are joined with ` + ` — see [Billing Display Behavior](./cost-modes.md#billing-display-behavior).
````

- [ ] **Step 4: Lint**

Run: `pnpm --filter @zccusage/docs lint`
Expected: no new errors in `config-files.md`.

- [ ] **Step 5: Commit**

```bash
rtk git add docs/guide/config-files.md
rtk git commit -m "docs(zccusage): document structured pricing config + file locations"
```

---

### Task 3: `cost-modes.md` — Billing Display Behavior

**Files:**
- Modify: `docs/guide/cost-modes.md` (add `## Billing Display Behavior` section at end of file)

- [ ] **Step 1: Re-confirm facts from source**

Run:
```bash
sed -n '502,582p' apps/zccusage/src/_tree-renderer.ts
```
Expected: `GRAY_LOW=245`, `GRAY_MID=251`; `dimMoney` applies MID to currency symbol and LOW to decimals; `formatBilling` sorts via `localeCompare` and joins with ` + `; token groups: last=LOW, 2nd-last=MID, earlier=default.

- [ ] **Step 2: Append `## Billing Display Behavior` at end of file**

````markdown
## Billing Display Behavior

Beyond the cost-calculation mode, zccusage applies a few display behaviors to billing output.

### Grayscale Tiers

In `table` and `tree-table` output (when color is supported), zccusage dims secondary digits so the most significant figures stand out:

- **Mid-gray**: currency symbols (`$`, `¥`, `CN¥`) and token digits 4–6 (thousands group).
- **Low-gray**: token last 3 digits and billing decimal fractions.

Hierarchy: low-gray < mid-gray < default. Token thousands groups are split: the last (digits 1–3) is low-gray, the 2nd-last (digits 4–6) is mid-gray, earlier groups are default.

```
1,234,567,890  →  1,234,567,890
                 ^^^ mid  ^^^ low
CN¥21.71       →  CN¥21.71
              mid   ^^^ low
```

### Multi-Currency Billing

When a report spans providers with different billing currencies, zccusage outputs each currency as-is and joins them with ` + `, sorted alphabetically for stable order:

```
CN¥152.30 + $4.50
```

### `mode=auto` No Longer Prefers `cost_usd`

Previously, `mode=auto` would prefer `cc-switch`'s `total_cost_usd` (a USD figure) when present. This was misleading for non-USD providers. Now `mode=auto` uses the provider's pricing currency (from structured pricing or bundled pricing), not the cc-switch USD column.

### Pricing-Error Surfacing

If `zccusage-pricing.json` fails to load (e.g. malformed JSON, conflicting rules), zccusage logs the error details via `logger.error`, then falls back to the bundled static pricing. The error is surfaced rather than silently swallowed.
````

- [ ] **Step 3: Lint**

Run: `pnpm --filter @zccusage/docs lint`
Expected: no new errors in `cost-modes.md`.

- [ ] **Step 4: Commit**

```bash
rtk git add docs/guide/cost-modes.md
rtk git commit -m "docs(zccusage): document billing display behavior (grayscale/multi-currency/error surfacing)"
```

---

### Task 4: `index.md` — Key Features +4 entries

**Files:**
- Modify: `docs/guide/index.md` (append 4 subsections under `## Key Features`, after the existing `### 🔧 Flexible Configuration` block around line 69)

- [ ] **Step 1: Re-confirm the end of Key Features section**

Run:
```bash
sed -n '61,72p' docs/guide/index.md
```
Expected: `### 🔧 Flexible Configuration` block ends around line 69, before `## Multi-Provider Support`.

- [ ] **Step 2: Append 4 feature entries after `### 🔧 Flexible Configuration`**

````markdown
### 🗄️ DuckDB OLAP Acceleration

zccusage persists usage facts into a DuckDB columnar store for fast ad-hoc queries. Subsequent runs read from the store instead of re-parsing raw transcripts. Use `--no-duckdb` to bypass and `--rebuild` to re-ingest.

### 🌳 tree-table Output & `--group` Nesting

`-f tree-table` renders a hierarchical tree with aligned columns. `--group` selects both the time bucket (`daily`/`weekly`/`monthly`/`session`) and nesting dimensions (`project`/`provider`/`agent`/`reseller`/`region`/`plan`/`model`) for multi-dimensional analysis.

### 💲 Structured Pricing Configuration

Define per-reseller, per-region, per-plan pricing in your billing currency via `zccusage-pricing.json`. Override the bundled USD pricing with platform-accurate costs; conflicts are surfaced, not silently swallowed.

### 🎨 Billing Display Polish

Currency symbols and token digits are dimmed by tier so significant figures stand out. Multi-currency totals are joined with ` + ` and sorted for stable display.
````

- [ ] **Step 3: Lint**

Run: `pnpm --filter @zccusage/docs lint`
Expected: no new errors in `index.md`.

- [ ] **Step 4: Commit**

```bash
rtk git add docs/guide/index.md
rtk git commit -m "docs(zccusage): add 4 new feature entries to index Key Features"
```

---

### Task 5: Full build verification

**Files:** none (verification only)

- [ ] **Step 1: Run the docs build**

Run: `pnpm --filter @zccusage/docs build`
Expected: build succeeds; no broken-link / dead-link warnings for the 4 modified pages.

- [ ] **Step 2: Content self-check**

For each of the 4 features, confirm coverage in the built site:
- Structured pricing: `config-files.md` has field table + matching rules + conflict note.
- DuckDB: `cli-options.md` has `--db-path`/`--no-duckdb`/`--rebuild` with defaults.
- tree-table + `--group`: `cli-options.md` has `-f tree-table` and `--group` syntax.
- Billing display: `cost-modes.md` has grayscale tiers + ` + ` join + `cost_usd` removal + error surfacing.

- [ ] **Step 3: Verify cross-links resolve**

Confirm the two cross-page links added:
- `cli-options.md` → `./cost-modes.md#billing-display-behavior`
- `config-files.md` → `./cost-modes.md#billing-display-behavior`

Run:
```bash
rtk grep -n "billing-display-behavior" docs/guide/cli-options.md docs/guide/config-files.md docs/guide/cost-modes.md
```
Expected: anchor present in `cost-modes.md` and referenced in both `cli-options.md` and `config-files.md`.

- [ ] **Step 4: No-op commit if clean**

If the build surfaced any fixes, commit them:
```bash
rtk git add docs/guide
rtk git commit -m "docs(zccusage): fix build issues from update-docs pass"
```
If nothing changed, skip (working tree clean).

---

## Self-Review Notes

- **Spec coverage**: 4 feature groups → Task 1 (tree-table/--group/DuckDB), Task 2 (structured pricing), Task 3 (billing display), Task 4 (index overview). All spec sections mapped.
- **No placeholders**: every step contains the full markdown to append.
- **Type/name consistency**: `GRAY_LOW=245`/`GRAY_MID=251`, `zccusage-pricing.json`, `zccusage-payments.json`, `--db-path`/`--no-duckdb`/`--rebuild`, `inputCostPerMTokens` etc. verified against source.
- **Cross-link anchor**: `#billing-display-behavior` slug matches VitePress default (lowercase, hyphenated from `## Billing Display Behavior`).
