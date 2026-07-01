# Provider 历史归因系统设计

**日期**: 2026-07-01
**分支**: feature/multi-currency
**状态**: 设计已确认，待写实现计划

## 背景与动机

zccusage 需将每条 JSONL/cc-switch.db 用量记录归因到具体 provider（reseller/region/plan）。当前痛点：

- cc-switch.db `providers` 表仅存 `is_current` 快照，无切换历史
- JSONL 会话日志无 `base_url` 字段，无法直接归因
- cc-switch.db `proxy_request_logs`/`usage_daily_rollups` 的 `provider_id` 全为 `_session`（cc-switch.cli 同样未归因）
- 现有 `resolveProviderId` 仅靠 schedule + is_current，历史切换后无自动记录

## 关键调查发现

### cc-switch.db 数据现状（`$CC_SWITCH_CONFIG_DIR/cc-switch.db`，路径 `~/.config/cc-switch/`）

| 表 | 时间范围 | 行数 | token | cost | provider_id |
|----|---------|------|-------|------|-------------|
| `usage_daily_rollups` | 2026-04-25 ~ 05-26 | 42 | ✅ | ✅ 有 | `_session` |
| `proxy_request_logs` | 2026-06-22 ~ 07-01 | 3572 | ✅ | ❌ 全 `'0'` | `_session` |
| `session_log_sync` | 2026-06-11 ~ 07-01 | 1397 | ❌ 仅索引 | — | — |

- `provider_id` 全为 `_session`：cc-switch.cli 已同步 JSONL→结构化 SQL，但同样未做 provider 归因
- `proxy_request_logs` cost 全 `'0'`：zccusage 必须自算成本
- 5/27-6/21 基本无 token消耗（缺口可跳过 JSONL fallback）

### cc-switch-cli 调查（https://github.com/SaladDay/cc-switch-cli）

- **无 post-switch hook**：README 全文无 `--on-switch`/`--post-switch`/外部命令执行配置
- 切换触发：TUI `cc-switch` / CLI `cc-switch use <id>`
- 切换副作用：原子写各 app live config（`~/.claude/settings.json` 含 `env.ANTHROPIC_BASE_URL` 等）
- 可用 `CC_SWITCH_CONFIG_DIR` 覆盖配置目录

## 设计决策（已确认）

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 前瞻+回顾 | 同时需要 | 前瞻自动捕获未来切换；回顾补历史 |
| 前瞻捕获 | B1 文件监听 live config | cc-switch 无 hook；原子写是可靠切换信号 |
| watcher 生命周期 | W3 MCP 内嵌 + W1 CLI fallback | MCP server 已常驻，纯 CLI 用户手动 `watch` |
| history 存储 | S1 单存 DuckDB | 零外部 schema 耦合；OLAP join 自然 |
| 回顾归因 | R1 手动 schedule + R4 undefined 兜底 | schedule 精确；未覆盖区间 undefined（model_id 仍走静态定价） |
| billing API | R5 不自动归因，作 R1 数据源辅助 | 聚合匹配不可靠；超工具范围 |
| 数据源 | cc-switch.db 主源 + JSONL fallback | db 结构化已去重；JSONL 仅缺口/校验 |

## 架构总览

```
┌─ cc-switch-cli (外部) ────────────────────────┐
│  cc-switch.db                                 │
│    providers (is_current 快照)                │
│    proxy_request_logs (per-request, _session) │
│    usage_daily_rollups (日聚合, _session)     │
│  切换 → 原子写 ~/.claude/settings.json 等     │
└─────────────────┬────────────────────────────┘
                  │ 文件变更事件
                  ▼
┌─ watcher (W3 MCP内嵌 / W1 CLI watch) ─────────┐
│  监听 live config 原子写                      │
│  → 读 base_url → findProviderIdByBaseUrl      │
│  → INSERT provider_switch_history (DuckDB)    │
└─────────────────┬────────────────────────────┘
                  │
                  ▼
┌─ better-ccusage.duckdb (S1 单存) ─────────────┐
│  usage_facts (ATTACH cc-switch.db 导入)      │
│  provider_switch_history (watcher 写入)       │
│  ingested_files / ingest_meta (现有)          │
└─────────────────┬────────────────────────────┘
                  │ 查询
                  ▼
┌─ resolveProviderId (改造) ────────────────────┐
│  优先级:                                      │
│  1. 手动 schedule (R1)                         │
│  2. provider_switch_history (按 ts 最近一条)  │
│  3. is_current 快照                           │
│  4. undefined (R4 兜底)                      │
└──────────────────────────────────────────────┘
```

