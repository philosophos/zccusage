/**
 * @fileoverview DuckDB OLAP persistence layer for usage facts.
 *
 * Replaces the stateless "glob all JSONL + JS parse + memory aggregate" model
 * with a persistent columnar store. Each CLI run does a fast incremental ingest
 * (mtime-skip unchanged files) then queries via SQL GROUP BY — sub-300ms at
 * 100k+ entries vs seconds for the old full-rescan path.
 *
 * Engine: `@duckdb/node-api` (native, prebuilt). Listed as a runtime
 * dependency (not bundled) because native `.node` binaries cannot be embedded
 * in a tsdown bundle — it is resolved from `node_modules` at run time.
 *
 * Schema grain: one row per JSONL entry (`usage_facts`). Ad-hoc queries across
 * any dimension (day/agent/provider/node/model/session) aggregate via SQL.
 * `costByCurrency` is computed at query time (pricing changes), not stored.
 */

import type { DuckDBConnection, DuckDBValue } from '@duckdb/node-api';
import type { ProviderHistoryEntry } from './_types.ts';
import type { ProviderResolutionContext } from './_provider-profile-loader.ts';
import type { LoadOptions, UsageData } from './data-loader.ts';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import process from 'node:process';
import { DuckDBInstance } from '@duckdb/node-api';
import { DEFAULT_DUCKDB_PATH } from './_consts.ts';
import { resolveProviderId } from './_provider-profile-loader.ts';
import { extractProjectFromPath, getClaudePaths, globUsageFiles } from './data-loader.ts';
import { getDroidPath, processDroidSessions } from './droid-adapter.ts';
import { logger } from './logger.ts';

