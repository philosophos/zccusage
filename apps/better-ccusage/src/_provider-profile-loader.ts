import type { Database, SqlJsStatic, SqlValue } from 'sql.js';
import type { ProviderProfile } from './_types.ts';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import initSqlJs from 'sql.js';
import { CC_SWITCH_DB_PATHS } from './_consts.ts';
import { logger } from './logger.ts';

/**
 * Provider profile loader — auto-reads the cc-switch SQLite DB to build
 * `ProviderProfile` objects (the *sales platforms* that bill for API usage).
 *
 * A profile is identified by BASE_URL. The model *supplier* is NOT a profile
 * field: it is encoded in the per-entry `model_id` string, so
 * `(providerId, model_id)` fully determines `(platform, supplier, model)`.
 *
 * DB is opened read-only via `sql.js` (pure WASM, no native binding). If the
 * DB is missing or unreadable, this degrades to an empty list (callers then
 * rely on user-supplied `providerProfiles` config).
 */

// Resolve sql.js's WASM payload via the node module path (source/dev mode).
// ⚠️ Build-time bundling (tsdown) must emit sql-wasm.wasm as a bundled asset
//    and adjust `locateFile` accordingly — see plan high-risk point #5.
const nodeRequire = createRequire(import.meta.url);
let sqlEnginePromise: Promise<SqlJsStatic> | undefined;
async function getSqlEngine(): Promise<SqlJsStatic> {
	if (sqlEnginePromise == null) {
		sqlEnginePromise = initSqlJs({
			locateFile: (file: string) => {
				try {
					return nodeRequire.resolve(`sql.js/dist/${file}`);
				}
				catch {
					return nodeRequire.resolve(`sql.js/${file}`);
				}
			},
		});
	}
	return sqlEnginePromise;
}

/**
 * Slot env vars in cc-switch `settings_config.env` that map Claude Code's
 *  alias slots to the actual model_id served by the platform.
 */
const SLOT_ENV_KEYS = [
	'ANTHROPIC_DEFAULT_OPUS_MODEL',
	'ANTHROPIC_DEFAULT_SONNET_MODEL',
	'ANTHROPIC_DEFAULT_HAIKU_MODEL',
	'ANTHROPIC_MODEL',
	'ANTHROPIC_REASONING_MODEL',
] as const;

const SLOT_NAMES: Record<string, string> = {
	ANTHROPIC_DEFAULT_OPUS_MODEL: 'opus',
	ANTHROPIC_DEFAULT_SONNET_MODEL: 'sonnet',
	ANTHROPIC_DEFAULT_HAIKU_MODEL: 'haiku',
	ANTHROPIC_MODEL: 'default',
	ANTHROPIC_REASONING_MODEL: 'reasoning',
};

export type LoadProviderProfileOptions = {
	ccSwitchDbPath?: string; // explicit override
	appType?: string; // filter by app_type (default: 'claude')
};

/**
 * Resolve the cc-switch DB path: explicit override, else the first existing
 * default candidate.
 */
function resolveDbPath(ccSwitchDbPath?: string): string | undefined {
	if (ccSwitchDbPath != null && ccSwitchDbPath !== '') {
		return ccSwitchDbPath;
	}
	for (const candidate of CC_SWITCH_DB_PATHS) {
		try {
			readFileSync(candidate); // exists + readable
			return candidate;
		}
		catch {
			continue;
		}
	}
	return undefined;
}

/**
 * Parse a cc-switch `settings_config` JSON blob into the profile fields we
 * care about (base_url + slot→model_id alias map).
 */