## §1 数据源分层

```
时间轴:  4/25 ──────── 5/26 │ 5/27 ─── 6/21 │ 6/22 ────── now
         ┌─ usage_daily_rollups ─┐ │ ~无用量      │ ┌─ proxy_request_logs ─┐
         │  (日聚合,含cost)     │ │ (跳过)      │ │  (per-request,cost=0)│
         └─────────────────────┘ └─────────────┘ └──────────────────────┘
```

三段：
- **4/25-5/26**：db `usage_daily_rollups`（日聚合，含 cost，POE 时期）
- **5/27-6/21**：~无用量（不读 JSONL；校验时若发现零星记录再处理）
- **6/22-now**：db `proxy_request_logs`（per-request，cost=0 待算）

zccusage 数据加载直接消费 cc-switch.db 两表，JSONL 退化为"仅在 db 未覆盖时段"的校验源。

## §2 Provider 归因机制

### 归因核心流程

```
db row {ts, _session, model, tokens}
  ├─ ts 来源:
  │   ├─ usage_daily_rollups.date → 日期 (4-5月, 日粒度)
  │   └─ proxy_request_logs.created_at → epoch秒 (6/22+, per-request)
  ▼ resolveProviderId(ts, ctx)
  ├─ 优先级:
  │   1. schedule (R1 手动) — provider_schedule.json
  │   2. history (watcher 自动) — provider_switch_history 表
  │   3. is_current 快照 — cc-switch.db providers 表
  │   4. undefined (R4 兜底)
  ▼
真 providerId → deriveProfileFields(id, baseUrl) → {platform, region, planType}
```

### provider_schedule.json（R1 手动回顾）

路径：`$CC_SWITCH_CONFIG_DIR/provider_schedule.json`

按已确认时间线填充（用户据账单+时间线核对）：

```json
[
  { "from": "2026-04-25", "to": "2026-06-21T14:03:26", "providerId": "poe-philosophos" },
  { "from": "2026-06-21T14:03:26", "to": "2026-06-28T17:35:43", "providerId": "bailian-aliyun-singapore" },
  { "from": "2026-06-28T17:56", "to": "2026-06-29T18:41:14", "providerId": "aliyun-bailian-beijing-token-plan" },
  { "from": "2026-06-29T18:41:14", "to": "2026-07-01T00:00:00", "providerId": "volcengine-ark-beijing-agent-plan" }
]
```

5/27-6/21 空洞不在 schedule（无用量，undefined 无害）。

### provider_switch_history（watcher 自动前瞻）

DuckDB 表，watcher 写入：

```sql
CREATE TABLE IF NOT EXISTS provider_switch_history (
  ts          TIMESTAMPTZ,    -- 切换时刻 (live config mtime)
  provider_id TEXT,           -- 回填后真 id
  base_url    TEXT,            -- 触发切换的 base_url
  source      TEXT             -- 'watcher:claude' | 'watcher:codex' | ...
);
CREATE INDEX IF NOT EXISTS idx_history_ts ON provider_switch_history(ts);
```

### 日粒度特殊处理

`usage_daily_rollups` 只有 `date`（无时刻）。归因：
- 4/25-5/26 全在 POE schedule 区间 → 整天 = poe-philosophos（精确）
- 若某天跨切换边界 → 取 date 当天 12:00 作 ts 查 schedule（近似，日聚合本就模糊）

### resolveProviderId 改造

现有优先级：schedule → is_current → undefined。**插入 history 层**：

```ts
// _provider-profile-loader.ts resolveProviderId 改为:
1. schedule (R1)          ← 不变
2. history (watcher)       ← 新增: 查 DuckDB 最近一条 ts ≤ entry.ts
3. is_current              ← 降级
4. undefined               ← 不变
```