/**
 * DDL for the facts table and ingestion bookkeeping. Idempotent — safe to run
 * on every open. `message_hash` is the dedup key (matches `createUniqueHash`
 * semantics: `messageId:requestId` when present, else a per-row fingerprint).
 */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS usage_facts (
	message_hash TEXT PRIMARY KEY,
	timestamp TIMESTAMPTZ,
	session_id TEXT,
	project TEXT,
	source TEXT,
	source_path TEXT,
	model TEXT,
	provider_id TEXT,
	input_tokens BIGINT,
	output_tokens BIGINT,
	cache_creation_tokens BIGINT,
	cache_read_tokens BIGINT,
	cost_usd REAL,
	version TEXT,
	ingested_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_facts_ts ON usage_facts(timestamp);
CREATE INDEX IF NOT EXISTS idx_facts_model ON usage_facts(model);
CREATE INDEX IF NOT EXISTS idx_facts_provider ON usage_facts(provider_id);
CREATE INDEX IF NOT EXISTS idx_facts_session ON usage_facts(session_id);

CREATE TABLE IF NOT EXISTS ingested_files (
	path TEXT PRIMARY KEY,
	mtime BIGINT,
	size BIGINT,
	file_hash TEXT,
	ingested_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS ingest_meta (
	key TEXT PRIMARY KEY,
	value TEXT
);

CREATE TABLE IF NOT EXISTS provider_switch_history (
	ts TIMESTAMPTZ,
	provider_id TEXT,
	base_url TEXT,
	source TEXT
);
CREATE INDEX IF NOT EXISTS idx_history_ts ON provider_switch_history(ts);
`;

/**
 * Ingest one Claude JSONL file into `usage_facts` via DuckDB's `read_json_auto`
 * (vectorized C/C++ JSON reader — far faster than JS valibot per-line parse).
 * Dedups on `message_hash` via ON CONFLICT. Rows missing required fields
 * (timestamp / usage tokens) are skipped to match valibot schema validation.
 *
 * `provider_id` is left NULL here and resolved in a second pass (TS logic —
 * `resolveProviderId` needs cc-switch DB + providerSchedule config).
 */
export async function ingestClaudeFile(
	conn: DuckDBConnection,
	filePath: string,
	project: string,
): Promise<number> {
	const before = await runQuery<{ c: number }>(conn, 'SELECT COUNT(*) AS c FROM usage_facts WHERE source_path = $p', { p: filePath });
	const beforeCount = Number(before[0]?.c ?? 0);
	// Replace existing rows for this file (handles re-ingest of changed files).
	await conn.run('DELETE FROM usage_facts WHERE source_path = $p', { p: filePath });
	// Session ID comes from the .jsonl filename (matches the legacy loader, which
	// uses `path.basename(file, '.jsonl')` — the JSONL `sessionId` field can be
	// null/missing on some entries, so deriving from the filename is the robust
	// parity-preserving choice).
	const sessionId = basename(filePath, '.jsonl');
	await conn.run(
		`INSERT INTO usage_facts (
			message_hash, timestamp, session_id, project, source, source_path,
			model, provider_id, input_tokens, output_tokens,
			cache_creation_tokens, cache_read_tokens, cost_usd, version, ingested_at
		)
		SELECT
			CASE WHEN message.id IS NOT NULL
				THEN md5(COALESCE(message.id::TEXT, '') || ':' || COALESCE(requestId::TEXT, ''))
				ELSE md5(
					COALESCE(timestamp::TEXT, '') ||
					COALESCE($session_id::TEXT, '') ||
					COALESCE(message.model::TEXT, '') ||
					COALESCE(message.usage.input_tokens::TEXT, '') ||
					COALESCE(message.usage.output_tokens::TEXT, '') ||
					$file_path
				)
			END AS message_hash,
			timestamp,
			$session_id,
			$project,
			'claude',
			$file_path,
			message.model,
			NULL,
			message.usage.input_tokens,
			message.usage.output_tokens,
			message.usage.cache_creation_input_tokens,
			message.usage.cache_read_input_tokens,
			costUSD,
			version,
			CURRENT_TIMESTAMP
		FROM read_json_auto($file_path, columns={
			'timestamp': 'TIMESTAMP',
			'sessionId': 'VARCHAR',
			'requestId': 'VARCHAR',
			'costUSD': 'DOUBLE',
			'version': 'VARCHAR',
			'message': 'STRUCT(id VARCHAR, model VARCHAR, usage STRUCT(input_tokens BIGINT, output_tokens BIGINT, cache_creation_input_tokens BIGINT, cache_read_input_tokens BIGINT))'
		})
		WHERE timestamp IS NOT NULL
			AND message.usage.input_tokens IS NOT NULL
			AND message.usage.output_tokens IS NOT NULL
		ON CONFLICT(message_hash) DO NOTHING`,
		{ file_path: filePath, project, session_id: sessionId },
	);
	const after = await runQuery<{ c: number }>(conn, 'SELECT COUNT(*) AS c FROM usage_facts WHERE source_path = $p', { p: filePath });
	const afterCount = Number(after[0]?.c ?? 0);
	// Rough delta of newly inserted rows for this file (not exact across-file dedup).
	return Math.max(0, afterCount - beforeCount);
}

/**
 * Run a query with named parameters (`$name` placeholders) and return rows as
 * plain objects. BIGINT values are coerced to JS `number` (token counts fit
 * safely within Number.MAX_SAFE_INTEGER).
 */
export async function runQuery<T = Record<string, unknown>>(
	conn: DuckDBConnection,
	sql: string,
	params: Record<string, DuckDBValue> = {},
): Promise<T[]> {
	const reader = await conn.runAndReadAll(sql, params);
	const cols = reader.columnNames();
	const rows = reader.getRows();
	const result: T[] = [];
	for (const row of rows) {
		const obj: Record<string, unknown> = {};
		for (let i = 0; i < cols.length; i++) {
			const col = cols[i];
			if (col == null) {
				continue;
			}
			const v = row[i];
			obj[col] = typeof v === 'bigint' ? Number(v) : v;
		}
		result.push(obj as T);
	}
	return result;
}

/**
 * Open (or create) a DuckDB file and ensure the schema exists. Returns a
 * cached connection — DuckDB is single-writer; our CLI usage is sequential.
 * Pass `:memory:` for an ephemeral in-process DB (used by tests).
 */
export async function openDb(dbPath: string = DEFAULT_DUCKDB_PATH): Promise<DuckDBConnection> {
	const instance = await DuckDBInstance.create(dbPath);
	const conn = await instance.connect();
	await conn.run(SCHEMA_SQL);
	return conn;
}

// ─── syncIngest: incremental ingest orchestrator ─────────────────────────────

/**
 * Options for `syncIngest`. `claudePaths` defaults to `getClaudePaths()`;
 * `droidPath` defaults to `getDroidPath()`. `providerContext` enables the
 * post-ingest `provider_id` resolution pass; omit it to leave `provider_id`
 * NULL (query layer falls back to static USD pricing). `rebuild` drops all
 * rows and re-ingests from scratch.
 */
export type SyncIngestOptions = {
	claudePaths?: string[];
	droidPath?: string;
	loadOptions?: LoadOptions;
	providerContext?: ProviderResolutionContext;
	rebuild?: boolean;
	onProgress?: (msg: string) => void;
};

/**
 * Result of a `syncIngest` run. Counts are best-effort (row deltas are
 * approximate because cross-file dedup via `ON CONFLICT DO NOTHING` can
 * suppress inserts from a later file).
 */
export type SyncIngestResult = {
	ingestedFiles: number;
	skippedFiles: number;
	deletedFiles: number;
	rowsInserted: number;
	droidRows: number;
	stale: boolean;
};

/**
 * Compute the `message_hash` for a parsed `UsageData` entry, mirroring the
 * SQL `md5(...)` logic in `ingestClaudeFile` so droid rows dedup against the
 * same key space as claude rows. Falls back to a content fingerprint when
 * `message.id` is absent (matches the SQL `ELSE` branch).
 */
function hashUsageEntry(entry: UsageData, sourcePath: string): string {
	const messageId = entry.message.id;
	if (messageId != null) {
		const requestId = entry.requestId ?? '';
		return createHash('md5').update(`${messageId}:${requestId}`).digest('hex');
	}
	const ts = entry.timestamp ?? '';
	const sessionId = entry.sessionId ?? '';
	const model = entry.message.model ?? '';
	const inputTokens = entry.message.usage.input_tokens ?? 0;
	const outputTokens = entry.message.usage.output_tokens ?? 0;
	return createHash('md5')
		.update(`${ts}${sessionId}${model}${inputTokens}${outputTokens}${sourcePath}`)
		.digest('hex');
}

/**
 * Insert a single parsed (droid) `UsageData` entry into `usage_facts`. Droid
 * sessions have no standard JSONL token layout, so they bypass `read_json_auto`
 * and are inserted row-by-row from TS. Dedups via `ON CONFLICT(message_hash)`.
 */
export async function insertUsageEntry(
	conn: DuckDBConnection,
	entry: UsageData,
	project: string,
	sourcePath: string,
	source: string = 'droid',
): Promise<void> {
	const messageHash = hashUsageEntry(entry, sourcePath);
	const ts = entry.timestamp != null ? new Date(entry.timestamp).toISOString() : null;
	await conn.run(
		`INSERT INTO usage_facts (
			message_hash, timestamp, session_id, project, source, source_path,
			model, provider_id, input_tokens, output_tokens,
			cache_creation_tokens, cache_read_tokens, cost_usd, version, ingested_at
		) VALUES (
			$message_hash, $timestamp, $session_id, $project, $source, $source_path,
			$model, NULL, $input_tokens, $output_tokens,
			$cache_creation_tokens, $cache_read_tokens, $cost_usd, $version, CURRENT_TIMESTAMP
		)
		ON CONFLICT(message_hash) DO NOTHING`,
		{
			message_hash: messageHash,
			timestamp: ts,
			session_id: entry.sessionId ?? null,
			project,
			source,
			source_path: sourcePath,
			model: entry.message.model ?? null,
			input_tokens: entry.message.usage.input_tokens ?? null,
			output_tokens: entry.message.usage.output_tokens ?? null,
			cache_creation_tokens: entry.message.usage.cache_creation_input_tokens ?? null,
			cache_read_tokens: entry.message.usage.cache_read_input_tokens ?? null,
			cost_usd: entry.costUSD ?? null,
			version: entry.version ?? null,
		},
	);
}

/**
 * Resolve `provider_id` for every row where it is still NULL, using
 * `resolveProviderId(timestamp, ctx)`. Run after the SQL+TS ingest passes.
 * Rows that cannot be resolved stay NULL (query layer treats them as
 * `unknown` and falls back to static USD pricing — preserves current
 * behavior).
 */
export async function resolveProviderIds(
	conn: DuckDBConnection,
	ctx: ProviderResolutionContext,
): Promise<number> {
	const rows = await runQuery<{ message_hash: string; ms: number }>(
		conn,
		'SELECT message_hash, EPOCH(timestamp) AS ms FROM usage_facts WHERE provider_id IS NULL',
	);
	let resolved = 0;
	for (const row of rows) {
		if (row.ms == null || Number.isNaN(row.ms)) {
			continue;
		}
		const providerId = resolveProviderId(row.ms * 1000, ctx);
		if (providerId == null) {
			continue;
		}
		await conn.run(
			'UPDATE usage_facts SET provider_id = $pid WHERE message_hash = $h',
			{ pid: providerId, h: row.message_hash },
		);
		resolved++;
	}
	return resolved;
}

/**
 * Record an observed provider switch into `provider_switch_history`. Called by
 * the watcher when a live-config atomic write is detected. Dedup: skips insert
 * if the most recent entry within 5 seconds has the same provider_id (chokidar
 * may fire multiple events for one atomic write).
 */
export async function insertSwitchHistory(
	conn: DuckDBConnection,
	entry: { ts: Date; providerId: string | null; baseUrl: string | null; source: string },
): Promise<boolean> {
	// Dedup: same provider within 5s = skip.
	const recent = await runQuery<{ provider_id: string | null }>(
		conn,
		`SELECT provider_id FROM provider_switch_history
		 WHERE ts >= CAST($ts AS TIMESTAMPTZ) - INTERVAL 5 SECOND
		 ORDER BY ts DESC LIMIT 1`,
		{ ts: entry.ts.toISOString() },
	);
	if (recent[0]?.provider_id === entry.providerId) {
		return false;
	}
	await conn.run(
		`INSERT INTO provider_switch_history (ts, provider_id, base_url, source)
		 VALUES ($ts, $pid, $url, $src)`,
		{
			ts: entry.ts.toISOString(),
			pid: entry.providerId,
			url: entry.baseUrl,
			src: entry.source,
		},
	);
	return true;
}

/**
 * Load all provider_switch_history rows ordered by ts ascending. Used by
 * `resolveProviderIds` to populate `ctx.history` for the in-memory priority
 * chain (keeps `resolveProviderId` a pure function — no DB access).
 */
export async function loadHistory(
	conn: DuckDBConnection,
): Promise<ProviderHistoryEntry[]> {
	const rows = await runQuery<{ ts: string; provider_id: string }>(
		conn,
		'SELECT ts, provider_id FROM provider_switch_history WHERE provider_id IS NOT NULL ORDER BY ts ASC',
	);
	return rows.map(r => ({
		ts: new Date(r.ts).getTime(),
		providerId: r.provider_id,
	}));
}

/**
 * Detect whether the provider schedule has changed since the last ingest.
 * Compares a hash of the current schedule against `ingest_meta.provider_schedule_hash`.
 * Returns true when the schedule changed (caller should warn + suggest `--rebuild`).
 * Mutates `ingest_meta` to persist the new hash when it changes.
 */
async function detectScheduleStale(
	conn: DuckDBConnection,
	ctx: ProviderResolutionContext | undefined,
): Promise<boolean> {
	if (ctx == null) {
		return false;
	}
	const scheduleJson = ctx.schedule != null
		? JSON.stringify(ctx.schedule.map(e => ({ from: e.from, to: e.to, providerId: e.providerId })))
		: '';
	const currentHash = createHash('sha256').update(scheduleJson).digest('hex');
	const prior = await runQuery<{ value: string }>(
		conn,
		'SELECT value FROM ingest_meta WHERE key = \'provider_schedule_hash\'',
	);
	const priorHash = prior[0]?.value;
	if (priorHash === currentHash) {
		return false;
	}
	await conn.run(
		`INSERT INTO ingest_meta (key, value) VALUES ('provider_schedule_hash', $h)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
		{ h: currentHash },
	);
	return true;
}

