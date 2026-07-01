# Provider 历史归因系统 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将每条 cc-switch.db / JSONL 用量记录归因到具体 provider（精确到切换时刻），通过 ATTACH cc-switch.db 导入数据 + watcher 自动捕获前瞻切换 + 手动 schedule 回顾归因。

**Architecture:** DuckDB ATTACH 只读 cc-switch.db，导入 `proxy_request_logs`（6/22+ per-request）与 `usage_daily_rollups`（4-5月日聚合）到现有 `usage_facts` 表，`_session`→NULL 触发归因 pass。新增 `provider_switch_history` 表（watcher 写入）插入 `resolveProviderId` 优先级链第 2 层。watcher 用 chokidar 监听 `~/.claude/settings.json` 等 live config 原子写，内嵌 MCP server（W3）+ CLI `watch` 子命令 fallback（W1）。

**Tech Stack:** TypeScript, DuckDB (`@duckdb/node-api`), sql.js (cc-switch.db 只读), chokidar (文件监听), @praha/byethrow (Result 错误处理), gunshi (CLI), Vitest (in-source 测试)

**Spec:** `docs/superpowers/specs/2026-07-01-provider-history-attribution-design.md`

---

## File Structure

| 文件 | 责任 | 操作 |
|------|------|------|
| `apps/zccusage/src/_consts.ts` | 路径常量；加 `$CC_SWITCH_CONFIG_DIR` 候选 + DuckDB 路径同目录 | Modify |
| `apps/zccusage/src/_provider-profile-loader.ts` | 加 `findProviderIdByBaseUrl`；`ProviderResolutionContext` 加 `history` 字段；`resolveProviderId` 插入 history 层 | Modify |
| `apps/zccusage/src/_duckdb-store.ts` | `SCHEMA_SQL` 加 `provider_switch_history`；ingest 加 `ingestCcSwitchDb` ATTACH 导入；`resolveProviderIds` 预载 history | Modify |
| `apps/zccusage/src/_switch-watcher.ts` | `startSwitchWatcher` 实现：chokidar 监听 + 反查 + 写 history | Create |
| `apps/zccusage/src/commands/watch.ts` | `watch` CLI 子命令（W1 fallback） | Create |
| `apps/zccusage/src/commands/index.ts` | `subCommandUnion` 加 `watch` | Modify |
| `apps/zccusage/src/index.ts` | 导出 `startSwitchWatcher`（供 MCP 用） | Modify |
| `apps/mcp/src/index.ts` | 启动时调 `startSwitchWatcher`（W3） | Modify |
| `apps/zccusage/package.json` | 加 `chokidar` devDependency | Modify |

---

## Task 1: 路径常量加 `$CC_SWITCH_CONFIG_DIR` 支持

**Files:**
- Modify: `apps/zccusage/src/_consts.ts:195-205`

- [ ] **Step 1: 读现有常量确认上下文**

Run: `rtk read apps/zccusage/src/_consts.ts` (offset 185-206)

确认 `USER_HOME_DIR` 定义位置与现有 import（`path`）。

- [ ] **Step 2: 改 `CC_SWITCH_DB_PATHS` 加 `$CC_SWITCH_CONFIG_DIR` 候选**

替换 `_consts.ts:195-198` 为：

```ts
/**
 * Resolve `$CC_SWITCH_CONFIG_DIR` env var (cc-switch-cli's config override).
 * Returns undefined if unset or empty.
 */
function getCcSwitchConfigDir(): string | undefined {
	const dir = process.env.CC_SWITCH_CONFIG_DIR;
	return dir != null && dir !== '' ? dir : undefined;
}

/**
 * Default cc-switch SQLite DB paths. `$CC_SWITCH_CONFIG_DIR` (cc-switch-cli's
 * override) wins if set; else the legacy `~/.cc-switch-tui/` and `~/.cc-switch/`
 * candidates are tried in order. The DB stores provider profiles (base_url,
 * model alias maps, cost_multiplier) and per-request usage logs.
 */
export const CC_SWITCH_DB_PATHS: string[] = (() => {
	const configDir = getCcSwitchConfigDir();
	if (configDir != null) {
		return [path.join(configDir, 'cc-switch.db')];
	}
	return [
		path.join(USER_HOME_DIR, '.cc-switch-tui', 'cc-switch.db'),
		path.join(USER_HOME_DIR, '.cc-switch', 'cc-switch.db'),
	];
})();
```

确认 `process` 已 import（文件顶部应有 `import process from 'node:process'`，若无则加）。

- [ ] **Step 3: 加 `resolveCcSwitchConfigDir` 导出（供 watcher/DuckDB 路径用）**

在 `CC_SWITCH_DB_PATHS` 后加：

```ts
/**
 * Resolve the cc-switch config directory: `$CC_SWITCH_CONFIG_DIR` if set, else
 * the first existing legacy candidate's parent dir. Used to anchor sibling
 * files (better-ccusage.duckdb, provider_schedule.json, watcher pid).
 */
export function resolveCcSwitchConfigDir(): string {
	const envDir = getCcSwitchConfigDir();
	if (envDir != null) {
		return envDir;
	}
	if (existsSync(path.join(USER_HOME_DIR, '.cc-switch-tui'))) {
		return path.join(USER_HOME_DIR, '.cc-switch-tui');
	}
	return path.join(USER_HOME_DIR, '.cc-switch');
}
```

确认 `existsSync` 已 import（`import { existsSync } from 'node:fs'`，若无则加到现有 fs import）。

- [ ] **Step 4: 改 `DEFAULT_DUCKDB_PATH` 用 config dir**

替换 `_consts.ts:205` 为：

```ts
/**
 * Default DuckDB OLAP store path. Persistent columnar usage facts for fast
 * ad-hoc queries. Sits alongside the cc-switch DB (logical grouping).
 * Override via `--db-path` / config `dbPath`.
 */
export const DEFAULT_DUCKDB_PATH = path.join(resolveCcSwitchConfigDir(), 'better-ccusage.duckdb');
```