history 查询需 DuckDB 连接。`resolveProviderIds`（`_duckdb-store.ts`）预载 history 到内存（按 ts 排序），二分查找最近 ts ≤ entry.ts。

### 归因覆盖矩阵

| 时段 | 数据源 | 粒度 | 归因来源 | 结果 |
|------|--------|------|---------|------|
| 4/25-5/26 | rollups | 日 | schedule R1 | poe-philosophos ✅ |
| 5/27-6/21 | ~无 | — | — | — |
| 6/22-6/29 18:41 | proxy_logs | per-req | schedule R1 | singapore→bailian ✅ |
| 6/29 18:41-now | proxy_logs | per-req | schedule R1 + watcher history | ark ✅ |
| 未来 | proxy_logs | per-req | watcher history (自动) | ✅ |

## §3 数据加载 + DuckDB Schema + 成本

### ATTACH cc-switch.db 导入

```sql
ATTACH 'cc-switch.db' AS ccs (READ_ONLY);

-- 6/22+ per-request
INSERT INTO usage_facts (...)
SELECT
  md5(...) AS message_hash,
  to_timestamp(created_at) AS timestamp,
  session_id, NULL AS project,
  'claude' AS source,
  'cc-switch:proxy_request_logs' AS source_path,
  model,
  CASE WHEN provider_id='_session' THEN NULL ELSE provider_id END,
  input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
  total_cost_usd, NULL AS version, CURRENT_TIMESTAMP
FROM ccs.proxy_request_logs
WHERE created_at IS NOT NULL
ON CONFLICT(message_hash) DO NOTHING;

-- 4-5月 daily rollups
INSERT INTO usage_facts (...)
SELECT
  md5(date||model||provider_id) AS message_hash,
  date::TIMESTAMP AS timestamp,
  NULL AS session_id, NULL AS project,
  'claude' AS source,
  'cc-switch:usage_daily_rollups' AS source_path,
  model,
  CASE WHEN provider_id='_session' THEN NULL ELSE provider_id END,
  input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
  total_cost_usd, NULL AS version, CURRENT_TIMESTAMP
FROM ccs.usage_daily_rollups
ON CONFLICT(message_hash) DO NOTHING;
```

### `_session` → NULL 归因触发

cc-switch.db `provider_id='_session'` 不是真 NULL。ingest 时转 NULL，触发现有 `resolveProviderIds` pass（`WHERE provider_id IS NULL`）。

### 数据源优先级（去重）

```
1. cc-switch.db proxy_request_logs  (6/22+, per-request, 优先)
2. cc-switch.db usage_daily_rollups (4-5月, 日聚合)
3. JSONL fallback                    (5/27-6/21 gap, ~无用量)
```

`message_hash` 跨源去重。JSONL ingest 保留作 fallback + 校验（`--no-duckdb` 或 gap 检测时启用）。

### 新增 schema

```sql
CREATE TABLE IF NOT EXISTS provider_switch_history (
  ts          TIMESTAMPTZ,
  provider_id TEXT,
  base_url    TEXT,
  source      TEXT
);
CREATE INDEX IF NOT EXISTS idx_history_ts ON provider_switch_history(ts);
```

### 成本计算

| 来源 | cost_usd 状态 | 处理 |
|------|--------------|------|
| `usage_daily_rollups` (4-5月) | ✅ 有 `total_cost_usd` | 直接用，mode=auto/display |
| `proxy_request_logs` (6/22+) | ❌ 全 `'0'` | `resolveProviderIds` 后，`calculateCostForEntry` 按 model+providerId 算 |
| JSONL fallback | ✅ costUSD | 现有逻辑 |

`proxy_request_logs` cost=0 → zccusage 必须算。`_duckdb-query.ts` 现有 `calculateCostForEntry(synth, mode, fetcher, provider_id)` 已支持，仅需保证 provider_id 先归因再算成本。

### ingest 编排改造

```
syncIngest():
  1. ATTACH cc-switch.db (READ_ONLY)
  2. import proxy_request_logs → usage_facts (_session→NULL)
  3. import usage_daily_rollups → usage_facts (_session→NULL)
  4. [可选] JSONL fallback: 仅 db 未覆盖时段
  5. resolveProviderIds(conn, ctx)  ← 含 history 层
  6. detectScheduleStale → 提示 --rebuild
```

