import process from 'node:process';
import { define } from 'gunshi';
import { DEFAULT_DUCKDB_PATH, resolveCcSwitchConfigDir } from '../_consts.ts';
import { sharedCommandConfig } from '../_shared-args.ts';
import { startSwitchWatcher } from '../_switch-watcher.ts';
import { logger } from '../logger.ts';

/**
 * `zccusage watch` — foreground switch watcher (W1 fallback for pure-CLI users
 * without the MCP server running). Monitors cc-switch live config files and
 * records switches into `provider_switch_history`.
 *
 * `--daemon` is reserved for future background daemonization; for now the
 * watcher runs in the foreground (use nohup/systemd for production).
 */
export const watchCommand = define({
	name: 'watch',
	description: 'Monitor cc-switch provider switches and record history (foreground).',
	...sharedCommandConfig,
	args: {
		...sharedCommandConfig.args,
		daemon: {
			type: 'boolean',
			description: 'Run as background daemon (not yet implemented; foreground only).',
			default: false,
		},
	},
	toKebab: true,
	async run(ctx) {
		const configDir = resolveCcSwitchConfigDir();
		const duckdbPath = (ctx.values.dbPath) ?? DEFAULT_DUCKDB_PATH;
		logger.log(`Starting switch watcher (config: ${configDir}, duckdb: ${duckdbPath})`);
		logger.log('Press Ctrl+C to stop.');
		const handle = await startSwitchWatcher({ configDir, duckdbPath });
		const shutdown = async (): Promise<void> => {
			await handle.stop();
			process.exit(0);
		};
		process.on('SIGINT', () => void shutdown());
		process.on('SIGTERM', () => void shutdown());
		// Keep process alive until signaled.
		await new Promise(() => {});
	},
});
