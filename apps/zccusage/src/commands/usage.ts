import process from 'node:process';
import { define } from 'gunshi';
import { WEEK_DAYS } from '../_consts.ts';
import { sharedCommandConfig } from '../_shared-args.ts';
import { parseGroup } from '../_tree-renderer.ts';
import { logger } from '../logger.ts';
import { dailyCommand } from './daily.ts';
import { monthlyCommand } from './monthly.ts';
import { sessionCommand } from './session.ts';
import { weeklyCommand } from './weekly.ts';

/**
 * Unified main command. Replaces the former daily/weekly/monthly/session
 * subcommands: the time-bucket is now selected by a `--group` value instead of
 * a subcommand name. `--group` also carries the tree nesting dims.
 *
 * Dispatch reads the bucket from `--group` and delegates to the matching
 * per-bucket command's `run` (daily/weekly/monthly/session). No bucket → daily
 * loader with no time aggregation (the dims alone drive nesting).
 *
 * Per-bucket flags (--instances, --project, --start-of-week, --id) are declared
 * here as global flags so ctx.values is fully populated before delegation.
 */
export const usageCommand = define({
	name: 'usage',
	description: 'Show usage report. Use --group to pick a time-bucket (daily|weekly|monthly|session) and nesting dims (project,provider,agent,reseller,region,plan,model).',
	...sharedCommandConfig,
	args: {
		...sharedCommandConfig.args,
		instances: {
			type: 'boolean',
			short: 'i',
			description: 'Show usage breakdown by project/instance (daily bucket).',
			default: false,
		},
		project: {
			type: 'string',
			short: 'p',
			description: 'Filter to a specific project name (daily bucket).',
		},
		projectAliases: {
			type: 'string',
			description: 'Comma-separated project aliases (e.g., \'zccusage=Usage Tracker,myproject=My Project\')',
			hidden: true,
		},
		startOfWeek: {
			type: 'enum',
			short: 'w',
			description: 'Day to start the week on (weekly bucket).',
			default: 'sunday' as const,
			choices: WEEK_DAYS,
		},
		id: {
			type: 'string',
			description: 'Load usage data for a specific session ID (session bucket).',
		},
	},
	toKebab: true,
	async run(ctx) {
		const groupRaw = (ctx.values.group ?? ctx.values.treeGroup);
		let parsed: ReturnType<typeof parseGroup>;
		try {
			parsed = parseGroup(groupRaw, 'daily');
		}
		catch (error) {
			logger.error((error as Error).message);
			process.exit(1);
		}
		const { bucket } = parsed;

		// Delegate to the matching per-bucket command. ctx.values already carries
		// every shared + per-bucket flag (a superset of each delegate's args), so
		// the delegate reads from the same ctx. Each delegate's `run` expects its
		// own (narrower) ctx type; cast through `unknown` to bridge the structural
		// mismatch on the `args` schema metadata.
		const run = (cmd: { run?: unknown }): ((c: typeof ctx) => Promise<void>) | undefined =>
			cmd.run as ((c: typeof ctx) => Promise<void>) | undefined;
		switch (bucket) {
			case 'weekly':
				await run(weeklyCommand)?.(ctx);
				break;
			case 'monthly':
				await run(monthlyCommand)?.(ctx);
				break;
			case 'session':
				await run(sessionCommand)?.(ctx);
				break;
			case 'daily':
			case null:
				// 'daily' bucket, or no bucket → daily loader (no time aggregation).
				await run(dailyCommand)?.(ctx);
				break;
		}
	},
});
