# Command-Line Options

zccusage provides extensive command-line options to customize its behavior. These options take precedence over configuration files and environment variables.

## Global Options

All zccusage commands support these global options:

### Date Filtering

Filter usage data by date range:

```bash
# Filter by date range
zccusage daily --since 20250101 --until 20250630

# Show data from a specific date
zccusage monthly --since 20250101

# Show data up to a specific date
zccusage session --until 20250630
```

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

### Cost Calculation Mode

Choose how costs are calculated:

```bash
# Auto mode (default) - use costUSD when available
zccusage daily --mode auto

# Calculate mode - always calculate from tokens
zccusage daily --mode calculate

# Display mode - only show pre-calculated costUSD
zccusage daily --mode display
```

### Sort Order

Control the ordering of results:

```bash
# Newest first (default)
zccusage daily --order desc

# Oldest first
zccusage daily --order asc
```

### Timezone

Set the timezone for date calculations:

```bash
# Use UTC timezone
zccusage daily --timezone UTC

# Use specific timezone
zccusage daily --timezone America/New_York
zccusage daily -z Asia/Tokyo

# Short alias
zccusage monthly -z Europe/London
```

#### Timezone Effect

The timezone affects how usage is grouped by date. For example, usage at 11 PM UTC on January 1st would appear on:

- **January 1st** when `--timezone UTC`
- **January 1st** when `--timezone America/New_York` (6 PM EST)
- **January 2nd** when `--timezone Asia/Tokyo` (8 AM JST next day)

### Locale

Control date and time formatting:

```bash
# US English (12-hour time format)
zccusage daily --locale en-US

# Japanese (24-hour time format)
zccusage blocks --locale ja-JP

# German (24-hour time format)
zccusage session -l de-DE

# Short alias
zccusage daily -l fr-FR
```

#### Locale Effects

The locale affects display formatting:

**Date Format:**

- `en-US`: 08/04/2025
- `en-CA`: 2025-08-04 (ISO format, default)
- `ja-JP`: 2025/08/04
- `de-DE`: 04.08.2025

**Time Format:**

- `en-US`: 3:30:00 PM (12-hour)
- Others: 15:30:00 (24-hour)

### Debug Options

Get detailed debugging information:

```bash
# Debug mode - show pricing mismatches and config loading
zccusage daily --debug

# Show sample discrepancies
zccusage daily --debug --debug-samples 10
```

### Configuration File

Use a custom configuration file:

```bash
# Specify custom config file
zccusage daily --config ./my-config.json
zccusage monthly --config /path/to/team-config.json
```

## Command-Specific Options

### Daily Command

Additional options for daily reports:

```bash
# Group by project
zccusage daily --instances
zccusage daily -i

# Filter to specific project
zccusage daily --project myproject
zccusage daily -p myproject

# Combine project filtering
zccusage daily --instances --project myproject
```

### Weekly Command

Options for weekly reports:

```bash
# Set week start day
zccusage weekly --start-of-week monday
zccusage weekly --start-of-week sunday
```

### Session Command

Options for session reports:

```bash
# Filter by session ID
zccusage session --id abc123-session

# Filter by project
zccusage session --project myproject
```

### Blocks Command

Options for 5-hour billing blocks:

```bash
# Show only active block
zccusage blocks --active
zccusage blocks -a

# Show recent blocks (last 3 days)
zccusage blocks --recent
zccusage blocks -r

# Set token limit for warnings
zccusage blocks --token-limit 500000
zccusage blocks --token-limit max

# Live monitoring mode
zccusage blocks --live
zccusage blocks --live --refresh-interval 2

# Customize session length
zccusage blocks --session-length 5
```

> **Note:** The MCP server CLI moved to the dedicated `@zccusage/mcp` package. See the [MCP Server guide](/guide/mcp-server) for usage details.

### Statusline

Options for statusline display:

```bash
# Basic statusline
zccusage statusline

# Enable caching
zccusage statusline --cache

# Custom refresh interval
zccusage statusline --refresh-interval 5
```

## JSON Output Options

When using `--json` output, additional processing options are available:

```bash
# Apply jq filter to JSON output
zccusage daily --json --jq ".data[]"

# Filter high-cost days
zccusage daily --json --jq ".data[] | select(.cost > 10)"

# Extract specific fields
zccusage session --json --jq ".data[] | {date, cost}"
```

## Option Precedence

Options are applied in this order (highest to lowest priority):

1. **Command-line arguments** - Direct CLI options
2. **Custom config file** - Via `--config` flag
3. **Local project config** - `.zccusage/zccusage.json`
4. **User config** - `~/.config/claude/zccusage.json`
5. **Legacy config** - `~/.claude/zccusage.json`
6. **Built-in defaults**

## Examples

### Development Workflow

```bash
# Daily development check
zccusage daily --instances --breakdown

# Check specific project costs
zccusage daily --project myapp --since 20250101

# Export for reporting
zccusage monthly --json > monthly-report.json
```

### Team Collaboration

```bash
# Use team configuration
zccusage daily --config ./team-config.json

# Consistent timezone for remote team
zccusage daily --timezone UTC --locale en-CA

# Generate shareable report
zccusage weekly --json --jq ".summary"
```

### Cost Monitoring

```bash
# Monitor active usage
zccusage blocks --active --live

# Check if approaching limits
zccusage blocks --token-limit 500000

# Historical analysis
zccusage monthly --mode calculate --breakdown
```

### Debugging Issues

```bash
# Debug configuration loading
zccusage daily --debug --config ./test-config.json

# Check pricing discrepancies
zccusage daily --debug --debug-samples 20

# Silent mode for scripts
LOG_LEVEL=0 zccusage daily --json
```

## Short Aliases

Many options have short aliases for convenience:

| Long Option   | Short | Description         |
| ------------- | ----- | ------------------- |
| `--json`      | `-j`  | JSON output         |
| `--breakdown` | `-b`  | Per-model breakdown |
| `--timezone`  | `-z`  | Set timezone        |
| `--locale`    | `-l`  | Set locale          |
| `--instances` | `-i`  | Group by project    |
| `--project`   | `-p`  | Filter project      |
| `--active`    | `-a`  | Active block only   |
| `--recent`    | `-r`  | Recent blocks       |

## Related Documentation

- [Environment Variables](/guide/environment-variables) - Configure via environment
- [Configuration Files](/guide/config-files) - Persistent configuration
- [Cost Calculation Modes](/guide/cost-modes) - Understanding cost modes
