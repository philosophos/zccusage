# Configuration Files

zccusage supports JSON configuration files for persistent settings. Configuration files allow you to set default options for all commands or customize behavior for specific commands without repeating options every time.

## Quick Start

### 1. Use Schema for IDE Support

Always include the schema for autocomplete and validation:

```json
{
	"$schema": "https://zccusage.com/config-schema.json"
}
```

### 2. Set Common Defaults

Put frequently used options in `defaults`:

```json
{
	"$schema": "https://zccusage.com/config-schema.json",
	"defaults": {
		"timezone": "UTC",
		"locale": "en-CA",
		"breakdown": true
	}
}
```

### 3. Override for Specific Commands

```json
{
	"$schema": "https://zccusage.com/config-schema.json",
	"defaults": {
		"breakdown": false
	},
	"commands": {
		"daily": {
			"breakdown": true // Only daily needs breakdown
		}
	}
}
```

### 4. Convert CLI Arguments to Config

If you find yourself repeating CLI arguments:

```bash
# Before (repeated CLI arguments)
zccusage daily --breakdown --instances --timezone UTC
zccusage monthly --breakdown --timezone UTC
```

Convert them to a config file:

```json
// zccusage.json
{
	"$schema": "https://zccusage.com/config-schema.json",
	"defaults": {
		"breakdown": true,
		"timezone": "UTC"
	},
	"commands": {
		"daily": {
			"instances": true
		}
	}
}
```

Now simpler commands:

```bash
zccusage daily
zccusage monthly
```

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

## Basic Configuration

Create a `zccusage.json` file with your preferred defaults:

```json
{
	"$schema": "https://zccusage.com/config-schema.json",
	"defaults": {
		"json": false,
		"mode": "auto",
		"timezone": "Asia/Tokyo",
		"locale": "ja-JP",
		"breakdown": true
	}
}
```

## Configuration Structure

### Schema Support

Add the `$schema` property to get IntelliSense and validation in your IDE:

```json
{
	"$schema": "https://zccusage.com/config-schema.json"
}
```

You can also reference a local schema file after installing zccusage:

```json
{
	"$schema": "./node_modules/zccusage/config-schema.json"
}
```

### Global Defaults

The `defaults` section sets default values for all commands:

```json
{
	"$schema": "https://zccusage.com/config-schema.json",
	"defaults": {
		"since": "20250101",
		"until": "20250630",
		"json": false,
		"mode": "auto",
		"debug": false,
		"debugSamples": 5,
		"order": "asc",
		"breakdown": false,
		"timezone": "UTC",
		"locale": "en-CA",
		"jq": ".data[]"
	}
}
```

### Command-Specific Configuration

Override defaults for specific commands using the `commands` section:

```json
{
	"$schema": "https://zccusage.com/config-schema.json",
	"defaults": {
		"mode": "auto"
	},
	"commands": {
		"daily": {
			"instances": true,
			"breakdown": true
		},
		"blocks": {
			"active": true,
			"tokenLimit": "500000"
		}
	}
}
```

## Command-Specific Options

### Daily Command

```json
{
	"commands": {
		"daily": {
			"instances": true,
			"project": "my-project",
			"breakdown": true,
			"since": "20250101",
			"until": "20250630"
		}
	}
}
```

### Weekly Command

```json
{
	"commands": {
		"weekly": {
			"startOfWeek": "monday",
			"breakdown": true,
			"timezone": "Europe/London"
		}
	}
}
```

### Monthly Command

```json
{
	"commands": {
		"monthly": {
			"breakdown": true,
			"mode": "calculate",
			"locale": "en-US"
		}
	}
}
```

### Session Command

```json
{
	"commands": {
		"session": {
			"id": "abc123-session",
			"project": "my-project",
			"json": true
		}
	}
}
```

### Blocks Command

```json
{
	"commands": {
		"blocks": {
			"active": true,
			"recent": false,
			"tokenLimit": "max",
			"sessionLength": 5,
			"live": false,
			"refreshInterval": 1
		}
	}
}
```