function parseSettingsConfig(raw: string | null | undefined): {
	baseUrl?: string;
	modelAliasMap?: Record<string, string>;
} {
	if (raw == null || raw === '') {
		return {};
	}
	let cfg: Record<string, unknown>;
	try {
		cfg = JSON.parse(raw) as Record<string, unknown>;
	}
	catch {
		return {};
	}
	const env = (cfg.env ?? {}) as Record<string, unknown>;
	const baseUrl = typeof env.ANTHROPIC_BASE_URL === 'string' ? env.ANTHROPIC_BASE_URL : undefined;
	const modelAliasMap: Record<string, string> = {};
	for (const key of SLOT_ENV_KEYS) {
		const value = env[key];
		if (typeof value === 'string' && value !== '') {
			const slot = SLOT_NAMES[key] ?? key;
			modelAliasMap[slot] = value;
		}
	}
	return { baseUrl, modelAliasMap };
}

function toNumber(value: SqlValue | undefined): number | undefined {
	if (typeof value === 'number') {
		return value;
	}
	if (typeof value === 'string' && value !== '') {
		const n = Number(value);
		return Number.isFinite(n) ? n : undefined;
	}
	return undefined;
}

function toBoolean(value: SqlValue | undefined): boolean | undefined {
	if (typeof value === 'number') {
		return value !== 0;
	}
	if (typeof value === 'boolean') {
		return value;
	}
	if (typeof value === 'string') {
		return value === '1' || value.toLowerCase() === 'true';
	}
	return undefined;
}

function rowToProfile(row: Record<string, SqlValue>): ProviderProfile {
	const settings = parseSettingsConfig(typeof row.settings_config === 'string' ? row.settings_config : null);
	const profile: ProviderProfile = {
		id: String(row.id ?? ''),
		name: String(row.name ?? ''),
		appType: String(row.app_type ?? ''),
		category: typeof row.category === 'string' ? row.category : undefined,
		baseUrl: settings.baseUrl,
		modelAliasMap: settings.modelAliasMap,
		costMultiplier: toNumber(row.cost_multiplier),
		limitDailyUsd: toNumber(row.limit_daily_usd),
		limitMonthlyUsd: toNumber(row.limit_monthly_usd),
		providerType: typeof row.provider_type === 'string' ? row.provider_type : undefined,
		isCurrent: toBoolean(row.is_current),
	};
	return profile;
}

/**
 * Load provider profiles from the cc-switch DB. Returns an empty array if the
 * DB is missing/unreadable. Caller may layer `providerOverrides` /
 * `providerProfiles` config on top.
 */
export async function loadProviderProfiles(options: LoadProviderProfileOptions = {}): Promise<ProviderProfile[]> {
	const dbPath = resolveDbPath(options.ccSwitchDbPath);
	if (dbPath == null) {
		logger.debug('No cc-switch DB found; provider profiles will rely on user config only');
		return [];
	}

	let db: Database;
	try {
		const SQL = await getSqlEngine();
		const data = readFileSync(dbPath);
		db = new SQL.Database(data);
	}
	catch (err) {
		logger.warn(`Failed to open cc-switch DB at ${dbPath}: ${(err as Error).message}`);
		return [];
	}

	try {
		const appType = options.appType ?? 'claude';
		const stmt = db.prepare(
			'SELECT id, name, app_type, settings_config, category, cost_multiplier, limit_daily_usd, limit_monthly_usd, provider_type, is_current FROM providers WHERE app_type = ?',
		);
		stmt.bind([appType]);
		const profiles: ProviderProfile[] = [];
		while (stmt.step()) {
			const row = stmt.getAsObject();
			profiles.push(rowToProfile(row));
		}
		stmt.free();
		return profiles;
	}
	catch (err) {
		logger.warn(`Failed to query cc-switch DB at ${dbPath}: ${(err as Error).message}`);
		return [];
	}
	finally {
		db.close();
	}
}

// `getSqlEngine` keeps sql.js live for bundlers; the lazy memo ensures the WASM
// init runs once per process.

// ─── In-source tests ─────────────────────────────────────────────────────────

if (import.meta.vitest != null) {
	describe('loadProviderProfiles', () => {
		it('returns empty when DB path does not exist', async () => {
			const profiles = await loadProviderProfiles({ ccSwitchDbPath: '/nonexistent/cc-switch.db' });
			expect(profiles).toEqual([]);
		});
	});
}