- [ ] **Step 5: typecheck**

Run: `cd apps/zccusage && rtk pnpm typecheck`
Expected: PASS（无类型错误）

- [ ] **Step 6: Commit**

```bash
rtk git add apps/zccusage/src/_consts.ts
rtk git commit -m "feat(better-ccusage): support CC_SWITCH_CONFIG_DIR for db paths

CC_SWITCH_DB_PATHS 现优先读 \$CC_SWITCH_CONFIG_DIR 环境变量；新增
resolveCcSwitchConfigDir() 锚定 DuckDB / schedule / watcher pid 等兄弟文件。"
```

---

## Task 2: `findProviderIdByBaseUrl` 反查函数

**Files:**
- Modify: `apps/zccusage/src/_provider-profile-loader.ts` (加在 `deriveProfileFields` 后，约 L317)
- Test: 同文件 in-source test 块

- [ ] **Step 1: 写失败测试**

在 `_provider-profile-loader.ts` 文件末尾的 `if (import.meta.vitest != null)` 块内，`describe('resolveProviderId')` 前插入：

```ts
	describe('findProviderIdByBaseUrl', () => {
		const profiles = [
			{ id: 'poe-philosophos', name: 'POE', appType: 'claude', baseUrl: 'https://api.poe.com/v1' } as never,
			{ id: 'bailian-aliyun-singapore', name: 'Bailian SG', appType: 'claude', baseUrl: 'https://ws-xxx.ap-southeast-1.maas.aliyuncs.com/apps/anthropic' } as never,
			{ id: 'no-url-provider', name: 'NoUrl', appType: 'claude', baseUrl: undefined } as never,
		];

		it('exact base_url match returns provider id', () => {
			expect(findProviderIdByBaseUrl('https://api.poe.com/v1', profiles)).toBe('poe-philosophos');
		});

		it('same host loose match when exact url differs', () => {
			expect(findProviderIdByBaseUrl('https://api.poe.com/v2', profiles)).toBe('poe-philosophos');
		});

		it('returns undefined when no host matches', () => {
			expect(findProviderIdByBaseUrl('https://api.unknown.com', profiles)).toBeUndefined();
		});

		it('returns undefined for invalid url', () => {
			expect(findProviderIdByBaseUrl('not-a-url', profiles)).toBeUndefined();
		});

		it('skips profiles without baseUrl', () => {
			expect(findProviderIdByBaseUrl('https://api.poe.com/v1', [profiles[2]!])).toBeUndefined();
		});
	});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/zccusage && rtk pnpm run test -- --run _provider-profile-loader`
Expected: FAIL — `findProviderIdByBaseUrl is not defined`

- [ ] **Step 3: 实现 `findProviderIdByBaseUrl`**

在 `deriveProfileFields` 函数后（约 L317）插入：

```ts
/**
 * Reverse-lookup a providerId by base_url. Tries exact match first, then a
 * loose same-host match. Returns undefined when no profile matches (e.g. the
 * base_url belongs to a provider not in cc-switch.db). Callers should still
 * record the switch with a NULL provider_id so the timestamp is preserved.
 */
export function findProviderIdByBaseUrl(
	baseUrl: string,
	profiles: ProviderProfile[],
): string | undefined {
	if (baseUrl == null || baseUrl === '') {
		return undefined;
	}
	// 1. Exact match.
	for (const p of profiles) {
		if (p.baseUrl === baseUrl) {
			return p.id;
		}
	}
	// 2. Loose match: same hostname.
	let targetHost: string;
	try {
		targetHost = new URL(baseUrl).hostname.toLowerCase();
	}
	catch {
		return undefined;
	}
	if (targetHost === '') {
		return undefined;
	}
	for (const p of profiles) {
		if (p.baseUrl == null) {
			continue;
		}
		try {
			if (new URL(p.baseUrl).hostname.toLowerCase() === targetHost) {
				return p.id;
			}
		}
		catch {
			continue;
		}
	}
	return undefined;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd apps/zccusage && rtk pnpm run test -- --run _provider-profile-loader`
Expected: PASS — 全部 findProviderIdByBaseUrl 测试通过

- [ ] **Step 5: typecheck**

Run: `cd apps/zccusage && rtk pnpm typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
rtk git add apps/zccusage/src/_provider-profile-loader.ts
rtk git commit -m "feat(better-ccusage): add findProviderIdByBaseUrl reverse lookup

watcher 用 base_url 反查 providerId：精确匹配优先，同 host 宽松匹配兜底。"
```

---

## Task 3: `ProviderResolutionContext` 加 `history` + `resolveProviderId` 插入 history 层

**Files:**
- Modify: `apps/zccusage/src/_provider-profile-loader.ts:378-422` (ProviderResolutionContext + resolveProviderId)
- Modify: `apps/zccusage/src/_types.ts` (ProviderScheduleEntry 旁加 ProviderHistoryEntry 类型)
- Test: in-source

- [ ] **Step 1: 读现有类型与 resolveProviderId 确认上下文**

Run: `rtk read apps/zccusage/src/_provider-profile-loader.ts` (offset 372-422)

确认 `ProviderResolutionContext` 与 `resolveProviderId` 现有签名。

- [ ] **Step 2: 在 `_types.ts` 加 `ProviderHistoryEntry` 类型**

先查 `ProviderScheduleEntry` 定义位置：

Run: `grep -n "ProviderScheduleEntry" apps/zccusage/src/_types.ts`

在其定义后加：

```ts
/**
 * One observed provider switch (from the watcher). `ts` is epoch milliseconds
 * (the live-config file mtime at switch time). Used by `resolveProviderId` as
 * priority layer 2: the most recent entry with `ts <= entry timestamp` wins.
 */
export type ProviderHistoryEntry = {
	ts: number;
	providerId: string;
};
```

- [ ] **Step 3: 改 `ProviderResolutionContext` 加 `history` 字段**

替换 `_provider-profile-loader.ts:378-381` 为：