### Statusline

```json
{
	"commands": {
		"statusline": {
			"cache": true,
			"refreshInterval": 2
		}
	}
}
```

## Custom Configuration Files

Use the `--config` option to specify a custom configuration file:

```bash
# Use a specific configuration file
zccusage daily --config ./my-config.json

# Works with all commands
zccusage blocks --config /path/to/team-config.json
```

This is useful for:

- **Team configurations** - Share configuration files across team members
- **Environment-specific settings** - Different configs for development/production
- **Project-specific overrides** - Use different settings for different projects

## Configuration Example

For a complete configuration example, see [`/zccusage.example.json`](/zccusage.example.json) in the repository root, which demonstrates:

- Global defaults configuration
- Command-specific overrides
- All available options with proper types

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

## Configuration Priority

Settings are applied in this priority order (highest to lowest):

1. **Command-line arguments** (e.g., `--json`, `--mode`)
2. **Custom config file** (specified with `--config /path/to/config.json`)
3. **Local project config** (`.zccusage/zccusage.json`)
4. **User config** (`~/.config/claude/zccusage.json`)
5. **Legacy config** (`~/.claude/zccusage.json`)
6. **Built-in defaults**

Example:

```json
// .zccusage/zccusage.json
{
	"defaults": {
		"mode": "calculate"
	}
}
```

```bash
# Config file sets mode to "calculate"
zccusage daily  # Uses mode: calculate

# But CLI argument overrides it
zccusage daily --mode display  # Uses mode: display
```

## Debugging Configuration

Use the `--debug` flag to see configuration loading details:

```bash
# Debug configuration loading
zccusage daily --debug

# Debug custom config file
zccusage daily --debug --config ./my-config.json
```

Debug output shows:

- Which config files are checked and found
- Schema and option details from loaded configs
- How options are merged from different sources
- Final values used for each option

Example debug output:

```
[zccusage] ℹ Debug mode enabled - showing config loading details

[zccusage] ℹ Searching for config files:
  • Checking: .zccusage/zccusage.json (found ✓)
  • Checking: ~/.config/claude/zccusage.json (found ✓)
  • Checking: ~/.claude/zccusage.json (not found)

[zccusage] ℹ Loaded config from: .zccusage/zccusage.json
  • Schema: https://zccusage.com/config-schema.json
  • Has defaults: yes (3 options)
  • Has command configs: yes (daily)

[zccusage] ℹ Merging options for 'daily' command:
  • From defaults: mode="auto"
  • From command config: instances=true
  • From CLI args: debug=true
  • Final merged options: {
      mode: "auto" (from defaults),
      instances: true (from command config),
      debug: true (from CLI)
    }
```

## Best Practices

### Version Control

For project configs, commit `.zccusage/zccusage.json` to version control:

```bash
# Add to git
git add .zccusage/zccusage.json
git commit -m "Add zccusage configuration"
```

### Document Team Configs

Add comments using a README alongside team configs:

```
team-configs/
├── zccusage.json
└── README.md  # Explain configuration choices
```

## Troubleshooting

### Config Not Being Applied

1. Check file location is correct
2. Verify JSON syntax is valid
3. Use `--debug` to see loading details
4. Ensure option names match exactly

### Invalid JSON

Use a JSON validator or IDE with JSON support:

```bash
# Validate JSON syntax
jq . < zccusage.json
```

### Schema Validation Errors

Ensure option values match expected types:

```json
{
	"defaults": {
		"tokenLimit": "500000", // ✅ String or number
		"active": true, // ✅ Boolean
		"refreshInterval": 2 // ✅ Number
	}
}
```

## Related Documentation

- [Command-Line Options](/guide/cli-options) - Available CLI arguments
- [Environment Variables](/guide/environment-variables) - Environment configuration
- [Configuration Overview](/guide/configuration) - Complete configuration guide
