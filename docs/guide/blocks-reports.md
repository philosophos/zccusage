# Blocks Reports

Blocks reports show your Claude Code/Droid Usage grouped by 5-hour billing windows, helping you understand Claude's billing cycle and track active session progress.

## Basic Usage

```bash
zccusage blocks
```

## Example Output

```
╭──────────────────────────────────────────────────╮
│                                                  │
│  Claude Code Token Usage Report - Session Blocks │
│                                                  │
╰──────────────────────────────────────────────────╯

┌─────────────────────┬──────────────────┬────────┬─────────┬──────────────┬────────────┬──────────────┬────────────┐
│ Block Start Time    │ Models           │ Input  │ Output  │ Cache Create │ Cache Read │ Total Tokens │ Cost (USD) │
├─────────────────────┼──────────────────┼────────┼─────────┼──────────────┼────────────┼──────────────┼────────────┤
│ 2025-06-21 09:00:00 │ • opus-4         │  4,512 │ 285,846 │          512 │      1,024 │      291,894 │    $156.40 │
│ ⏰ Active (2h 15m)  │ • sonnet-4       │        │         │              │            │              │            │
│ 🔥 Rate: 2.1k/min   │                  │        │         │              │            │              │            │
│ 📊 Projected: 450k  │                  │        │         │              │            │              │            │
├─────────────────────┼──────────────────┼────────┼─────────┼──────────────┼────────────┼──────────────┼────────────┤
│ 2025-06-21 04:00:00 │ • sonnet-4       │  2,775 │ 186,645 │          256 │        768 │      190,444 │     $98.45 │
│ ✅ Completed (3h 42m)│                  │        │         │              │            │              │            │
├─────────────────────┼──────────────────┼────────┼─────────┼──────────────┼────────────┼──────────────┼────────────┤
│ 2025-06-20 15:30:00 │ • opus-4         │  1,887 │ 183,055 │          128 │        512 │      185,582 │     $81.73 │
│ ✅ Completed (4h 12m)│                  │        │         │              │            │              │            │
├─────────────────────┼──────────────────┼────────┼─────────┼──────────────┼────────────┼──────────────┼────────────┤
│ Total               │                  │  9,174 │ 655,546 │          896 │      2,304 │      667,920 │    $336.58 │
└─────────────────────┴──────────────────┴────────┴─────────┴──────────────┴────────────┴──────────────┴────────────┘
```

## Understanding Blocks

### Session Block Concept

Claude Code uses **5-hour billing windows** for session tracking:

- **Block Start**: Triggered by your first message
- **Block Duration**: Lasts exactly 5 hours from start time
- **Rolling Windows**: New blocks start with activity after previous block expires
- **Billing Relevance**: Matches Claude's internal session tracking
- **UTC Time Handling**: Block boundaries are calculated in UTC to ensure consistent behavior across time zones

### Block Status Indicators

- **⏰ Active**: Currently running block with time remaining
- **✅ Completed**: Finished block that ran its full duration or ended naturally
- **⌛ Gap**: Time periods with no activity (shown when relevant)
- **🔥 Rate**: Token burn rate (tokens per minute) for active blocks
- **📊 Projected**: Estimated total tokens if current rate continues

## Command Options

### Show Active Block Only

Focus on your current session with detailed projections:

```bash
zccusage blocks --active
```

This shows only the currently active block with:

- Time remaining in the 5-hour window
- Current token burn rate
- Projected final token count and cost

### Show Recent Blocks

Display blocks from the last 3 days (including active):

```bash
zccusage blocks --recent
```

Perfect for understanding recent usage patterns without scrolling through all historical data.

### Token Limit Tracking

Set token limits to monitor quota usage:

```bash
# Set explicit token limit
zccusage blocks --token-limit 500000

# Use highest previous block as limit
zccusage blocks --token-limit max
# or short form:
zccusage blocks -t max
```

When limits are set, blocks display:

- ⚠️ **Warning indicators** when approaching limits
- 🚨 **Alert indicators** when exceeding limits
- **Progress bars** showing usage relative to limit

### Live Monitoring

::: warning DEPRECATED
The `blocks --live` monitor feature is deprecated and will be removed in a future version. Please use the [statusline command](/guide/statusline) instead for real-time monitoring.
:::

Real-time dashboard with automatic updates:

```bash
# Basic live monitoring (uses -t max automatically)
zccusage blocks --live

# Live monitoring with explicit token limit
zccusage blocks --live --token-limit 500000

# Custom refresh interval (1-60 seconds)
zccusage blocks --live --refresh-interval 5
```

Live monitoring features:

- **Real-time updates** every 1-60 seconds (configurable)
- **Automatic token limit** detection from usage history
- **Progress bars** with color coding (green/yellow/red)
- **Burn rate calculations** with trend analysis
- **Time remaining** in current block
- **Graceful shutdown** with Ctrl+C

### Custom Session Duration

Change the block duration (default is 5 hours):

```bash
# 3-hour blocks
zccusage blocks --session-length 3

# 8-hour blocks
zccusage blocks --session-length 8
```

### Date Filtering

Filter blocks by date range:

```bash
# Show blocks from specific date range
zccusage blocks --since 20250620 --until 20250621

# Show blocks from last week
zccusage blocks --since $(date -d '7 days ago' +%Y%m%d)
```

### Sort Order

```bash
# Show newest blocks first (default)
zccusage blocks --order desc

# Show oldest blocks first
zccusage blocks --order asc
```

