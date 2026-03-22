# hunkwise

在 VSCode 中对任意文件变更进行逐块（hunk）接受/丢弃操作。

## 功能特性

- 追踪来自任何来源的文件变更（AI 工具、脚本、手动编辑）
- 在编辑器内联显示逐块 `✓ Accept | ↺ Discard` 操作控件
- 新增行绿色高亮，删除行红色高亮
- 侧边栏面板列出所有待处理文件及块详情，支持批量操作
- 支持新建文件和已删除文件的追踪与展示
- 通过内置轻量 git 仓库持久化状态，VSCode 重启后自动恢复
- 支持 `.gitignore` 和自定义忽略规则

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

## .gitignore

启用时，hunkwise 会自动将 `.vscode/hunkwise/` 添加到项目的 `.gitignore` 文件中。

## 开发

```bash
npm run compile   # 编译 TypeScript
npm run watch     # 监听模式
npm test          # 运行单元测试
```

测试覆盖 `diffEngine`、`hunkwiseGit` 和 `gitignoreManager`，使用 Node 内置测试框架（`node:test`）运行，无需额外依赖。
