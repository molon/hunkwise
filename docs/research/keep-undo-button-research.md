# Keep/Undo 按钮定位机制调研

调研时间：2026-03-21

---

## 一、VSCode Chat Editing 的实现方式

### 核心：`addOverlayWidget` + 手动定位

Chat editing 的 Keep/Undo 按钮用的是 **`IOverlayWidget`**（内部 API，**扩展不可访问**）。

```javascript
// workbench.desktop.main.js 中的 lq 类（diff-change-content-widget）
var lq = class {
  constructor(editor, diffInfo, change, versionId, lineDelta) {
    // 创建 DOM 节点
    this._domNode = document.createElement("div");
    this._domNode.className = "chat-diff-change-content-widget";

    // 用 VSCode 内部 toolbar 渲染 Keep/Undo 菜单项
    r.createInstance(tr, this._domNode, D.ChatEditingEditorHunk, { ... });

    // 注册为 OverlayWidget
    this._editor.addOverlayWidget(this);
  }

  layout(startLineNumber) {
    const lineHeight = this._editor.getOption(75); // lineHeight
    const { contentLeft, contentWidth, verticalScrollbarWidth } = this._editor.getLayoutInfo();
    const scrollTop = this._editor.getScrollTop();

    // 定位到 hunk 第一行右上角
    this._position = {
      stackOrdinal: 1,
      preference: {
        top: this._editor.getTopForLineNumber(startLineNumber) - scrollTop - lineHeight * this._lineDelta,
        left: contentLeft + contentWidth - (2 * verticalScrollbarWidth + domNodeWidth)
      }
    };
    this._editor.layoutOverlayWidget(this);
  }
};
```

**关键特性：**
- `getTopForLineNumber(n)` 获取精确像素位置（考虑 ViewZone 高度）
- `getLayoutInfo()` 获取编辑器内容区宽度，按钮放在右边缘
- `lineDelta` 控制向上偏移行数（有 ViewZone 时用于避开红色删除区）
- scroll 滚动时自动通过 `layoutOverlayWidget` 重新定位

### 为什么扩展无法使用

1. `addOverlayWidget` / `layoutOverlayWidget` 是 `ICodeEditor` 内部接口
2. 扩展运行在独立的 **extension host process**（Node.js），与渲染器进程完全隔离
3. 扩展 API 的 `TextEditor` 是通过 IPC proxy 与渲染器通信的，没有暴露 OverlayWidget
4. `vscode.d.ts` 中不存在 `addOverlayWidget` 或任何等价接口

---

## 二、是否有 Hack 方式可以使用内部 API？

### 2.1 彻底不可行的路径

| 路径 | 不可行原因 |
|------|-----------|
| 扩展 process 访问 DOM | extension host 是独立 Node.js，无 window/document |
| 通过 `require()` 加载 monaco 内部模块 | 扩展在 IPC 隔离环境，无法 require workbench 模块 |
| `(editor as any)._codeEditor` | ExtHostTextEditor 在另一个进程，不持有 ICodeEditor 引用 |
| `window.monaco` 全局 | workbench 不暴露 monaco 到 window（仅 web worker 暴露） |
| executeCommand 注入 DOM | executeCommand 只能调用已注册的命令，不能传 DOM 回调 |

### 2.2 理论上可行但极其受限的路径

#### 路径 A：`extensionKind: ["ui"]` + Renderer Process Extension Host

VSCode 支持在渲染器进程中运行扩展（用于本地扩展），但：
- 仍然运行在独立的 worker/iframe 环境
- 没有访问 workbench 内部服务的权限
- 只是"在渲染器进程里的 extension host"，依然通过 IPC 通信

#### 路径 B：Webview 中的 Monaco Editor

如果在 WebviewPanel 里自己创建一个 Monaco Editor 实例（通过 monaco-editor npm 包），可以完全控制。但：
- 是独立的编辑器实例，不是 VSCode 原生编辑器
- 用户必须在 webview 里编辑，体验极差

#### 路径 C：修改 VSCode 源码 / 自定义 VSCode fork

完全可行，但需要维护 fork，对用户不透明。

#### 路径 D：`--inspect-extensions` + 调试桥接（开发调试用）

仅用于开发阶段调试，不是生产方案。

### 2.3 结论

**扩展无法访问 VSCode 内部 API（addOverlayWidget 等）。**

---

## 三、在扩展 API 范围内的最优替代方案

### 方案：两个 inset 叠放

使用 `createWebviewTextEditorInset`（proposed API）：
1. **删除行 inset**：放在 hunk 绿色区域上方，红色背景，显示原始行内容
2. **按钮 inset**（1行高）：放在绿色区域最后一行下方，透明背景，右对齐按钮