cc-switch.db 路径解析：`$CC_SWITCH_CONFIG_DIR/cc-switch.db`，复用 `_provider-profile-loader.ts` 的 `resolveDbPath`（加新默认候选 `~/.config/cc-switch/cc-switch.db`）。

## §4 Watcher 实现 + MCP 内嵌

### watcher 核心逻辑

```
1. chokidar 监听 live config 文件
   - ~/.claude/settings.json (claude)
   - ~/.codex/config.toml (codex)
   - ~/.gemini/.env (gemini)
   - ... (按 visibleApps)
2. 文件 change 事件 (atomic write 检测)
3. 读 env.ANTHROPIC_BASE_URL (或对应字段)
4. 反查: findProviderIdByBaseUrl(baseUrl)
   ← 扫 cc-switch.db providers.settings_config
5. derive providerId
6. INSERT provider_switch_history
   (ts=file mtime, provider_id, base_url, source='watcher:<app>')
```

### base_url 反查（`_provider-profile-loader.ts` 新增）

```ts
export function findProviderIdByBaseUrl(
  baseUrl: string,
  profiles: ProviderProfile[],
): string | undefined {
  for (const p of profiles) {
    if (p.baseUrl === baseUrl) return p.id;
  }
  // 宽松匹配: 同 host 视为同 provider
  try {
    const targetHost = new URL(baseUrl).hostname;
    for (const p of profiles) {
      if (p.baseUrl == null) continue;
      if (new URL(p.baseUrl).hostname === targetHost) return p.id;
    }
  } catch { /* ignore */ }
  return undefined;
}
```

### W3：MCP server 内嵌

`@better-ccusage/mcp` server 已常驻。启动时起 watcher：

```ts
import { startSwitchWatcher } from 'better-ccusage';

// server 启动后
if (process.env.ZCCUSAGE_DISABLE_WATCHER !== '1') {
  startSwitchWatcher({
    configDir: resolveCcSwitchConfigDir(),
    duckdbPath: resolveDuckdbPath(),
  });
}
```

`startSwitchWatcher` 从 better-ccusage 导出（CLI + MCP 共用）。

### W1：CLI 手动 fallback

```bash
# 前台运行（开发/调试）
zccusage watch

# 后台 daemon（生产）
zccusage watch --daemon
```

`watch` 子命令注册到 `commands/index.ts` 的 `subCommandUnion`：

```ts
export const subCommandUnion = [
  ['blocks', blocksCommand],
  ['statusline', statuslineCommand],
  ['watch', watchCommand],  // 新增
] as const;
```

daemon 模式：`--daemon` fork 后台，PID 写 `$CC_SWITCH_CONFIG_DIR/zccusage-watcher.pid`。

### watcher 去抖动

cc-switch 原子写可能触发多次事件（temp + rename）。300ms 去抖合并。

### 防重复记录

同 providerId 短时间内多次切换 → 只记首次：

```sql
SELECT provider_id FROM provider_switch_history
  WHERE ts >= now() - INTERVAL 5 SECONDS
  ORDER BY ts DESC LIMIT 1;
-- 若 == 当前 providerId, skip
```

### 降级：watcher 未运行

watcher 未起（无 MCP + 未手动 `watch`）：
- 前瞻切换不记 history
- `resolveProviderId` 降级到 schedule → is_current → undefined（现有行为）
- 不影响读取，仅归因精度下降

用户下次跑 `zccusage usage` 时若发现 is_current 变了但 history 无记录 → 可选补记（启动检测兜底）。

## §5 错误处理 + 测试 + 验证

### 错误处理（@praha/byethrow Result）

降级链：
1. cc-switch.db ATTACH 失败 → JSONL fallback（现有 `ingestClaudeFile`）
2. base_url 反查失败 → history 写 NULL provider_id，不阻断
3. DuckDB 写入失败 → watcher 重试 + log，下次启动检测补
4. watcher 未运行 → `resolveProviderId` 降级（现有行为）

