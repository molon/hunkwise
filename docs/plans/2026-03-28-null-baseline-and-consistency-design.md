# Null Baseline & State Consistency Design

## Problem

1. **空文件 vs 不存在的文件混淆**: `baseline === ''` 同时表示"新文件（之前不存在）"和"已有的空文件"，导致 discard 时行为错误（空文件被删除而非恢复为空）。
2. **State 与 baseline 不一致**: 内存状态同步更新但 git 异步排队，git 失败时不回滚；load 阶段有竞态。

## Design

### 1. `baseline: string | null`

- **`null`** = 文件之前不存在（新文件），discard → 删除文件
- **`''`** = 文件存在但内容为空，discard → 恢复为空文件
- **`string`** = 文件存在且有内容，discard → 恢复原内容

**Git 持久化映射**:
- `baseline === null` → 不存入 git index（文件不在 hunkwise git 中）
- `baseline === ''` → 存为空 blob
- `baseline === string` → 存为对应 blob
- `getBaseline() === undefined` → 加载时映射为"未追踪"（不进入 reviewing）

**重启后行为**: null-baseline 文件不在 git 中，重启后丢失 reviewing 状态。文件仍在磁盘上，下次变更时会被 adopt 为 baseline。这是可接受的——极少数场景，无数据丢失。

### 2. 空文件追踪

移除 `onDiskCreate` 中 `diskContent.length === 0` 的跳过逻辑。外部创建的空文件进入 reviewing（baseline=null, current=''）。

`enterReviewing` 特殊处理：baseline===null 且 0 hunks 时仍进入 reviewing（新空文件）。
Review panel 特殊处理：baseline===null 的文件即使 0 hunks 也显示。

### 3. Git 失败回滚

`setFile()`, `removeFile()`, `renameFile()` 在 git 操作失败时回滚内存状态到操作前的快照。

### 4. Load 阶段竞态修复

在 `extension.ts` 中，`fileWatcher.register()` 后立即 `suppressAll()`，`load()` 完成后 `resumeAll()`。

## Affected Files

| File | Changes |
|------|---------|
| `types.ts` | `baseline: string \| null` |
| `diffEngine.ts` | `computeHunks(baseline: string \| null, current: string)` — null 视为 '' |
| `stateManager.ts` | null 处理、git 失败回滚、setFile/removeFile/renameFile |
| `fileWatcher.ts` | null baseline、移除空文件跳过、enterReviewing 特殊处理 |
| `commands.ts` | discard: null→删除, ''→恢复空; accept: null baseline split 处理 |
| `reviewPanel.ts` | isNew = baseline === null; 0-hunk null-baseline 文件显示 |
| `extension.ts` | load 期间 suppress FileWatcher |
| `diffEngine.test.ts` | null baseline 测试 |
| `hunkwiseGit.test.ts` | 现有测试已覆盖空内容 |
| Integration tests | 新空文件追踪、null vs '' discard、状态一致性 |
