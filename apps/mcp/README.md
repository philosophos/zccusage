<div align="center">
    <img src="https://cdn.jsdelivr.net/gh/cobra91/better-ccusage@main/docs/public/logo.svg" alt="zccusage logo" width="256" height="256">
    <h1>@zccusage/mcp</h1>
</div>

<p align="center">
    <a href="https://socket.dev/api/npm/package/@zccusage/mcp"><img src="https://socket.dev/api/badge/npm/package/@zccusage/mcp" alt="Socket Badge" /></a>
    <a href="https://npmjs.com/package/@zccusage/mcp"><img src="https://img.shields.io/npm/v/@zccusage/mcp?color=yellow" alt="npm version" /></a>
    <a href="https://tanstack.com/stats/npm?packageGroups=%5B%7B%22packages%22:%5B%7B%22name%22:%22@zccusage/mcp%22%7D%5D%7D%5D&range=30-days&transform=none&binType=daily&showDataMode=all&height=400"><img src="https://img.shields.io/npm/dy/@zccusage/mcp" alt="NPM Downloads" /></a>
    <a href="https://packagephobia.com/result?p=@zccusage/mcp"><img src="https://packagephobia.com/badge?p=@zccusage/mcp" alt="install size" /></a>
    <a href="https://deepwiki.com/cobra91/better-ccusage"><img src="https://deepwiki.com/badge.svg" alt="Ask DeepWiki"></a>
</p>

<div align="center">
    <img src="https://cdn.jsdelivr.net/gh/cobra91/better-ccusage@main/docs/public/mcp-claude-desktop.avif" alt="Claude Desktop MCP integration screenshot" width="640">
</div>

> MCP (Model Context Protocol) server implementation for zccusage - provides Claude Code/Droid Usage data through the MCP protocol.

## Quick Start

```bash
# Using bunx (recommended for speed)
bunx @zccusage/mcp@latest

# Using npx
npx @zccusage/mcp@latest

# Start with HTTP transport
bunx @zccusage/mcp@latest -- --type http --port 8080
```

## Integrations

### Claude Desktop Integration

Add to your Claude Desktop MCP configuration:

```json
{
	"mcpServers": {
		"zccusage": {
			"command": "npx",
			"args": ["@zccusage/mcp@latest"],
			"type": "stdio"
		}
	}
}
```

### Claude Code

```sh
claude mcp add zccusage npx -- @zccusage/mcp@latest
```

## Documentation

For full documentation, visit **[zccusage.com/guide/mcp-server](https://zccusage.com/guide/mcp-server)**

## Sponsors

### Featured Sponsor

<p align="center">
    <a href="https://github.com/sponsors/cobra91">
        Cobra91
    </a>
</p>

## License

MIT © [@cobra91](https://github.com/cobra91)