```ts
const attachResult = await Result.try({
  try: async () => { await conn.run(`ATTACH '${dbPath}' AS ccs (READ_ONLY)`); },
});
if (Result.isFailure(attachResult)) {
  logger.warn(`cc-switch.db ATTACH 失败: ${attachResult.error.message}`);
  await ingestClaudeFiles(conn, claudePaths);
}
```

### 测试覆盖

**归因测试**（`_provider-profile-loader.ts` 现有测试块扩展）：
- `findProviderIdByBaseUrl`：精确匹配 / 同 host 宽松 / 无匹配
- `resolveProviderId` 含 history 层：history 优先于 is_current / schedule 优先于 history / history 空时降级

**ingest 测试**（`_duckdb-store.ts`）：
- `_session` → NULL 触发归因
- `proxy_request_logs` 6/22+ 全量导入
- `usage_daily_rollups` 4-5月导入
- ATTACH 失败降级 JSONL

**watcher 测试**：
- live config change → history 记录
- 去抖动合并连续事件
- 同 providerId 5s 内不重复
- base_url 无匹配 → provider_id NULL

**端到端**：
- 完整归因链：db 记录 → schedule → 真 providerId

### 验证步骤

```bash
# 1. typecheck
rtk pnpm typecheck

# 2. 单元测试
rtk pnpm run test

# 3. format
rtk pnpm run format

# 4. 手动端到端 (apps/zccusage)
cd apps/zccusage

# 4a. 归因验证 — 5月 rollups 应归 poe
./src/index.ts usage --group provider,model --since 20260501 --until 20260531
# 期望: provider=poe-philosophos

# 4b. 归因验证 — 6/25 per-request 应归 singapore (6/25 在 6/21-6/28 singapore 区间)
./src/index.ts usage --group provider,model --since 20260625 --until 20260625
# 期望: provider=bailian-aliyun-singapore

# 4c. 归因验证 — 6/30 应归 ark
./src/index.ts usage --group provider,model --since 20260630 --until 20260630
# 期望: provider=volcengine-ark-beijing-agent-plan

# 4d. watcher 验证
./src/index.ts watch &
# 手动 cc-switch use <id>, 验证 history 表新增记录

# 4e. $CC_SWITCH_CONFIG_DIR 验证
CC_SWITCH_CONFIG_DIR=/tmp/test ./src/index.ts usage
# 期望: 读 /tmp/test/cc-switch.db
```

## 关键文件改动清单

| 文件 | 改动 |
|------|------|
| `_consts.ts` | `CC_SWITCH_DB_PATHS` 加 `~/.config/cc-switch/cc-switch.db` + `$CC_SWITCH_CONFIG_DIR` 候选 |
| `_provider-profile-loader.ts` | 加 `findProviderIdByBaseUrl`；`resolveProviderId` 插入 history 层 |
| `_duckdb-store.ts` | 新增 `provider_switch_history` schema；ingest 加 ATTACH cc-switch.db 导入两表；`resolveProviderIds` 预载 history |
| `_duckdb-query.ts` | 适配 `_session`→NULL 归因后的查询（现有已支持 NULL，无需大改） |
| `_shared-args.ts` | `dbPath` description 更新为 `$CC_SWITCH_CONFIG_DIR/better-ccusage.duckdb` |
| `commands/watch.ts` | 新建 — watcher CLI 子命令（W1 fallback） |
| `commands/index.ts` | `subCommandUnion` 加 `watch` |
| `_switch-watcher.ts` | 新建 — `startSwitchWatcher` 实现（chokidar + 反查 + 写 history） |
| `apps/mcp/src/index.ts` | 启动时调 `startSwitchWatcher`（W3 内嵌） |

## 约束

- cc-switch.db 只读（zccusage 不写外部 schema）
- history 单存 DuckDB（S1，零外部耦合）
- `$CC_SWITCH_CONFIG_DIR` 锚定所有路径
- `@praha/byethrow` Result 错误处理
- 无 `console.log`（用 `logger.ts`）
- 本地导入 `.ts` 扩展名
- Vitest 全局变量（无 `await import()`）
- 依赖加 `devDependencies`
