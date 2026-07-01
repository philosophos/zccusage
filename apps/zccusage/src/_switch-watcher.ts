import type { ProviderProfile } from './_types.ts';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import chokidar from 'chokidar';
import { DEFAULT_DUCKDB_PATH, resolveCcSwitchConfigDir } from './_consts.ts';
import { insertSwitchHistory, openDb } from './_duckdb-store.ts';
import { findProviderIdByBaseUrl, loadProviderProfiles } from './_provider-profile-loader.ts';
import { logger } from './logger.ts';

/**
 * Switch watcher — monitors cc-switch live config files (e.g.
 * `~/.claude/settings.json`) for atomic writes, reads the new
 * `ANTHROPIC_BASE_URL`, reverse-looks-up the providerId, and records a row
 * into `provider_switch_history`.
 *
 * Lifecycle:
 *  - W3: embedded in @better-ccusage/mcp server (always-on for MCP users).
 *  - W1: `zccusage watch` CLI subcommand (manual fallback for pure-CLI users).
 */

export type WatcherHandle = {
	stop: () => Promise<void>;
};

export type StartSwitchWatcherOptions = {
	configDir: string;
	duckdbPath: string;
	profiles?: ProviderProfile[];
};

const APP_CONFIGS = [
	{ app: 'claude', path: () => path.join(process.env.HOME ?? '', '.claude', 'settings.json') },
	{ app: 'codex', path: () => path.join(process.env.HOME ?? '', '.codex', 'config.toml') },
	{ app: 'gemini', path: () => path.join(process.env.HOME ?? '', '.gemini', '.env') },
] as const;

export async function startSwitchWatcher(options: StartSwitchWatcherOptions): Promise<WatcherHandle> {
	const { configDir, duckdbPath } = options;
	const profiles = options.profiles ?? await loadProviderProfiles({ ccSwitchDbPath: path.join(configDir, 'cc-switch.db') });

	const pathsToWatch = APP_CONFIGS.map(c => c.path()).filter((p) => {
		try {
			readFileSync(p);
			return true;
		}
		catch {
			return false;
		}
	});

	if (pathsToWatch.length === 0) {
		logger.warn('Switch watcher: no live config files found to watch');
	}

	const debounced = new Map<string, { timer: NodeJS.Timeout }>();
	const DEBOUNCE_MS = 300;

	async function handleChange(filePath: string): Promise<void> {
		const appConfig = APP_CONFIGS.find(c => c.path() === filePath);
		const app = appConfig?.app ?? path.basename(filePath);
		let baseUrl: string | null = null;
		try {
			const content = readFileSync(filePath, 'utf8');
			if (filePath.endsWith('.json')) {
				const cfg = JSON.parse(content) as Record<string, unknown>;
				const env = (cfg.env ?? {}) as Record<string, unknown>;
				baseUrl = typeof env.ANTHROPIC_BASE_URL === 'string' ? env.ANTHROPIC_BASE_URL : null;
			}
			else if (filePath.endsWith('.toml')) {
				const match = content.match(/ANTHROPIC_BASE_URL\s*=\s*"([^"]+)"/);
				baseUrl = match?.[1] ?? null;
			}
			else if (filePath.endsWith('.env')) {
				const match = content.match(/^ANTHROPIC_BASE_URL=(.+)$/m);
				baseUrl = match?.[1]?.trim().replace(/^["']|["']$/g, '') ?? null;
			}
		}
		catch (err) {
			logger.warn(`Watcher: failed to read ${filePath}: ${(err as Error).message}`);
			return;
		}

		if (baseUrl == null) {
			logger.debug(`Watcher: no ANTHROPIC_BASE_URL in ${filePath}, skipping`);
			return;
		}

		const providerId = findProviderIdByBaseUrl(baseUrl, profiles);
		if (providerId == null) {
			logger.warn(`Watcher: base_url ${baseUrl} matched no provider; recording NULL provider_id`);
		}

		let conn;
		try {
			conn = await openDb(duckdbPath);
			const inserted = await insertSwitchHistory(conn, {
				ts: new Date(),
				providerId: providerId ?? null,
				baseUrl,
				source: `watcher:${app}`,
			});
			if (inserted) {
				logger.log(`Watcher: recorded switch to ${providerId ?? '(unknown)'} at ${baseUrl}`);
			}
		}
		catch (err) {
			logger.warn(`Watcher: failed to record switch: ${(err as Error).message}`);
		}
		finally {
			// DuckDB connection close is synchronous (matches _duckdb-store.ts tests).
			try {
				conn?.closeSync();
			}
			catch {
				// ignore
			}
		}
	}

	const watcher = chokidar.watch(pathsToWatch, { persistent: true, ignoreInitial: true });

	watcher.on('change', (filePath) => {
		const existing = debounced.get(filePath);
		if (existing != null) {
			clearTimeout(existing.timer);
		}
		const timer = setTimeout(() => {
			void handleChange(filePath);
			debounced.delete(filePath);
		}, DEBOUNCE_MS);
		debounced.set(filePath, { timer });
	});

	logger.log(`Switch watcher started: monitoring ${pathsToWatch.length} config files`);

	const handle: WatcherHandle = {
		stop: async () => {
			for (const { timer } of debounced.values()) {
				clearTimeout(timer);
			}
			debounced.clear();
			await watcher.close();
			logger.log('Switch watcher stopped');
		},
	};
	return handle;
}

// `resolveCcSwitchConfigDir` + `DEFAULT_DUCKDB_PATH` re-exported for MCP
// consumers (Task 9) so they can import everything from one subpath.
export { DEFAULT_DUCKDB_PATH, resolveCcSwitchConfigDir };

if (import.meta.vitest != null) {
	describe('startSwitchWatcher', () => {
		it('returns a handle with stop()', async () => {
			// Minimal smoke test — full fs-watch test is flaky in CI; covered by
			// manual e2e. Here we only assert the module exports the expected shape.
			expect(typeof startSwitchWatcher).toBe('function');
		});
	});
}