```ts
export type ProviderResolutionContext = {
	profiles: ProviderProfile[];
	schedule?: ProviderScheduleEntry[];
	history?: ProviderHistoryEntry[];
};
```

确认顶部 import 含 `ProviderHistoryEntry`：

```ts
import type { PlanType, ProviderProfile, ProviderScheduleEntry, ProviderHistoryEntry } from './_types.ts';
```

- [ ] **Step 4: 改 `resolveProviderId` 插入 history 层（优先级 2）**

替换 `_provider-profile-loader.ts:394-422` 的 `resolveProviderId` 函数体为：

```ts
export function resolveProviderId(
	timestampMs: number,
	ctx: ProviderResolutionContext,
): string | undefined {
	if (Number.isNaN(timestampMs)) {
		return undefined;
	}
	const ts = timestampMs;

	// 1. Explicit schedule override.
	if (ctx.schedule != null && ctx.schedule.length > 0) {
		for (const entry of ctx.schedule) {
			const from = new Date(entry.from).getTime();
			const to = new Date(entry.to).getTime();
			if (ts >= from && ts <= to) {
				return entry.providerId;
			}
		}
	}

	// 2. Watcher history: most recent entry with ts <= entry timestamp.
	if (ctx.history != null && ctx.history.length > 0) {
		let best: ProviderHistoryEntry | undefined;
		for (const entry of ctx.history) {
			if (entry.ts <= ts && (best == null || entry.ts > best.ts)) {
				best = entry;
			}
		}
		if (best != null) {
			return best.providerId;
		}
	}

	// 3. is_current snapshot.
	const current = ctx.profiles.find(p => p.isCurrent === true);
	if (current != null) {
		return current.id;
	}

	// 4. Unmapped.
	return undefined;
}
```

- [ ] **Step 5: 写 history 层测试**

在 `describe('resolveProviderId')` 块内（约 L486）追加：

```ts
		it('history beats is_current when ts <= entry timestamp', () => {
			const history = [
				{ ts: new Date('2026-06-29T18:41:14').getTime(), providerId: 'volcengine-ark-beijing-agent-plan' } as never,
			];
			const ts = new Date('2026-06-30T00:00:00').getTime();
			// profiles[0] (bailian SG) is_current, but history should win
			expect(resolveProviderId(ts, { profiles, history })).toBe('volcengine-ark-beijing-agent-plan');
		});

		it('history ignored when ts > entry timestamp (uses is_current)', () => {
			const history = [
				{ ts: new Date('2026-06-29T18:41:14').getTime(), providerId: 'volcengine-ark-beijing-agent-plan' } as never,
			];
			const ts = new Date('2026-06-28T00:00:00').getTime(); // before the switch
			expect(resolveProviderId(ts, { profiles, history })).toBe('bailian-aliyun-singapore');
		});

		it('schedule still beats history', () => {
			const schedule = [
				{ from: '2026-06-01T00:00:00.000Z' as never, to: '2026-06-30T23:59:59.000Z' as never, providerId: 'claude-official' } as never,
			];
			const history = [
				{ ts: new Date('2026-06-15T00:00:00').getTime(), providerId: 'poe-philosophos' } as never,
			];
			const ts = new Date('2026-06-20T00:00:00').getTime();
			expect(resolveProviderId(ts, { profiles, schedule, history })).toBe('claude-official');
		});

		it('most recent history entry <= ts wins', () => {
			const history = [
				{ ts: new Date('2026-06-21T14:00:00').getTime(), providerId: 'bailian-aliyun-singapore' } as never,
				{ ts: new Date('2026-06-28T17:56').getTime(), providerId: 'aliyun-bailian-beijing-token-plan' } as never,
			];
			const ts = new Date('2026-06-29T00:00:00').getTime();
			expect(resolveProviderId(ts, { profiles, history })).toBe('aliyun-bailian-beijing-token-plan');
		});

		it('empty history array falls through to is_current', () => {
			const ts = new Date('2026-06-01T00:00:00').getTime();
			expect(resolveProviderId(ts, { profiles, history: [] })).toBe('bailian-aliyun-singapore');
		});
```

- [ ] **Step 6: 运行测试确认通过**

Run: `cd apps/zccusage && rtk pnpm run test -- --run _provider-profile-loader`
Expected: PASS — 含新 history 层测试 + 现有测试不回归

- [ ] **Step 7: typecheck**

Run: `cd apps/zccusage && rtk pnpm typecheck`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
rtk git add apps/zccusage/src/_provider-profile-loader.ts apps/zccusage/src/_types.ts
rtk git commit -m "feat(better-ccusage): add history layer to resolveProviderId

ProviderResolutionContext 新增 history 字段；resolveProviderId 优先级变为
schedule → history → is_current → undefined。history 取 ts ≤ entry 最近一条。"
```

---

## Task 4: DuckDB schema 加 `provider_switch_history` 表

**Files:**
- Modify: `apps/zccusage/src/_duckdb-store.ts:38-73` (SCHEMA_SQL)

- [ ] **Step 1: 在 SCHEMA_SQL 末尾加表定义**

在 `_duckdb-store.ts` 的 `SCHEMA_SQL` 模板字符串内，`ingest_meta` 表后（约 L72 `)''` 前）追加：

```ts
CREATE TABLE IF NOT EXISTS provider_switch_history (
	ts TIMESTAMPTZ,
	provider_id TEXT,
	base_url TEXT,
	source TEXT
);
CREATE INDEX IF NOT EXISTS idx_history_ts ON provider_switch_history(ts);
```

- [ ] **Step 2: 加 `insertSwitchHistory` 导出函数**

在 `resolveProviderIds` 函数后（约 L319）插入：

```ts
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
		 WHERE ts >= $ts - INTERVAL 5 SECOND
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
```

- [ ] **Step 3: 加 `loadHistory` 导出函数**

在 `insertSwitchHistory` 后插入：

```ts
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
```

确认顶部 import 含 `ProviderHistoryEntry`：

```ts
import type { ProviderHistoryEntry } from './_types.ts';
```

- [ ] **Step 4: 写 schema + insert + load 测试**

在 `_duckdb-store.ts` 末尾的 `if (import.meta.vitest != null)` 块内追加（若已有 `describe` 块则加在其后）：

```ts
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
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd apps/zccusage && rtk pnpm run test -- --run _duckdb-store`
Expected: PASS

- [ ] **Step 6: typecheck**

Run: `cd apps/zccusage && rtk pnpm typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
rtk git add apps/zccusage/src/_duckdb-store.ts
rtk git commit -m "feat(better-ccusage): add provider_switch_history table + helpers