/**
 * Incremental ingest orchestrator. Discovers Claude JSONL files via
 * `globUsageFiles(getClaudePaths())`, skips unchanged files (mtime+size),
 * re-ingests changed/new files, deletes rows for removed files, then ingests
 * droid sessions via `processDroidSessions`. Optionally resolves `provider_id`
 * in a second TS pass.
 *
 * v1 schedule-stale handling: warn only — does not auto re-resolve. Use
 * `--rebuild` to force a full re-ingest + re-resolve.
 */
export async function syncIngest(
	conn: DuckDBConnection,
	options: SyncIngestOptions = {},
): Promise<SyncIngestResult> {
	const progress = options.onProgress ?? ((msg: string) => {
		logger.info(msg);
	});
	const result: SyncIngestResult = {
		ingestedFiles: 0,
		skippedFiles: 0,
		deletedFiles: 0,
		rowsInserted: 0,
		droidRows: 0,
		stale: false,
	};

	if (options.rebuild === true) {
		await conn.run('DELETE FROM usage_facts');
		await conn.run('DELETE FROM ingested_files');
		progress('Rebuild: cleared usage_facts and ingested_files');
	}

	// ── Claude JSONL discovery + incremental ingest ────────────────────────
	let claudePaths: string[];
	try {
		claudePaths = options.claudePaths ?? getClaudePaths();
	}
	catch (err) {
		logger.warn(`syncIngest: no Claude data directories found: ${(err as Error).message}`);
		result.stale = await detectScheduleStale(conn, options.providerContext);
		return result;
	}

	const discovered = await globUsageFiles(claudePaths);
	const fsFiles = new Map<string, { mtime: number; size: number }>();
	for (const { file } of discovered) {
		try {
			const st = statSync(file);
			fsFiles.set(file, { mtime: Math.floor(st.mtimeMs), size: Number(st.size) });
		}
		catch {
			// File vanished between glob and stat — skip; will be cleaned up next run.
		}
	}

	const ingestedRows = await runQuery<{ path: string; mtime: number; size: number }>(
		conn,
		'SELECT path, mtime, size FROM ingested_files',
	);
	const knownFiles = new Map<string, { mtime: number; size: number }>();
	for (const row of ingestedRows) {
		knownFiles.set(row.path, { mtime: Number(row.mtime), size: Number(row.size) });
	}

	// New/changed files.
	for (const [file, stat] of fsFiles) {
		const known = knownFiles.get(file);
		if (known != null && known.mtime === stat.mtime && known.size === stat.size) {
			result.skippedFiles++;
			continue;
		}
		const project = extractProjectFromPath(file);
		try {
			const inserted = await ingestClaudeFile(conn, file, project);
			result.rowsInserted += inserted;
			result.ingestedFiles++;
			await conn.run(
				`INSERT INTO ingested_files (path, mtime, size, file_hash, ingested_at)
				VALUES ($path, $mtime, $size, NULL, CURRENT_TIMESTAMP)
				ON CONFLICT(path) DO UPDATE SET mtime = excluded.mtime, size = excluded.size, ingested_at = excluded.ingested_at`,
				{ path: file, mtime: stat.mtime, size: stat.size },
			);
		}
		catch (err) {
			logger.warn(`syncIngest: failed to ingest ${file}: ${(err as Error).message}`);
		}
	}

	// Deleted files: in DB but no longer on fs.
	for (const [file] of knownFiles) {
		if (!fsFiles.has(file)) {
			await conn.run('DELETE FROM usage_facts WHERE source_path = $p', { p: file });
			await conn.run('DELETE FROM ingested_files WHERE path = $p', { p: file });
			result.deletedFiles++;
		}
	}

	// ── Droid sessions (TS parse → row-by-row INSERT) ──────────────────────
	const droidPath = options.droidPath ?? getDroidPath();
	if (droidPath !== '') {
		// Droid has no per-file mtime tracking in v1; re-ingest all each run.
		await conn.run('DELETE FROM usage_facts WHERE source = \'droid\'');
		try {
			const droidEntries = await processDroidSessions(droidPath, options.loadOptions ?? {});
			for (const entry of droidEntries) {
				const sessionId = entry.sessionId ?? 'unknown';
				const sourcePath = `droid://${sessionId}`;
				const project = entry.cwd ?? join('droid', 'unknown');
				await insertUsageEntry(conn, entry, project, sourcePath, 'droid');
				result.droidRows++;
			}
		}
		catch (err) {
			logger.warn(`syncIngest: droid ingest failed: ${(err as Error).message}`);
		}
	}

	// ── provider_id resolution pass ────────────────────────────────────────
	if (options.providerContext != null) {
		const resolved = await resolveProviderIds(conn, options.providerContext);
		if (resolved > 0) {
			progress(`Resolved provider_id for ${resolved} rows`);
		}
	}

	result.stale = await detectScheduleStale(conn, options.providerContext);
	if (result.stale) {
		logger.warn(
			'Provider schedule changed since last ingest — historical provider_id mapping may be stale. Run with --rebuild to re-resolve.',
		);
	}

	progress(
		`syncIngest: ${result.ingestedFiles} ingested, ${result.skippedFiles} skipped, ${result.deletedFiles} deleted, ${result.droidRows} droid rows`,
	);
	return result;
}