**`createWebviewTextEditorInset(editor, line, height)` 参数确认：**
- `line` 是 **0-based**（ExtHost 内部会 `+1` 再传给 MainThread 的 ViewZone `afterLineNumber`）
- inset 出现在 `line`（0-based）行和 `line+1` 行之间（即 `line` 行**下方**）
- 例：`line=4`（0-based 第5行）→ inset 出现在第5行和第6行之间

**正确的 afterLine 计算（0-based）：**
```
hunk.newStart = 5（1-based，hunk 从第5行开始）
要把 inset 放在第5行上方 = 放在第4行和第5行之间
afterLine = 4（0-based）= newStart - 1（1-based） - 1（转0-based） = newStart - 2
```
即 `afterLine = Math.max(0, hunk.newStart - 2)`（原来第一版的写法是正确的！）

**换行问题：** inset 宽度跟随 VSCode 编辑器，但 webview 内 `white-space: pre-wrap` 只有在容器有明确宽度时才换行。需设 `body { width: 100%; overflow-wrap: break-word; }`。

**左边距问题：** inset 的 ViewZone 从编辑器内容区左边开始，实际包含行号区域。需要把 `padding-left` 设为与编辑器行号宽度匹配的值。由于无法从 webview 内部获取行号宽度，可以设为 `0` 或通过 `--vscode-editor-*` 变量尝试。

---

## 四、从 demo.html 实测数据分析（2026-03-21）

通过抓取 VSCode Chat Editing 真实渲染的 HTML（`docs/references/demo.html`），得到以下实测数据：

### 编辑器布局参数

```
overflow-guard 总宽:  550px
margin（行号区）宽:   66px（glyph-margin: 18px + line-numbers area: 48px）
view-zones / view-lines 宽: 420px（= 550 - 66 - 64px scrollbar区）
line-height: 18px
font-size: 12px
contentLeft: 66px
```

### chat-editing-original-zone（删除行 ViewZone）结构

每条删除行是一个独立的 `<div class="chat-editing-original-zone view-lines line-delete">` ViewZone：

```html
<div class="chat-editing-original-zone view-lines line-delete monaco-mouse-cursor-text"
     monaco-view-zone="f50"
     style="position: absolute; width: 100%; top: 36px; height: 18px; line-height: 18px;">
  <div class="view-line" style="top:0px; width:1000000px;">
    <span><span class="mtk1">This is a demonstration file.</span></span>
  </div>
</div>
```

**关键点：**
- `width: 100%`（相对于 view-zones 容器，即内容区宽度）
- `view-line` 内用 `width:1000000px` 模拟无限宽（不换行，依赖编辑器的横向滚动）
- 文字有 syntax highlight token（`mtk1`, `mtk24` 等 class）——**用的是编辑器的 tokenizer 渲染，不是 webview**
- 被删除的字符额外带 `char-delete` class（字符级 diff 标注）

### chat-diff-change-content-widget（Keep/Undo 按钮 OverlayWidget）定位

```html
<div class="chat-diff-change-content-widget"
     widgetid="diff-change-widget-0"
     style="position: absolute; top: 0px; left: 340px;">
```

实测多个 widget 的 `top` 与对应 hunk 起始行像素的关系：

| widgetid | top    | 对应行（1-based） | 公式验证               |
|----------|--------|-------------------|------------------------|
| widget-0 | 0px    | 第1行             | (1-1) × 18 = 0px ✓    |
| widget-1 | 36px   | 第3行             | (3-1) × 18 = 36px ✓   |
| widget-2 | 252px  | 第15行            | (15-1) × 18 = 252px ✓ |

`left: 340px` = `contentLeft(66) + contentWidth(420) - widgetWidth` ≈ 486 - widget宽度

**结论：按钮 top = (hunk.newStart - 1) × lineHeight**，即对齐到 hunk 第一行的顶部。这与 `getTopForLineNumber(n) - scrollTop` 的计算完全一致（lineDelta=1 时再减一行高）。

### 对 createWebviewTextEditorInset `line` 参数的最终结论

根据实际运行效果（非文档推断）：

- **`line` 参数是 1-based**
- `createWebviewTextEditorInset(editor, line, height)` → inset 出现在第 `line` 行**之后**（即第 `line` 和 `line+1` 行之间）
- 要让 inset 出现在 `hunk.newStart`（1-based）上方：`afterLine = hunk.newStart - 1`
- 要让 action bar inset 覆盖最后一行绿色区域（不额外占行）：`afterLine = hunk.newStart + hunk.newLines - 2`

---

## 五、参考

- VSCode 源码：`lq` 类（`workbench.desktop.main.js` 约 11241000 处）
- `Ami` 类（WebviewEditorInset 的 MainThread 实现）：`afterLineNumber = line + 1`
- ExtHost `createWebviewEditorInset`：`$createEditorInset(l, s.id, uri, e+1, n, ...)` — line 参数 +1
- Issue: https://github.com/microsoft/vscode/issues/85682
