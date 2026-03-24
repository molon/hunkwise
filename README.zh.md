# hunkwise

在 VSCode 中对任意文件变更进行逐块（hunk）接受/丢弃操作。

[Claude Code](https://docs.anthropic.com/en/docs/claude-code)、[OpenCode](https://github.com/anomalyco/opencode) 等 AI 编程工具以 CLI 或插件形式运行，不像 Cursor、Windsurf、Copilot 那样拥有原生 IDE，因此缺少逐块审查变更的内置体验。

**hunkwise** 正是为此而生——将逐块 review 控件直接带入 VSCode，适用于任何外部文件变更。

![snapshot](media/snapshot.png)

## 功能特性

- 追踪来自任何来源的文件变更（AI 工具、脚本、手动编辑）
- 在编辑器内联显示逐块 `✓ Accept | ↺ Discard` 操作控件
- 新增行绿色高亮，删除行红色高亮
- 侧边栏面板列出所有待处理文件及块详情，支持批量操作
- 支持新建文件和已删除文件的追踪与展示
- 通过内置轻量 git 仓库持久化状态，VSCode 重启后自动恢复
- 支持 `.gitignore` 和自定义忽略规则

## 安装

hunkwise 使用了 [VSCode 提案 API](https://code.visualstudio.com/api/advanced-topics/using-proposed-api)（`editorInsets`），无法从应用商店安装。

直接告诉你的 AI 工具：

> Run this skill: <https://github.com/molon/hunkwise/blob/main/skills/install-hunkwise/SKILL.md>

## 使用方法

### 启用 hunkwise

在 hunkwise 侧边栏面板中点击 **Enable**。hunkwise 会对当前工作区所有文件做一次快照作为基线。

### 自动追踪

启用后，任何外部工具（AI 助手、脚本等）写入文件时，hunkwise 会自动进入该文件的审查模式。

### 审查变更

- 在编辑器中点击每个块上方的 `✓` 或 `↺` 按钮
- 在 **hunkwise** 侧边栏面板中可以：
  - 查看所有有待处理变更的文件
  - 对单个块执行接受或丢弃
  - 对某个文件的所有变更执行接受或丢弃
  - 对全部文件的所有变更执行接受或丢弃
- 点击面板中的文件名可在编辑器中打开该文件
- 已删除的文件会以 diff 视图展示原始内容

### 禁用 hunkwise

在面板中点击 **Disable**，所有追踪状态将被清除。

## 命令

| 命令 | 描述 |
| ---- | ---- |
| `hunkwise: Enable` | 启用 hunkwise 并对工作区做快照 |
| `hunkwise: Disable` | 禁用 hunkwise 并清除所有状态 |
| `hunkwise: Settings` | 打开设置面板 |

## 设置

设置存储在 `.vscode/hunkwise/settings.json` 中，可在设置面板中修改：

| 设置项 | 默认值 | 描述 |
| ------ | ------ | ---- |
| `ignorePatterns` | `[".git"]` | 不追踪的 glob 模式列表 |
| `respectGitignore` | `true` | 是否遵守 `.gitignore` 规则 |
| `clearOnBranchSwitch` | `false` | 切换 git 分支时自动清除所有待处理的 hunk |

## .gitignore

启用时，hunkwise 会自动将 `.vscode/hunkwise/` 添加到项目的 `.gitignore` 文件中。

## 工作原理

### 基线追踪

启用 hunkwise 后，它会将工作区所有文件快照到一个位于 `.vscode/hunkwise/git/` 的私有 git 仓库中。该仓库存储**基线** —— 即 hunkwise 开始追踪时每个文件的内容。仓库始终只有一个 commit（每次变更都使用 `--amend`）。

当外部工具修改文件时，hunkwise 会将当前内容与存储的基线进行 diff 以生成 hunk。接受某个 hunk 会更新基线；丢弃某个 hunk 则恢复基线内容。

### 外部变更 vs 手动编辑检测

hunkwise 会区分以下两种情况：

- **外部变更**（AI 工具、脚本）：当磁盘上的文件内容与编辑器缓冲区不一致时被检测到。这会触发审查模式并显示内联 hunk。
- **手动编辑**（用户在 VSCode 中输入）：保存后编辑器缓冲区与磁盘内容一致。这会静默更新基线 —— 不会产生 hunk。

这意味着你可以在 hunkwise 启用期间自由编辑文件，只有工具生成的变更才会产生 hunk。

### 文件重命名与删除处理

- **手动重命名**（通过 VSCode 资源管理器/API）：hunkwise 会将基线迁移到新路径，不会产生虚假的删除 hunk。
- **手动删除**（通过 VSCode 资源管理器/API）：hunkwise 移除基线，不会产生删除 hunk。
- **外部删除**（工具删除文件）：显示删除 hunk，以便你可以审查并在需要时恢复。

### 忽略规则

文件可通过两种机制排除追踪：

1. **ignorePatterns**（`.vscode/hunkwise/settings.json` 中）—— 自定义模式（默认：`[".git"]`，macOS 上还包括 `".DS_Store"`）
2. **`.gitignore`** —— 当 `respectGitignore` 为 true（默认）时，遵守工作区 `.gitignore` 规则

当忽略规则变更（`.gitignore` 被修改，或通过设置更新模式）时，hunkwise 会自动：

- 移除现在被忽略的文件的基线
- 为新放行的文件添加基线

### 状态持久化

所有基线数据存储在 git 仓库中，可跨 VSCode 重启保留。重新激活时，hunkwise 从 `git ls-tree HEAD` + `git show :path` 读取基线以恢复内存状态。

## 开发

```bash
npm run compile          # 编译 TypeScript
npm run watch            # 监听模式
npm test                 # 运行单元测试（node:test 框架）
npm run test:integration # 运行 VSCode 集成测试
```

单元测试覆盖 `diffEngine`、`hunkwiseGit` 和 `gitignoreManager`，使用 Node 内置测试框架（`node:test`）运行，无需额外依赖。

集成测试通过 `@vscode/test-cli` 在真实的 VSCode 扩展宿主中运行，覆盖重命名/删除处理、.gitignore 同步、文件监听以及启用/禁用生命周期。
