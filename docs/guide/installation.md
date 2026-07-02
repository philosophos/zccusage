# Installation

zccusage can be installed and used in several ways depending on your preferences and use case.

## Why No Installation Needed?

Thanks to zccusage's incredibly small bundle size, you don't need to install it globally. Unlike other CLI tools, we pay extreme attention to bundle size optimization, achieving an impressively small footprint even without minification. This means:

- ✅ Near-instant startup times
- ✅ Minimal download overhead
- ✅ Always use the latest version
- ✅ No global pollution of your system

## Quick Start (Recommended)

The fastest way to use zccusage is to run it directly:

::: code-group

```bash [bunx (Recommended)]
bunx zccusage
```

```bash [npx]
npx zccusage@latest
```

```bash [pnpm]
pnpm dlx zccusage
```

```bash [deno]
deno run -E -R=$HOME/.claude/projects/ -S=homedir -N='raw.githubusercontent.com:443' npm:zccusage@latest
```

:::

::: tip Speed Recommendation
We strongly recommend using `bunx` instead of `npx` due to the massive speed difference. Bunx caches packages more efficiently, resulting in near-instant startup times after the first run.
:::

::: info Deno Security
Consider using `deno run` if you want additional security controls. Deno allows you to specify exact permissions, making it safer to run tools you haven't audited.
:::

### Performance Comparison

Here's why runtime choice matters:

| Runtime  | First Run | Subsequent Runs | Notes               |
| -------- | --------- | --------------- | ------------------- |
| bunx     | Fast      | **Instant**     | Best overall choice |
| npx      | Slow      | Moderate        | Widely available    |
| pnpm dlx | Fast      | Fast            | Good alternative    |
| deno     | Moderate  | Fast            | Best for security   |

## Global Installation (Optional)

While not necessary due to our small bundle size, you can still install zccusage globally if you prefer:

::: code-group

```bash [npm]
npm install -g zccusage
```

```bash [bun]
bun install -g zccusage
```

```bash [yarn]
yarn global add zccusage
```

```bash [pnpm]
pnpm add -g zccusage
```

:::

After global installation, run commands directly:

```bash
zccusage daily
zccusage monthly --breakdown
zccusage blocks --live
```

## Development Installation

For development or contributing to zccusage:

```bash
# Clone the repository
git clone https://github.com/cobra91/zccusage.git
cd zccusage

# Install dependencies
bun install

# Run directly from source
bun run start daily
bun run start monthly --json
```

### Development Scripts

```bash
# Run tests
bun run test

# Type checking
bun typecheck

# Build distribution
bun run build

# Lint and format
bun run format
```

## Runtime Requirements

### Node.js

- **Minimum**: Node.js 20.x
- **Recommended**: Node.js 20.x or later
- **LTS versions** are fully supported

### Bun (Alternative)

- **Minimum**: Bun 1.2+
- **Recommended**: Latest stable release
- Often faster than Node.js for zccusage

### Deno

Deno 2.0+ is fully supported with proper permissions:

```bash
deno run \
  -E \
  -R=$HOME/.claude/projects/ \
  -S=homedir \
  -N='raw.githubusercontent.com:443' \
  npm:zccusage@latest
```

## Verification

After installation, verify zccusage is working:

```bash
# Check version
zccusage --version

# Run help command
zccusage --help

# Test with daily report
zccusage daily
```

## Updating

### Direct Execution (npx/bunx)

Always gets the latest version automatically.

### Global Installation

```bash
# Update with npm
npm update -g zccusage

# Update with bun
bun update -g zccusage
```

### Check Current Version

```bash
zccusage --version
```

## Uninstalling

### Global Installation

::: code-group

```bash [npm]
npm uninstall -g zccusage
```

```bash [bun]
bun remove -g zccusage
```

```bash [yarn]
yarn global remove zccusage
```

```bash [pnpm]
pnpm remove -g zccusage
```

:::

### Development Installation

```bash
# Remove cloned repository
rm -rf zccusage/
```

## Troubleshooting Installation

### Permission Errors

If you get permission errors during global installation:

::: code-group

```bash [npm]
# Use npx instead of global install
npx zccusage@latest

# Or configure npm to use a different directory
npm config set prefix ~/.npm-global
export PATH=~/.npm-global/bin:$PATH
```

```bash [Node Version Managers]
# Use nvm (recommended)
nvm install node
npm install -g zccusage

# Or use fnm
fnm install node
npm install -g zccusage
```

:::

### Network Issues

If installation fails due to network issues:

```bash
# Try with different registry
npm install -g zccusage --registry https://registry.npmjs.org

# Or use bunx
bunx zccusage
```

### Version Conflicts

If you have multiple versions installed:

```bash
# Check which version is being used
which zccusage
zccusage --version

# Uninstall and reinstall
npm uninstall -g zccusage
npm install -g zccusage@latest
```

## Next Steps

After installation, check out:

- [Getting Started Guide](/guide/getting-started) - Your first usage report with multi-provider support
- [Configuration](/guide/configuration) - Customize zccusage behavior
- [Daily Reports](/guide/daily-reports) - Understand daily usage patterns

**Note**: zccusage automatically detects and supports multiple AI providers including Anthropic (Claude), Moonshot AI (kimi), MiniMax, Zai, and GLM models. No configuration needed!
