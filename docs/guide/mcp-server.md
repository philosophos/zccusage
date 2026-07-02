# MCP Server

The zccusage MCP server now lives in the dedicated `@zccusage/mcp` package. This keeps the main CLI lightweight while still giving you full access to MCP tools for daily, session, monthly, and billing-block analytics.

## Running the MCP CLI

Execute the MCP CLI directly without installation using `bunx` or `npx`:

```bash
bunx @zccusage/mcp@latest --help
# or
npx @zccusage/mcp@latest --help
```

All examples below use `bunx @zccusage/mcp@latest` (you can substitute with `npx @zccusage/mcp@latest` if preferred).

## Starting the MCP Server

### stdio transport (default)

```bash
bunx @zccusage/mcp@latest
# equivalent:
bunx @zccusage/mcp@latest --type stdio
```

The stdio transport is ideal when the MCP client spawns the process directly (for example, Claude Desktop on the same machine).

### HTTP Stream Transport

```bash
bunx @zccusage/mcp@latest --type http --port 8080
```

HTTP mode is useful when you need to expose the server to other hosts or run it as a background service.

### Cost Calculation Mode

Control how costs are calculated when generating reports:

```bash
# Use cached costUSD values when present, otherwise calculate from tokens (default)
bunx @zccusage/mcp@latest --mode auto

# Always calculate from tokens using local pricing data
bunx @zccusage/mcp@latest --mode calculate

# Only use pre-calculated costUSD values and default to 0 when missing
bunx @zccusage/mcp@latest --mode display
```

All options from the original command remain available, including `CLAUDE_CONFIG_DIR` for custom data locations.

## Available MCP Tools

The server still provides four tools with the same schemas as before:

- **daily** – aggregated usage per day
- **monthly** – aggregated usage per month
- **session** – grouped by Claude session ID / project directory
- **blocks** – 5-hour billing block summaries

Each tool accepts `since`, `until`, and `mode` parameters, plus timezone/locale overrides identical to the zccusage library.

## Testing the MCP Server

### With MCP Inspector

```bash
bunx @modelcontextprotocol/inspector bunx @zccusage/mcp@latest
# or
npx @modelcontextprotocol/inspector npx @zccusage/mcp@latest
```

The Inspector lets you:

- Call each tool interactively
- Inspect the tool schemas and responses
- Debug invalid parameters or unexpected data
- Export ready-to-use server definitions

### Manual JSON-RPC Testing

```bash
bunx @zccusage/mcp@latest
# Now send JSON-RPC to stdin, e.g. list available tools
{"jsonrpc": "2.0", "id": 1, "method": "tools/list"}
```

## Claude Desktop Integration

![Claude Desktop MCP Configuration](/mcp-claude-desktop.avif)

Update your Claude Desktop configuration to use direct execution:

```json
{
	"mcpServers": {
		"zccusage": {
			"command": "bunx",
			"args": ["@zccusage/mcp@latest"],
			"env": {}
		}
	}
}
```

Or using `npx`:

```json
{
	"mcpServers": {
		"zccusage": {
			"command": "npx",
			"args": ["@zccusage/mcp@latest"],
			"env": {}
		}
	}
}
```

Need custom paths or cost modes? Pass them as arguments:

```json
{
	"mcpServers": {
		"zccusage": {
			"command": "bunx",
			"args": [
				"@zccusage/mcp@latest",
				"--mode",
				"calculate",
				"--type",
				"http",
				"--port",
				"8080"
			],
			"env": {
				"CLAUDE_CONFIG_DIR": "/path/to/claude/data"
			}
		}
	}
}
```

After updating the file, restart Claude Desktop so it picks up the new MCP server.

### Example prompts inside Claude Desktop

- "Ask the zccusage MCP server for today's usage report"
- "Show me the sessions with the highest cost this week"
- "Summarize my current billing block"

## Library Usage

Prefer to embed the MCP server directly? Import it from the library just like before:

```ts
import { createMcpServer } from '@zccusage/mcp';

const server = createMcpServer();
// ...connect it to the transport of your choice
```

See the [Library Usage guide](/guide/library-usage) for more examples.