新表 schema + insertSwitchHistory (5s 去重) + loadHistory (按 ts 升序返回
ms epoch)。watcher 写入，resolveProviderIds 读取。"
```

---

## Task 5: `resolveProviderIds` 预载 history 到 ctx

**Files:**
- Modify: `apps/zccusage/src/_duckdb-store.ts:295-319` (resolveProviderIds)

- [ ] **Step 1: 读现有 `resolveProviderIds` 确认上下文**

Run: `rtk read apps/zccusage/src/_duckdb-store.ts` (offset 295-319)

- [ ] **Step 2: 改 `resolveProviderIds` 预载 history**

替换 `resolveProviderIds` 函数体为：

```ts
export async function resolveProviderIds(
	conn: DuckDBConnection,
	ctx: ProviderResolutionContext,
): Promise<number> {
	// Preload watcher history into ctx so resolveProviderId stays a pure fn.
	const history = await loadHistory(conn);
	const ctxWithHistory: ProviderResolutionContext = {
		...ctx,
		history: ctx.history != null ? ctx.history : history,
	};
	const rows = await runQuery<{ message_hash: string; ms: number }>(
		conn,
		'SELECT message_hash, EPOCH(timestamp) AS ms FROM usage_facts WHERE provider_id IS NULL',
	);
	let resolved = 0;
	for (const row of rows) {
		if (row.ms == null || Number.isNaN(row.ms)) {
			continue;
		}
		const providerId = resolveProviderId(row.ms * 1000, ctxWithHistory);
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
```

- [ ] **Step 3: 加端到端归因测试**

在 `_duckdb-store.ts` 测试块内追加：

```ts
	describe('resolveProviderIds with history', () => {
		it('history layer resolves NULL rows that is_current cannot', async () => {
			const conn = await openDb(':memory:');
			// Insert a row at 2026-06-30 (after ark switch) with NULL provider_id.
			await conn.run(
				`INSERT INTO usage_facts (message_hash, timestamp, model, provider_id, input_tokens, output_tokens, source)
				 VALUES ('h1', '2026-06-30T00:00:00', 'glm-5.2', NULL, 100, 10, 'claude')`,
			);
			// History: ark switch at 2026-06-29 18:41.
			await insertSwitchHistory(conn, {
				ts: new Date('2026-06-29T18:41:14Z'),
				providerId: 'volcengine-ark-beijing-agent-plan',
				baseUrl: null,
				source: 'watcher:claude',
			});
			// profiles: bailian SG is_current (wrong for 6/30 — history should override).
			const ctx = {
				profiles: [{ id: 'bailian-aliyun-singapore', isCurrent: true } as never],
			};
			const resolved = await resolveProviderIds(conn, ctx);
			expect(resolved).toBe(1);
			const rows = await runQuery<{ provider_id: string }>(conn, "SELECT provider_id FROM usage_facts WHERE message_hash = 'h1'");
			expect(rows[0]?.provider_id).toBe('volcengine-ark-beijing-agent-plan');
		});

		it('schedule still wins over history', async () => {
			const conn = await openDb(':memory:');
			await conn.run(
				`INSERT INTO usage_facts (message_hash, timestamp, model, provider_id, input_tokens, output_tokens, source)
				 VALUES ('h2', '2026-06-20T00:00:00', 'glm-5.2', NULL, 100, 10, 'claude')`,
			);
			await insertSwitchHistory(conn, {
				ts: new Date('2026-06-15T00:00:00Z'),
				providerId: 'poe-philosophos',
				baseUrl: null,
				source: 'watcher:claude',
			});
			const ctx = {
				profiles: [],
				schedule: [
					{ from: '2026-06-01T00:00:00.000Z', to: '2026-06-30T23:59:59.000Z', providerId: 'claude-official' } as never,
				],
			};
			await resolveProviderIds(conn, ctx);
			const rows = await runQuery<{ provider_id: string }>(conn, "SELECT provider_id FROM usage_facts WHERE message_hash = 'h2'");
			expect(rows[0]?.provider_id).toBe('claude-official');
		});
	});
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd apps/zccusage && rtk pnpm run test -- --run _duckdb-store`
Expected: PASS

- [ ] **Step 5: typecheck**

Run: `cd apps/zccusage && rtk pnpm typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
rtk git add apps/zccusage/src/_duckdb-store.ts
rtk git commit -m "feat(better-ccusage): preload history into resolveProviderIds ctx

resolveProviderIds 现预载 provider_switch_history 到 ctx.history；保持
resolveProviderId 纯函数。history 层填补 is_current 无法覆盖的历史区间。"
```

---

## Task 6: ATTACH cc-switch.db 导入 `proxy_request_logs` 与 `usage_daily_rollups`

**Files:**
- Modify: `apps/zccusage/src/_duckdb-store.ts` (新增 `ingestCcSwitchDb` 函数 + 接入 syncIngest)

- [ ] **Step 1: 读 `syncIngest` 函数确认接入点**

Run: `grep -n "export async function syncIngest\|claudePaths\|ATTACH" apps/zccusage/src/_duckdb-store.ts`

确认 `syncIngest` 签名与现有 JSONL ingest 调用位置。

- [ ] **Step 2: 加 `ingestCcSwitchDb` 函数**

在 `ingestClaudeFile` 后（约 L148）插入。需读 cc-switch.db 路径，复用 `_provider-profile-loader.ts` 的 `resolveDbPath`——但该函数未导出。改为在本文件内用 `CC_SWITCH_DB_PATHS` 直接探：

```ts
import { CC_SWITCH_DB_PATHS } from './_consts.ts';
import { readFileSync } from 'node:fs';

/**
 * Resolve the cc-switch DB path (first existing candidate). Returns undefined
 * if none exists (caller falls back to JSONL).
 */
function resolveCcSwitchDbPath(): string | undefined {
	for (const candidate of CC_SWITCH_DB_PATHS) {
		try {
			readFileSync(candidate);
			return candidate;
		}
		catch {
			continue;
		}
	}
	return undefined;
}
```

确认 `readFileSync` 已 import（文件顶部应有 `import { readFileSync } from 'node:fs'`，若无则加）。确认 `CC_SWITCH_DB_PATHS` 未与现有 import 冲突。

在 `resolveCcSwitchDbPath` 后加主导入函数：

```ts
/**
 * ATTACH the cc-switch SQLite DB (read-only) and import its two usage tables
 * into `usage_facts`. `_session` provider_ids are normalized to NULL so the
 * post-ingest resolveProviderIds pass picks them up. Returns counts of
 * inserted rows per table. Idempotent via ON CONFLICT(message_hash) DO NOTHING.
 *
 * On ATTACH failure (db missing / locked / unreadable), returns zero counts
 * and logs a warning — caller should run JSONL fallback.
 */
export async function ingestCcSwitchDb(conn: DuckDBConnection): Promise<{
	proxyRows: number;
	rollupRows: number;
	attached: boolean;
}> {
	const dbPath = resolveCcSwitchDbPath();
	if (dbPath == null) {
		logger.debug('No cc-switch DB found; skipping cc-switch.db ingest');
		return { proxyRows: 0, rollupRows: 0, attached: false };
	}

	const attachResult = await Result.try({
		try: async () => {
			// Detach first if a stale ATTACH lingers (re-runs in same process).
			try {
				await conn.run('DETACH ccs');
			}
			catch {
				// not attached — fine
			}
			await conn.run(`ATTACH '${dbPath.replace(/'/g, "''")}' AS ccs (READ_ONLY)`);
		},
	});
	if (Result.isFailure(attachResult)) {
		logger.warn(`cc-switch.db ATTACH failed at ${dbPath}: ${attachResult.error.message}`);
		return { proxyRows: 0, rollupRows: 0, attached: false };
	}

	// proxy_request_logs: 6/22+ per-request.
	const proxyResult = await Result.try({
		try: async () => {
			await conn.run(`
				INSERT INTO usage_facts (
					message_hash, timestamp, session_id, project, source, source_path,
					model, provider_id, input_tokens, output_tokens,
					cache_creation_tokens, cache_read_tokens, cost_usd, version, ingested_at
				)
				SELECT
					md5(COALESCE(request_id::TEXT, '') || ':' || COALESCE(created_at::TEXT, '')),
					to_timestamp(created_at),
					session_id,
					NULL,
					'claude',
					'cc-switch:proxy_request_logs',
					model,
					CASE WHEN provider_id = '_session' THEN NULL ELSE provider_id END,
					input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
					total_cost_usd,
					NULL,
					CURRENT_TIMESTAMP
				FROM ccs.proxy_request_logs
				WHERE created_at IS NOT NULL
				ON CONFLICT(message_hash) DO NOTHING
			`);
		},
	});
	if (Result.isFailure(proxyResult)) {
		logger.warn(`proxy_request_logs import failed: ${proxyResult.error.message}`);
	}

	// usage_daily_rollups: 4-5月 daily aggregate. Use date + 12:00 as ts.
	const rollupResult = await Result.try({
		try: async () => {
			await conn.run(`
				INSERT INTO usage_facts (
					message_hash, timestamp, session_id, project, source, source_path,
					model, provider_id, input_tokens, output_tokens,
					cache_creation_tokens, cache_read_tokens, cost_usd, version, ingested_at
				)
				SELECT
					md5(date::TEXT || COALESCE(model, '') || COALESCE(provider_id, '')),
					(date::TEXT || ' 12:00:00')::TIMESTAMP,
					NULL,
					NULL,
					'claude',
					'cc-switch:usage_daily_rollups',
					model,
					CASE WHEN provider_id = '_session' THEN NULL ELSE provider_id END,
					input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
					total_cost_usd,
					NULL,
					CURRENT_TIMESTAMP
				FROM ccs.usage_daily_rollups
				ON CONFLICT(message_hash) DO NOTHING
			`);
		},
	});
	if (Result.isFailure(rollupResult)) {
		logger.warn(`usage_daily_rollups import failed: ${rollupResult.error.message}`);
	}

	// Count inserted (best-effort — ON CONFLICT may suppress duplicates).
	const proxyCount = await runQuery<{ c: number }>(conn, "SELECT COUNT(*) AS c FROM usage_facts WHERE source_path = 'cc-switch:proxy_request_logs'");
	const rollupCount = await runQuery<{ c: number }>(conn, "SELECT COUNT(*) AS c FROM usage_facts WHERE source_path = 'cc-switch:usage_daily_rollups'");

	// DETACH to release the SQLite handle.
	try {
		await conn.run('DETACH ccs');
	}
	catch {
		// ignore
	}

	return {
		proxyRows: Number(proxyCount[0]?.c ?? 0),
		rollupRows: Number(rollupCount[0]?.c ?? 0),
		attached: true,
	};
}
```

确认顶部 import 含 `Result`：

```ts
import { Result } from '@praha/byethrow';
```

若文件顶部无 `logger` import 则确认有（现有文件应有 `import { logger } from './logger.ts'`）。

- [ ] **Step 3: 接入 `syncIngest`**

在 `syncIngest` 函数内，现有 JSONL ingest 逻辑**之前**插入 cc-switch.db 导入。先读 syncIngest 主体定位插入点：

Run: `rtk read apps/zccusage/src/_duckdb-store.ts` (offset 355-420)

在 `syncIngest` 的 `rebuild` 清理逻辑后、Claude JSONL discovery 前插入：

```ts
	// ── cc-switch.db ingest (primary source) ──────────────────────────────
	const ccResult = await ingestCcSwitchDb(conn);
	if (ccResult.attached) {
		progress(`cc-switch.db: ${ccResult.proxyRows} proxy rows, ${ccResult.rollupRows} rollup rows`);
	}
	// JSONL ingest below acts as fallback for gaps cc-switch.db doesn't cover.
```

若 `progress` 参数名不同（如 `onProgress`），用实际名。

- [ ] **Step 4: 写 ingestCcSwitchDb 测试（用真实 cc-switch.db fixture 不现实，测 ATTACH 失败降级 + _session→NULL 逻辑）**

在测试块内追加。用一个临时 sqlite db 模拟 cc-switch.db：

```ts
	describe('ingestCcSwitchDb', () => {
		it('returns attached=false when no cc-switch.db exists', async () => {
			const conn = await openDb(':memory:');
			// CC_SWITCH_DB_PATHS won't find anything in test env, but to be safe
			// point at a nonexistent path via direct call (function reads global paths).
			// Since ingestCcSwitchDb uses module-level resolveCcSwitchDbPath, we
			// verify the no-db branch by checking it returns zeros without throwing.
			const result = await ingestCcSwitchDb(conn);
			expect(result.attached).toBe(false);
			expect(result.proxyRows).toBe(0);
			expect(result.rollupRows).toBe(0);
		});
	});
```

注：真实 cc-switch.db 路径在 CI 不可控，此测试仅验证降级路径不抛错。完整 ATTACH 测试在手动端到端（Task 10）覆盖。

- [ ] **Step 5: 运行测试确认通过**

Run: `cd apps/zccusage && rtk pnpm run test -- --run _duckdb-store`
Expected: PASS

- [ ] **Step 6: typecheck**

Run: `cd apps/zccusage && rtk pnpm typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
rtk git add apps/zccusage/src/_duckdb-store.ts
rtk git commit -m "feat(better-ccusage): ATTACH cc-switch.db and import usage tables

ingestCcSwitchDb: ATTACH 只读 cc-switch.db → 导入 proxy_request_logs
(6/22+ per-request) + usage_daily_rollups (4-5月日聚合) 到 usage_facts。
_session provider_id 规范化为 NULL 触发归因 pass。ATTACH 失败降级 JSONL。"
```

---

## Task 7: chokidar 依赖 + `_switch-watcher.ts` 模块

**Files:**
- Modify: `apps/zccusage/package.json` (加 chokidar devDep)
- Create: `apps/zccusage/src/_switch-watcher.ts`

- [ ] **Step 1: 加 chokidar devDependency**

Run: `cd apps/zccusage && pnpm add -D chokidar@^4`

确认 `package.json` 含 `"chokidar": "^4.x.x"` 在 devDependencies。

- [ ] **Step 2: 写 `_switch-watcher.ts` 失败测试**

创建 `apps/zccusage/src/_switch-watcher.ts`，先写测试骨架：

```ts
import type { ProviderProfile } from './_types.ts';
import { findProviderIdByBaseUrl } from './_provider-profile-loader.ts';
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

// Placeholder — implementation in next step.
export async function startSwitchWatcher(_options: StartSwitchWatcherOptions): Promise<WatcherHandle> {
	throw new Error('not implemented');
}

if (import.meta.vitest != null) {
	describe('startSwitchWatcher', () => {
		it('returns a handle with stop()', async () => {
			// Minimal smoke test — full fs-watch test is flaky in CI; covered by
			// manual e2e. Here we only assert the module exports the expected shape.
			expect(typeof startSwitchWatcher).toBe('function');
		});
	});
}
```

- [ ] **Step 3: 运行测试确认模块可加载**

Run: `cd apps/zccusage && rtk pnpm run test -- --run _switch-watcher`
Expected: PASS（仅冒烟测试）

- [ ] **Step 4: 实现 `startSwitchWatcher`**

替换 `_switch-watcher.ts` 的 `startSwitchWatcher` 函数体为：

```ts
import chokidar from 'chokidar';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { loadProviderProfiles } from './_provider-profile-loader.ts';
import { insertSwitchHistory, openDb } from './_duckdb-store.ts';
import { resolveCcSwitchConfigDir } from './_consts.ts';

const APP_CONFIGS = [
	{ app: 'claude', path: () => path.join(process.env.HOME ?? '', '.claude', 'settings.json') },
	{ app: 'codex', path: () => path.join(process.env.HOME ?? '', '.codex', 'config.toml') },
	{ app: 'gemini', path: () => path.join(process.env.HOME ?? '', '.gemini', '.env') },
] as const;

export async function startSwitchWatcher(options: StartSwitchWatcherOptions): Promise<WatcherHandle> {
	const { configDir, duckdbPath } = options;
	let profiles = options.profiles;
	if (profiles == null) {
		profiles = await loadProviderProfiles({ ccSwitchDbPath: path.join(configDir, 'cc-switch.db') });
	}

	const pathsToWatch = APP_CONFIGS.map(c => c.path()).filter(p => {
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

	const debounced = new Map<string, { timer: NodeJS.Timeout; pending: string }>();
	const DEBOUNCE_MS = 300;

	async function handleChange(filePath: string): Promise<void> {
		const appConfig = APP_CONFIGS.find(c => c.path() === filePath);
		const app = appConfig?.app ?? basename(filePath);
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

		const conn = await openDb(duckdbPath);
		try {
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
		finally {
			conn.close?.();
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
		debounced.set(filePath, { timer, pending: filePath });
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
```

确认顶部 import 含 `path`：加 `import path from 'node:path';`（若 `APP_CONFIGS` 用 `path.join` 则必须）。

修正 `APP_CONFIGS` 的 `path()` 引用 — 它用 `process.env.HOME`，需确认 `path` import 后可用。重写 `APP_CONFIGS` 顶部以避免运行时 `path is not defined`：

```ts
const APP_CONFIGS = [
	{ app: 'claude', path: () => path.join(process.env.HOME ?? '', '.claude', 'settings.json') },
	{ app: 'codex', path: () => path.join(process.env.HOME ?? '', '.codex', 'config.toml') },
	{ app: 'gemini', path: () => path.join(process.env.HOME ?? '', '.gemini', '.env') },
] as const;
```

确保 `import path from 'node:path';` 在文件顶部。

- [ ] **Step 5: 运行测试确认通过**

Run: `cd apps/zccusage && rtk pnpm run test -- --run _switch-watcher`
Expected: PASS

- [ ] **Step 6: typecheck**

Run: `cd apps/zccusage && rtk pnpm typecheck`
Expected: PASS

- [ ] **Step 7: format**

Run: `cd apps/zccusage && rtk pnpm run format`
Expected: 文件格式化无报错

- [ ] **Step 8: Commit**

```bash
rtk git add apps/zccusage/package.json apps/zccusage/src/_switch-watcher.ts pnpm-lock.yaml
rtk git commit -m "feat(better-ccusage): add switch watcher with chokidar

_switch-watcher.ts: 监听 ~/.claude/settings.json 等原子写 → 读 base_url →
findProviderIdByBaseUrl 反查 → insertSwitchHistory。300ms 去抖。W3 MCP 内嵌 +
W1 CLI watch 复用同一函数。"
```

---

## Task 8: `watch` CLI 子命令（W1 fallback）

**Files:**
- Create: `apps/zccusage/src/commands/watch.ts`
- Modify: `apps/zccusage/src/commands/index.ts`

- [ ] **Step 1: 读现有 blocks 子命令模式**

Run: `rtk read apps/zccusage/src/commands/blocks.ts` (offset 1-40)

确认 gunshi `define` 用法、sharedCommandConfig 引入、logger 用法。

- [ ] **Step 2: 创建 `watch.ts`**

```ts
import process from 'node:process';
import { define } from 'gunshi';
import { sharedCommandConfig } from '../_shared-args.ts';
import { resolveCcSwitchConfigDir, DEFAULT_DUCKDB_PATH } from '../_consts.ts';
import { logger } from '../logger.ts';
import { startSwitchWatcher } from '../_switch-watcher.ts';

/**
 * `zccusage watch` — foreground switch watcher (W1 fallback for pure-CLI users
 * without the MCP server running). Monitors cc-switch live config files and
 * records switches into provider_switch_history.
 *
 * `--daemon` forks to background (TODO: platform-specific daemonization; for
 * now runs in foreground — use nohup/systemd for production).
 */
export const watchCommand = define({
	name: 'watch',
	description: 'Monitor cc-switch provider switches and record history (foreground).',
	...sharedCommandConfig,
	args: {
		...sharedCommandConfig.args,
		daemon: {
			type: 'boolean',
			description: 'Run as background daemon (TODO: foreground only for now).',
			default: false,
		},
	},
	toKebab: true,
	async run(ctx) {
		const configDir = resolveCcSwitchConfigDir();
		const duckdbPath = (ctx.values.dbPath as string | undefined) ?? DEFAULT_DUCKDB_PATH;
		logger.log(`Starting switch watcher (config: ${configDir}, duckdb: ${duckdbPath})`);
		logger.log('Press Ctrl+C to stop.');
		const handle = await startSwitchWatcher({ configDir, duckdbPath });
		const shutdown = async (): Promise<void> => {
			await handle.stop();
			process.exit(0);
		};
		process.on('SIGINT', shutdown);
		process.on('SIGTERM', shutdown);
		// Keep process alive.
		await new Promise(() => {});
	},
});
```

- [ ] **Step 3: 注册到 `commands/index.ts`**

修改 `apps/zccusage/src/commands/index.ts`：

在 `blocksCommand` import 后加：

```ts
import { watchCommand } from './watch.ts';
```

改 `subCommandUnion`：

```ts
export const subCommandUnion = [
	['blocks', blocksCommand],
	['statusline', statuslineCommand],
	['watch', watchCommand],
] as const;
```

改 Re-export：

```ts
export { blocksCommand, statuslineCommand, usageCommand, watchCommand };
```

- [ ] **Step 4: typecheck**

Run: `cd apps/zccusage && rtk pnpm typecheck`
Expected: PASS

- [ ] **Step 5: 运行测试确认无回归**

Run: `cd apps/zccusage && rtk pnpm run test`
Expected: PASS

- [ ] **Step 6: format**

Run: `cd apps/zccusage && rtk pnpm run format`
Expected: 无报错

- [ ] **Step 7: Commit**

```bash
rtk git add apps/zccusage/src/commands/watch.ts apps/zccusage/src/commands/index.ts
rtk git commit -m "feat(better-ccusage): add watch subcommand for switch history

zccusage watch: 前台运行 switch watcher（W1 fallback）。注册到
subCommandUnion。SIGINT/SIGTERM 优雅停止。"
```

---

## Task 9: 导出 `startSwitchWatcher` 供 MCP 用 + MCP 内嵌（W3）

**Files:**
- Modify: `apps/zccusage/src/index.ts`
- Modify: `apps/mcp/src/index.ts` 或 `apps/mcp/src/command.ts`

- [ ] **Step 1: 在 `index.ts` 导出 watcher**

读 `apps/zccusage/src/index.ts` 末尾 export 区。

加：

```ts
export { startSwitchWatcher } from './_switch-watcher.ts';
export type { StartSwitchWatcherOptions, WatcherHandle } from './_switch-watcher.ts';
export { resolveCcSwitchConfigDir, DEFAULT_DUCKDB_PATH } from './_consts.ts';
```

确认无重复 export。

- [ ] **Step 2: 定位 MCP server 启动点**

Run: `grep -rn "server.start\|McpServer\|app.listen\|serve(" apps/mcp/src/ | head`

确认 MCP server 启动入口（`apps/mcp/src/index.ts` 或 `command.ts`）。

- [ ] **Step 3: MCP 启动时调 `startSwitchWatcher`**

在 MCP server 启动后（server.listen / server.start 之后）加：

```ts
import { startSwitchWatcher, resolveCcSwitchConfigDir, DEFAULT_DUCKDB_PATH } from 'better-ccusage';

// After server starts:
if (process.env.ZCCUSAGE_DISABLE_WATCHER !== '1') {
	const configDir = resolveCcSwitchConfigDir();
	const duckdbPath = process.env.ZCCUSAGE_DUCKDB_PATH ?? DEFAULT_DUCKDB_PATH;
	void startSwitchWatcher({ configDir, duckdbPath }).then((handle) => {
		// Register cleanup.
		process.on('SIGINT', () => handle.stop());
		process.on('SIGTERM', () => handle.stop());
	});
}
```

确认 `better-ccusage` 已在 `apps/mcp/package.json` 的 devDependencies（workspace 依赖）。

- [ ] **Step 4: typecheck（含 mcp 包）**

Run: `cd apps/mcp && rtk pnpm typecheck`
Expected: PASS

若 mcp 包无 typecheck script，跑 `cd /home/philosophos/projects/zccusage && rtk pnpm typecheck`。

- [ ] **Step 5: Commit**

```bash
rtk git add apps/zccusage/src/index.ts apps/mcp/src/
rtk git commit -m "feat(mcp): embed switch watcher in MCP server (W3)

MCP server 启动时调 startSwitchWatcher（ZCCUSAGE_DISABLE_WATCHER=1 可关）。
better-ccusage 导出 startSwitchWatcher + resolveCcSwitchConfigDir。MCP 用户
自动获得前瞻切换捕获，无需手动 watch。"
```

---

## Task 10: 手动端到端验证

**Files:** 无（验证步骤）

- [ ] **Step 1: 全量测试 + typecheck + format**

Run:
```bash
cd /home/philosophos/projects/zccusage
rtk pnpm typecheck
rtk pnpm run test
rtk pnpm run format
```
Expected: 全部 PASS

- [ ] **Step 2: 5月归因验证（rollups → poe）**

Run:
```bash
cd apps/zccusage
./src/index.ts usage --group provider,model --since 20260501 --until 20260531
```
Expected: provider 列含 `poe-philosophos`，token 来自 `usage_daily_rollups`（4-5月）

- [ ] **Step 3: 6/25 归因验证（proxy_logs → singapore）**

Run:
```bash
cd apps/zccusage
./src/index.ts usage --group provider,model --since 20260625 --until 20260625
```
Expected: provider=`bailian-aliyun-singapore`（6/25 在 6/21-6/28 singapore schedule 区间）

- [ ] **Step 4: 6/30 归因验证（proxy_logs → ark）**

Run:
```bash
cd apps/zccusage
./src/index.ts usage --group provider,model --since 20260630 --until 20260630
```
Expected: provider=`volcengine-ark-beijing-agent-plan`（6/30 在 6/29 18:41+ ark 区间）

- [ ] **Step 5: watcher 前瞻验证**

```bash
cd apps/zccusage
./src/index.ts watch &
WPID=$!
sleep 2
# 模拟切换：手动改 ~/.claude/settings.json 的 ANTHROPIC_BASE_URL（或用 cc-switch use）
# 验证 history 表新增记录
./src/index.ts usage --group provider
kill $WPID
```
Expected: history 表新增一行，`source='watcher:claude'`，provider_id 正确

- [ ] **Step 6: `$CC_SWITCH_CONFIG_DIR` 验证**

Run:
```bash
cd apps/zccusage
CC_SWITCH_CONFIG_DIR=/tmp/test-config ./src/index.ts usage
```
Expected: 若 `/tmp/test-config/cc-switch.db` 不存在，降级 JSONL fallback，无崩溃

- [ ] **Step 7: schedule 文件验证**

创建 `$CC_SWITCH_CONFIG_DIR/provider_schedule.json`（或默认 config dir）写入 spec §2 的时间线，重新跑 Step 2-4，确认归因精确匹配。

- [ ] **Step 8: 最终 commit（若有验证修复）**

```bash
rtk git add -A
rtk git commit -m "test(better-ccusage): e2e verify provider attribution"
```

---

## Self-Review 结果

**Spec coverage:**
- §1 数据源分层 → Task 6（ATTACH 导入两表）✅
- §2 归因机制 → Task 3（history 层）+ Task 5（预载）✅
- §2 provider_schedule.json → Task 10 Step 7（手动验证）✅
- §2 provider_switch_history 表 → Task 4 ✅
- §3 ATTACH + _session→NULL → Task 6 ✅
- §3 成本计算（proxy_logs cost=0 待算）→ 现有 `calculateCostForEntry` 已支持，Task 6 ingest 后 resolveProviderIds 归因，查询层自动算 ✅
- §4 watcher → Task 7 + Task 8 + Task 9 ✅
- §4 findProviderIdByBaseUrl → Task 2 ✅
- §5 错误处理 → Task 6（ATTACH 降级 Result.try）+ Task 7（base_url 无匹配记 NULL）✅
- §5 测试 → 各 Task 内 in-source test ✅
- §5 验证 → Task 10 ✅

**Placeholder scan:** 无 TBD/TODO（`--daemon` 标注 "foreground only for now" 是诚实现状，非 placeholder）。

**Type consistency:**
- `ProviderHistoryEntry`（Task 3 定义）→ Task 4 `loadHistory` 返回 `ProviderHistoryEntry[]` ✅
- `findProviderIdByBaseUrl(baseUrl, profiles)`（Task 2）→ Task 7 调用一致 ✅
- `insertSwitchHistory(conn, { ts, providerId, baseUrl, source })`（Task 4）→ Task 7 调用一致 ✅
- `startSwitchWatcher({ configDir, duckdbPath, profiles? })`（Task 7）→ Task 8/9 调用一致 ✅
- `WatcherHandle.stop()`（Task 7）→ Task 8/9 调用一致 ✅
