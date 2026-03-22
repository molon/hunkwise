# Inline Diff Decoration 技术调研

调研时间：2026-03-21
调研对象：VSCode Insiders (workbench.desktop.main.js)
目标：理解 VSCode inline diff（含删除行文本）的实现原理，寻找扩展可复用的方案

---

## 一、结论摘要

VSCode inline edit 的删除行显示使用了 **VSCode 内部 ViewZone API**，扩展无法直接调用。但 VSCode 提供了一个 **Proposed API `editorInsets`**（`createWebviewTextEditorInset`），可以在编辑器任意行插入 Webview，足以实现同等视觉效果。

---

## 二、VSCode Chat Editing 的实现原理

### 2.1 核心数据流

```
diff (original vs modified lines)
  ↓
nR(lineTokenData, editorInfo, decorations, domNode)   // 内部渲染函数
  ↓
domNode: <div class="chat-editing-original-zone view-lines line-delete">
           <div class="view-line" style="top:Npx; width:1000000px;">
             ... tokenized/colored HTML ...
           </div>
         </div>
  ↓
editor.changeViewZones(accessor => {
  accessor.addZone({
    afterLineNumber: modifiedStart - 1,
    heightInLines: originalLineCount,
    domNode: domNode,
    ordinal: 50002,
  });
})
```

### 2.2 关键代码位置（workbench.desktop.main.js）

**删除行 ViewZone 创建（Chat Editing）：**
```javascript
let V = document.createElement("div");
V.className = "chat-editing-original-zone view-lines line-delete monaco-mouse-cursor-text";
let U = nR(_, S, P, V);  // 内部：用 token 渲染 HTML 到 V
if (!O) {
  let G = {
    afterLineNumber: w.modified.startLineNumber - 1,
    heightInLines: U.heightInLines,
    domNode: V,
    ordinal: 50002
  };
  this._viewZones.push(g.addZone(G));
}
```

**Ghost Text（InlineCompletion）附加行渲染（`adi` 类）：**
```javascript
// Wzo 函数把 token 化的行内容渲染成 HTML，注入 div
function Wzo(a, i, e, t, o) {
  // 生成 <div class="suggest-preview-text">
  //   <div class="view-line" style="top:Npx; width:1000000px;">...</div>
  // </div>
  a.innerHTML = v;
}
// updateLines 创建 ViewZone
this._editor.changeViewZones(l => {
  let p = document.createElement("div");
  Wzo(p, r, t, this._editor.getOptions(), this._isClickable);
  this.addViewZone(l, e, u, p);
});
```

**Diff Editor（并排）中的删除行（`byt` 类）：**
使用更复杂的 `nR` 渲染函数（含 tokenization），同样通过 ViewZone 插入。

### 2.3 为什么扩展无法直接复用

- `editor.changeViewZones` 是 `ICodeEditor` 接口方法，仅在 workbench 内部可访问
- `nR` / `Wzo` 是内部渲染函数，扩展无法调用
- `vscode.TextEditor` 扩展 API 没有暴露 ViewZone 相关方法

---

## 三、扩展可用的方案

### 方案 A：`createWebviewTextEditorInset`（Proposed API，推荐）

VSCode 提供了一个 Proposed API，允许在编辑器某行注入 Webview：

```typescript
// package.json
{
  "enabledApiProposals": ["editorInsets"]
}

// extension.ts
const inset = vscode.window.createWebviewTextEditorInset(
  editor,    // TextEditor
  line,      // 0-based line number（插入在此行之后）
  height,    // 行数（高度）
  { enableScripts: false }
);
inset.webview.html = `
  <html><body style="margin:0;padding:0;background:var(--vscode-diffEditor-removedLineBackground)">
    <pre style="margin:0;color:var(--vscode-diffEditor-removedTextForeground);
                font-family:var(--vscode-editor-font-family);
                font-size:var(--vscode-editor-font-size);
                line-height:var(--vscode-editor-line-height)">
      ${escapedContent}
    </pre>
  </body></html>
`;
```

**优点：**
- 官方（虽为 proposed）接口，稳定性强
- 可注入任意 HTML，完全控制视觉效果
- 自动处理行高、滚动同步

**缺点：**
- 需要在 `package.json` 中声明 `"enabledApiProposals": ["editorInsets"]`
- 需要 VSCode Insiders 或较新版本（已存在多年，稳定）
- 每个 inset 都是独立的 webview，多个 hunk 时资源消耗较大
- 发布到 marketplace 的扩展不能使用 proposed API（但 hunkwise 不需要发布）

**如何启用 Proposed API：**
```json
// package.json
{
  "engines": { "vscode": "^1.90.0" },
  "enabledApiProposals": ["editorInsets"]
}
```

开发时需要在调试时加上 `--enable-proposed-api molon.hunkwise`，或在 `.vscode/launch.json` 中：
```json
{
  "args": ["--extensionDevelopmentPath=${workspaceFolder}", "--enable-proposed-api=molon.hunkwise"]
}
```

