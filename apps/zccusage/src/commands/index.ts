import process from 'node:process';
import { cli } from 'gunshi';
import packageJson from '../../package.json' with { type: 'json' };
import { blocksCommand } from './blocks.ts';
import { statuslineCommand } from './statusline.ts';
import { usageCommand } from './usage.ts';
import { watchCommand } from './watch.ts';

const { description, name, version } = packageJson;

// Re-export all commands for easy importing
export { blocksCommand, statuslineCommand, usageCommand, watchCommand };

/**
 * Command entries as tuple array.
 *
 * daily/weekly/monthly/session are no longer subcommands — they are selected
 * via the `--group` flag on the main `usageCommand`. `blocks`, `statusline`,
 * and `watch` remain as subcommands (their structure does not fit `--group`).
 */
export const subCommandUnion = [
	['blocks', blocksCommand],
	['statusline', statuslineCommand],
	['watch', watchCommand],
] as const;

/**
 * Available command names extracted from union
 */
export type CommandName = typeof subCommandUnion[number][0];

/**
 * Map of available CLI subcommands
 */
const subCommands = new Map();
for (const [name, command] of subCommandUnion) {
	subCommands.set(name, command);
}

/**
 * Default command when no subcommand is specified.
 */
const mainCommand = usageCommand;

/**
 * Entry point for the CLI. Parses process arguments and delegates to Gunshi's
 * CLI runner with the configured subcommands.
 */
export async function run(): Promise<void> {
	// When invoked through npx, the binary name might be passed as the first argument
	// Filter it out if it matches the expected binary name
	let args = process.argv.slice(2);
	if (args[0] === 'better-ccusage') {
		args = args.slice(1);
	}

	await cli(args, mainCommand, {
		name,
		version,
		description,
		subCommands,
		renderHeader: null,
	});
}