### Cost Calculation Modes

```bash
# Use pre-calculated costs when available (default)
zccusage blocks --mode auto

# Always calculate costs from tokens
zccusage blocks --mode calculate

# Only show pre-calculated costs
zccusage blocks --mode display
```

### JSON Output

Export block data for analysis:

```bash
zccusage blocks --json
```

```json
{
	"blocks": [
		{
			"id": "2025-06-21T09:00:00.000Z",
			"startTime": "2025-06-21T09:00:00.000Z",
			"endTime": "2025-06-21T14:00:00.000Z",
			"actualEndTime": "2025-06-21T11:15:00.000Z",
			"isActive": true,
			"tokenCounts": {
				"inputTokens": 4512,
				"outputTokens": 285846,
				"cacheCreationInputTokens": 512,
				"cacheReadInputTokens": 1024
			},
			"costUSD": 156.40,
			"models": ["opus-4", "sonnet-4"]
		}
	]
}
```

## Analysis Use Cases

### Session Planning

Understanding 5-hour windows helps with:

```bash
# Check current active block
zccusage blocks --active
```

- **Time Management**: Know how much time remains in current session
- **Usage Pacing**: Monitor if you're on track for reasonable usage
- **Break Planning**: Understand when current session will expire

### Usage Optimization

```bash
# Find your highest usage patterns
zccusage blocks -t max --recent
```

- **Peak Usage Identification**: Which blocks consumed the most tokens
- **Efficiency Patterns**: Compare block efficiency (tokens per hour)
- **Model Selection Impact**: How model choice affects block costs

### Live Session Tracking

```bash
# Monitor active sessions in real-time
zccusage blocks --live -t max
```

Perfect for:

- **Long coding sessions**: Track progress against historical limits
- **Budget management**: Watch costs accumulate in real-time
- **Productivity tracking**: Understand work intensity patterns

### Historical Analysis

```bash
# Export data for detailed analysis
zccusage blocks --json > blocks-history.json

# Analyze patterns over time
zccusage blocks --since 20250601 --until 20250630
```

## Block Analysis Tips

### 1. Understanding Block Efficiency

Look for patterns in your block data:

- **High-efficiency blocks**: Lots of output tokens for minimal input
- **Exploratory blocks**: High input/output ratios (research, debugging)
- **Focused blocks**: Steady token burn rates with clear objectives

### 2. Time Management

Use blocks to optimize your Claude usage:

- **Session planning**: Start important work at the beginning of blocks
- **Break timing**: Use block boundaries for natural work breaks
- **Batch processing**: Group similar tasks within single blocks

### 3. Cost Optimization

Blocks help identify cost patterns:

- **Model switching**: When to use Opus vs Sonnet within blocks
- **Cache efficiency**: How cache usage affects block costs
- **Usage intensity**: Whether short focused sessions or long exploratory ones are more cost-effective

### 4. Quota Management

When working with token limits:

- **Rate monitoring**: Watch burn rates to avoid exceeding limits
- **Early warning**: Set limits below actual quotas for safety margin
- **Usage spreading**: Distribute heavy usage across multiple blocks

## Responsive Display

Blocks reports adapt to your terminal width:

- **Wide terminals (≥100 chars)**: Shows all columns with full timestamps
- **Narrow terminals (<100 chars)**: Compact mode with abbreviated times and essential data

## Advanced Features

### Gap Detection

Blocks reports automatically detect and display gaps:

```
┌─────────────────────┬──────────────────┬────────┬─────────┬────────────┐
│ 2025-06-21 09:00:00 │ • opus-4         │  4,512 │ 285,846 │    $156.40 │
│ ⏰ Active (2h 15m)  │ • sonnet-4       │        │         │            │
├─────────────────────┼──────────────────┼────────┼─────────┼────────────┤
│ 2025-06-20 22:00:00 │ ⌛ 11h gap       │      0 │       0 │      $0.00 │
│ 2025-06-21 09:00:00 │                  │        │         │            │
├─────────────────────┼──────────────────┼────────┼─────────┼────────────┤
│ 2025-06-20 15:30:00 │ • opus-4         │  1,887 │ 183,055 │     $81.73 │
│ ✅ Completed (4h 12m)│                  │        │         │            │
└─────────────────────┴──────────────────┴────────┴─────────┴────────────┘
```

### Burn Rate Calculations

For active blocks, the tool calculates:

- **Tokens per minute**: Based on activity within the block
- **Cost per hour**: Projected hourly spend rate
- **Projected totals**: Estimated final tokens/cost if current rate continues

### Progress Visualization

When using token limits, blocks show visual progress:

- **Green**: Usage well below limit (< 70%)
- **Yellow**: Approaching limit (70-90%)
- **Red**: At or exceeding limit (≥ 90%)

## Related Commands

- [Daily Reports](/guide/daily-reports) - Usage aggregated by calendar date
- [Monthly Reports](/guide/monthly-reports) - Monthly usage summaries
- [Session Reports](/guide/session-reports) - Individual conversation analysis
- [Live Monitoring](/guide/live-monitoring) - Real-time session tracking

## Next Steps

After understanding block patterns, consider:

1. [Live Monitoring](/guide/live-monitoring) for real-time active session tracking
2. [Session Reports](/guide/session-reports) to analyze individual conversations within blocks
3. [Daily Reports](/guide/daily-reports) to see how blocks aggregate across days