### 方案 B：`TextEditorDecorationType` + CSS `::before` 注入（现有方案）

当前实现方式。通过在 decoration type 的 `before.textDecoration` 中注入 CSS 属性实现 `display:block` 效果。

**核心限制（已确认）：**
- `::before` 伪元素默认 `display:inline`，需要注入 `display:block`
- VSCode 会在设置了 `width` 或 `height` 字段时追加 `display:inline-block`，覆盖注入的 `display:block`
- `::before` 是 overlay，不增加文档流高度，因此**不会推开下面的行**
- `position:absolute` 或 `overflow:hidden` 的父容器可能裁剪内容

**实际效果：**
- ✅ 红色背景可以显示
- ❌ 文本被父容器裁剪不可见（在当前行的边界内）
- ❌ 不能推开下面的行

**结论：此方案无法实现「删除行文本显示并推开其他行」的效果。**

### 方案 C：`before` decoration 仅显示背景色（降级方案）

如果不需要显示删除行文本，只需要：
- 已添加行：绿色背景（`addedLineDecoration`，当前已工作）
- 已删除行：在锚点行上方用红色背景标记（视觉上不显示原始文本）

这是当前的 fallback，但用户体验较差。

### 方案 D：hack `_textEditor._codeEditor`（极端 tricky 方案）

VSCode 扩展中 `TextEditor` 实际上包装了一个 `ICodeEditor`，理论上可以通过访问私有属性拿到：

```typescript
const codeEditor = (editor as any)._codeEditor ?? (editor as any)._textEditor?._codeEditor;
if (codeEditor?.changeViewZones) {
  codeEditor.changeViewZones((accessor: any) => {
    const div = document.createElement('div');
    div.innerHTML = '...';
    accessor.addZone({ afterLineNumber: n, heightInLines: h, domNode: div });
  });
}
```

**风险极高：**
- 私有属性名可能在 VSCode 版本间变化
- 在扩展 host 进程中无法访问 DOM（扩展运行在独立的 Node.js 进程中）
- `document.createElement` 在扩展进程中不存在
- **此方案实际上不可行**

---

## 四、推荐实现方案

**使用方案 A（`createWebviewTextEditorInset`）。**

### 实现设计

每个 pending hunk 的每组连续删除行创建一个 inset：

```
hunk:
  删除了 3 行（行 5、6、7）
  新增了 2 行（行 5、6）

→ 在新行 5（0-based: 4）之后 afterLine=4 创建一个高度为 3 的 inset
→ inset 内容：显示原始的 3 行内容，红色背景
```

Webview HTML 使用 VSCode CSS 变量保持主题一致：
```html
<html>
<head>
<style>
  body {
    margin: 0; padding: 0;
    background: var(--vscode-diffEditor-removedLineBackground);
    color: var(--vscode-diffEditor-removedTextForeground);
    font-family: var(--vscode-editor-font-family);
    font-size: var(--vscode-editor-font-size);
    line-height: var(--vscode-editor-line-height);
    overflow: hidden;
  }
  .line { white-space: pre; padding-left: 4px; }
</style>
</head>
<body>
  <div class="line">- original line 1 content</div>
  <div class="line">- original line 2 content</div>
  <div class="line">- original line 3 content</div>
</body>
</html>
```

### 资源管理

- 状态改变时（accept/discard/refresh）销毁旧 inset，创建新 inset
- `dispose()` 时销毁所有 inset
- 每个 editor+hunk 组合对应一个 inset

---

## 五、需要解决的技术细节

1. **inset 行号**：`createWebviewTextEditorInset(editor, line, height)` 中 `line` 是 0-based 的锚点行（inset 显示在该行之后）。对于删除行，应插在新版本中对应位置（新增行之前）。

2. **高度计算**：`height` 是行数（整数），VSCode 自动换算为像素。

3. **CSP 和样式**：Webview 默认有 CSP 限制。可以用 `enableScripts: false` 避免脚本，样式直接内联。CSS 变量（`--vscode-*`）在 webview 中可用（VSCode 会注入这些变量）。

4. **性能**：如果一个文件有很多 hunk，同时存在多个 inset。测试验证性能是否可接受。

---

## 六、参考资料

- VSCode proposed API: `vscode.proposed.editorInsets.d.ts`
  `window.createWebviewTextEditorInset(editor, line, height, options?)`
- GitHub issue: https://github.com/microsoft/vscode/issues/85682
- workbench.desktop.main.js 关键类：
  - `byt`（`inlineDiffDeletedCodeMargin`）：Diff Editor 删除行 ViewZone 管理
  - `adi`（`AdditionalLinesWidget`）：InlineCompletion 附加行 ViewZone 渲染
  - `APe`：Chat Editing diff 渲染，创建 `chat-editing-original-zone` ViewZone
  - `Ikt`：InlineEdit 的 original lines 渲染（使用 decoration，非 ViewZone）
  - `nR`：内部行渲染函数（tokenization → HTML）
  - `Wzo`：GhostText 行渲染函数（simpler，用于 inline completion）