// ─── In-source tests ─────────────────────────────────────────────────────────

if (import.meta.vitest != null) {
	function makeFixture(name: string, lines: string[]): string {
		const dir = join(tmpdir(), `bcu-duckdb-${name}-${process.pid}`);
		rmSync(dir, { recursive: true, force: true });
		mkdirSync(dir, { recursive: true });
		const file = join(dir, 'session.jsonl');
		writeFileSync(file, lines.join('\n'));
		return file;
	}

	// Build a fake Claude data root: {root}/projects/{proj}/{file}.jsonl
	function makeClaudeRoot(name: string, files: Record<string, string[]>): string {
		const root = join(tmpdir(), `bcu-duckdb-${name}-${process.pid}`);
		rmSync(root, { recursive: true, force: true });
		mkdirSync(root, { recursive: true });
		for (const [relPath, lines] of Object.entries(files)) {
			const full = join(root, 'projects', relPath);
			mkdirSync(join(full, '..'), { recursive: true });
			writeFileSync(full, lines.join('\n'));
		}
		return root;
	}

	describe('duckdb-store', () => {
		it('openDb creates schema (tables exist)', async () => {
			const conn = await openDb(':memory:');
			const tables = await runQuery<{ table_name: string }>(
				conn,
				`SELECT table_name FROM information_schema.tables WHERE table_schema='main' ORDER BY table_name`,
			);
			expect(tables.map(t => t.table_name)).toContain('usage_facts');
			expect(tables.map(t => t.table_name)).toContain('ingested_files');
			conn.closeSync();
		});

		it('ingestClaudeFile inserts rows and dedups by messageId', async () => {
			const file = makeFixture('dedup', [
				JSON.stringify({ timestamp: '2026-01-01T10:00:00.000Z', message: { id: 'm1', model: 'glm-5.1', usage: { input_tokens: 10, output_tokens: 5 } }, costUSD: 0.01, sessionId: 's1', requestId: 'r1', version: '1.0.0' }),
				JSON.stringify({ timestamp: '2026-01-01T11:00:00.000Z', message: { id: 'm1', model: 'glm-5.1', usage: { input_tokens: 20, output_tokens: 10 } }, costUSD: 0.02, sessionId: 's1', requestId: 'r1' }),
				JSON.stringify({ timestamp: '2026-01-01T12:00:00.000Z', message: { id: 'm2', model: 'glm-5.1', usage: { input_tokens: 30, output_tokens: 15 } }, costUSD: 0.03, sessionId: 's1' }),
			]);
			const conn = await openDb(':memory:');
			const inserted = await ingestClaudeFile(conn, file, 'proj-a');
			expect(inserted).toBe(2); // m1 deduped across rows 1+2, m2 unique
			const rows = await runQuery<{ model: string; s: number; c: number }>(
				conn,
				'SELECT model, SUM(input_tokens) AS s, SUM(cost_usd) AS c FROM usage_facts GROUP BY 1',
			);
			expect(rows[0]?.model).toBe('glm-5.1');
			// m1 row1 (10) + m2 (30) = 40; m1 row2 deduped
			expect(rows[0]?.s).toBe(40);
			expect(rows[0]?.c).toBeCloseTo(0.04, 5);
			conn.closeSync();
		});

		it('skips rows missing required fields', async () => {
			const file = makeFixture('skip', [
				JSON.stringify({ timestamp: '2026-01-01T10:00:00.000Z', message: { id: 'm1', model: 'x', usage: { input_tokens: 5, output_tokens: 1 } } }),
				JSON.stringify({ message: { id: 'm2', model: 'y', usage: { input_tokens: 5, output_tokens: 1 } } }), // no timestamp → skipped
				JSON.stringify({ timestamp: '2026-01-01T11:00:00.000Z', message: { model: 'z' } }), // no usage tokens → skipped
			]);
			const conn = await openDb(':memory:');
			await ingestClaudeFile(conn, file, 'p');
			const rows = await runQuery<{ c: number }>(conn, 'SELECT COUNT(*) AS c FROM usage_facts');
			expect(rows[0]?.c).toBe(1);
			conn.closeSync();
		});

		it('re-ingest of changed file replaces rows', async () => {
			const file = makeFixture('reingest', [
				JSON.stringify({ timestamp: '2026-01-01T10:00:00.000Z', message: { id: 'm1', model: 'x', usage: { input_tokens: 10, output_tokens: 5 } } }),
			]);
			const conn = await openDb(':memory:');
			await ingestClaudeFile(conn, file, 'p');
			let rows = await runQuery<{ c: number }>(conn, 'SELECT COUNT(*) AS c FROM usage_facts');
			expect(rows[0]?.c).toBe(1);
			// Re-ingest same file — DELETE then INSERT, no growth.
			await ingestClaudeFile(conn, file, 'p');
			rows = await runQuery<{ c: number }>(conn, 'SELECT COUNT(*) AS c FROM usage_facts');
			expect(rows[0]?.c).toBe(1);
			conn.closeSync();
		});

		it('syncIngest ingests new files then skips unchanged', async () => {
			const root = makeClaudeRoot('sync-new', {
				'proj-a/s1.jsonl': [
					JSON.stringify({ timestamp: '2026-01-01T10:00:00.000Z', message: { id: 'm1', model: 'glm-5.1', usage: { input_tokens: 10, output_tokens: 5 } }, costUSD: 0.01, sessionId: 's1', requestId: 'r1' }),
					JSON.stringify({ timestamp: '2026-01-01T11:00:00.000Z', message: { id: 'm2', model: 'glm-5.1', usage: { input_tokens: 20, output_tokens: 10 } }, costUSD: 0.02, sessionId: 's1' }),
				],
			});
			const conn = await openDb(':memory:');
			const r1 = await syncIngest(conn, { claudePaths: [root] });
			expect(r1.ingestedFiles).toBe(1);
			expect(r1.rowsInserted).toBe(2);
			let rows = await runQuery<{ c: number }>(conn, 'SELECT COUNT(*) AS c FROM usage_facts');
			expect(rows[0]?.c).toBe(2);
			// Second run — unchanged file skipped.
			const r2 = await syncIngest(conn, { claudePaths: [root] });
			expect(r2.ingestedFiles).toBe(0);
			expect(r2.skippedFiles).toBe(1);
			rows = await runQuery<{ c: number }>(conn, 'SELECT COUNT(*) AS c FROM usage_facts');
			expect(rows[0]?.c).toBe(2);
			conn.closeSync();
		});

		it('syncIngest deletes rows for removed files', async () => {
			const root = makeClaudeRoot('sync-del', {
				'proj-a/s1.jsonl': [
					JSON.stringify({ timestamp: '2026-01-01T10:00:00.000Z', message: { id: 'm1', model: 'x', usage: { input_tokens: 5, output_tokens: 1 } }, costUSD: 0.01, sessionId: 's1' }),
				],
			});
			const conn = await openDb(':memory:');
			await syncIngest(conn, { claudePaths: [root] });
			let rows = await runQuery<{ c: number }>(conn, 'SELECT COUNT(*) AS c FROM usage_facts');
			expect(rows[0]?.c).toBe(1);
			// Remove the file on disk.
			rmSync(join(root, 'projects', 'proj-a', 's1.jsonl'), { force: true });
			const r = await syncIngest(conn, { claudePaths: [root] });
			expect(r.deletedFiles).toBe(1);
			rows = await runQuery<{ c: number }>(conn, 'SELECT COUNT(*) AS c FROM usage_facts');
			expect(rows[0]?.c).toBe(0);
			conn.closeSync();
		});

		it('syncIngest re-ingests changed files (mtime/size delta)', async () => {
			const root = makeClaudeRoot('sync-change', {
				'proj-a/s1.jsonl': [
					JSON.stringify({ timestamp: '2026-01-01T10:00:00.000Z', message: { id: 'm1', model: 'x', usage: { input_tokens: 5, output_tokens: 1 } }, costUSD: 0.01, sessionId: 's1' }),
				],
			});
			const conn = await openDb(':memory:');
			await syncIngest(conn, { claudePaths: [root] });
			// Rewrite file with extra entry + bump mtime.
			const file = join(root, 'projects', 'proj-a', 's1.jsonl');
			writeFileSync(file, [
				JSON.stringify({ timestamp: '2026-01-01T10:00:00.000Z', message: { id: 'm1', model: 'x', usage: { input_tokens: 5, output_tokens: 1 } }, costUSD: 0.01, sessionId: 's1' }),
				JSON.stringify({ timestamp: '2026-01-01T12:00:00.000Z', message: { id: 'm2', model: 'x', usage: { input_tokens: 7, output_tokens: 2 } }, costUSD: 0.02, sessionId: 's1' }),
			].join('\n'));
			const future = new Date(Date.now() + 5000);
			utimesSync(file, future, future);
			const r = await syncIngest(conn, { claudePaths: [root] });
			expect(r.ingestedFiles).toBe(1);
			const rows = await runQuery<{ c: number }>(conn, 'SELECT COUNT(*) AS c FROM usage_facts');
			expect(rows[0]?.c).toBe(2);
			conn.closeSync();
		});

		it('syncIngest --rebuild clears and re-ingests', async () => {
			const root = makeClaudeRoot('sync-rebuild', {
				'proj-a/s1.jsonl': [
					JSON.stringify({ timestamp: '2026-01-01T10:00:00.000Z', message: { id: 'm1', model: 'x', usage: { input_tokens: 5, output_tokens: 1 } }, costUSD: 0.01, sessionId: 's1' }),
				],
			});
			const conn = await openDb(':memory:');
			await syncIngest(conn, { claudePaths: [root] });
			const r = await syncIngest(conn, { claudePaths: [root], rebuild: true });
			expect(r.ingestedFiles).toBe(1);
			const rows = await runQuery<{ c: number }>(conn, 'SELECT COUNT(*) AS c FROM usage_facts');
			expect(rows[0]?.c).toBe(1);
			conn.closeSync();
		});

		it('insertUsageEntry dedups droid-style entries by messageId', async () => {
			const conn = await openDb(':memory:');
			const entry = {
				timestamp: '2026-01-01T10:00:00.000Z',
				sessionId: 's1',
				message: { id: 'm1', model: 'glm-5.1', usage: { input_tokens: 10, output_tokens: 5 } },
				costUSD: 0.01,
				version: '1.0.0',
			} as unknown as UsageData;
			await insertUsageEntry(conn, entry, 'droid/unknown', 'droid://s1', 'droid');
			await insertUsageEntry(conn, entry, 'droid/unknown', 'droid://s1', 'droid');
			const rows = await runQuery<{ c: number; src: string }>(
				conn,
				'SELECT COUNT(*) AS c, ANY_VALUE(source) AS src FROM usage_facts WHERE source = \'droid\'',
			);
			expect(rows[0]?.c).toBe(1);
			expect(rows[0]?.src).toBe('droid');
			conn.closeSync();
		});

		it('syncIngest ingests droid sessions end-to-end via processDroidSessions', async () => {
			// Droid fixture: {droidRoot}/{sid}.settings.json + {sid}.jsonl
			// (settings provides tokenUsage + providerLock; jsonl first line is
			// the session-start record — matches droid-adapter schema).
			const droidRoot = join(tmpdir(), `bcu-duckdb-droid-${process.pid}`);
			rmSync(droidRoot, { recursive: true, force: true });
			mkdirSync(droidRoot, { recursive: true });
			const sid = 'droid-session-1';
			writeFileSync(
				join(droidRoot, `${sid}.settings.json`),
				JSON.stringify({
					providerLock: 'anthropic',
					providerLockTimestamp: '2025-01-01T12:00:00.000Z',
					tokenUsage: { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 10, cacheReadTokens: 5, thinkingTokens: 0 },
				}),
			);
			writeFileSync(
				join(droidRoot, `${sid}.jsonl`),
				JSON.stringify({ type: 'session', id: sid, title: 'droid-e2e' }),
			);
			// syncIngest needs a claudePath (else it returns early before droid).
			const claudeRoot = makeClaudeRoot('droid-e2e-claude', {});
			const conn = await openDb(':memory:');
			const r = await syncIngest(conn, { claudePaths: [claudeRoot], droidPath: droidRoot });
			expect(r.droidRows).toBe(1);
			const rows = await runQuery<{ source: string; model: string }>(
				conn,
				'SELECT source, model FROM usage_facts WHERE source = \'droid\'',
			);
			expect(rows.length).toBe(1);
			expect(rows[0]?.source).toBe('droid');
			// mapProviderToModel('anthropic') → sonnet-4-5
			expect(rows[0]?.model).toBe('sonnet-4-5');
			conn.closeSync();
		});
	});

	describe('provider_switch_history', () => {
		it('insertSwitchHistory writes a row', async () => {
			const conn = await openDb(':memory:');
			await insertSwitchHistory(conn, {
				ts: new Date('2026-06-29T18:41:14Z'),
				providerId: 'volcengine-ark-beijing-agent-plan',
				baseUrl: 'https://ark.cn-beijing.volces.com',
				source: 'watcher:claude',
			});
			const rows = await runQuery<{ c: number }>(conn, 'SELECT COUNT(*) AS c FROM provider_switch_history');
			expect(Number(rows[0]?.c)).toBe(1);
		});

		it('dedup skips same provider within 5 seconds', async () => {
			const conn = await openDb(':memory:');
			const ts = new Date('2026-06-29T18:41:14Z');
			const inserted1 = await insertSwitchHistory(conn, { ts, providerId: 'poe', baseUrl: null, source: 'watcher:claude' });
			const inserted2 = await insertSwitchHistory(conn, { ts: new Date(ts.getTime() + 2000), providerId: 'poe', baseUrl: null, source: 'watcher:claude' });
			expect(inserted1).toBe(true);
			expect(inserted2).toBe(false);
			const rows = await runQuery<{ c: number }>(conn, 'SELECT COUNT(*) AS c FROM provider_switch_history');
			expect(Number(rows[0]?.c)).toBe(1);
		});

		it('different provider within 5 seconds is recorded', async () => {
			const conn = await openDb(':memory:');
			const ts = new Date('2026-06-29T18:41:14Z');
			await insertSwitchHistory(conn, { ts, providerId: 'poe', baseUrl: null, source: 'watcher:claude' });
			await insertSwitchHistory(conn, { ts: new Date(ts.getTime() + 2000), providerId: 'ark', baseUrl: null, source: 'watcher:claude' });
			const rows = await runQuery<{ c: number }>(conn, 'SELECT COUNT(*) AS c FROM provider_switch_history');
			expect(Number(rows[0]?.c)).toBe(2);
		});

		it('loadHistory returns entries as ms epoch', async () => {
			const conn = await openDb(':memory:');
			await insertSwitchHistory(conn, {
				ts: new Date('2026-06-29T18:41:14Z'),
				providerId: 'volcengine-ark-beijing-agent-plan',
				baseUrl: null,
				source: 'watcher:claude',
			});
			const history = await loadHistory(conn);
			expect(history).toHaveLength(1);
			expect(history[0]?.providerId).toBe('volcengine-ark-beijing-agent-plan');
			expect(history[0]?.ts).toBe(new Date('2026-06-29T18:41:14Z').getTime());
		});

		it('loadHistory skips NULL provider_id rows', async () => {
			const conn = await openDb(':memory:');
			await insertSwitchHistory(conn, { ts: new Date('2026-06-29T18:41:14Z'), providerId: null, baseUrl: 'https://unknown.com', source: 'watcher:claude' });
			const history = await loadHistory(conn);
			expect(history).toHaveLength(0);
		});
	});
}
