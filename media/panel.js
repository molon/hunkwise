// @ts-check
/** @type {{ postMessage: (msg: unknown) => void, getState: () => unknown, setState: (state: unknown) => void }} */
const vscode = /** @type {any} */ (globalThis).acquireVsCodeApi();
const app = document.getElementById('app');

/** @type {{ enabled: boolean, ignorePatterns: string[], respectGitignore: boolean, totalFiles: number, totalAdded: number, totalRemoved: number, files: any[] } | null} */
let currentState = null;
/** @type {Set<string>} */
const expandedFiles = new Set();
/** @type {'main' | 'settings'} */
let view = 'main';
/** Track whether we are currently in loading state, so the next update can fade in */
let isLoading = false;

// SVG icon: two offset blocks (red=removed, green=added) representing a hunk diff
const ICON_SVG = `<svg width="52" height="52" viewBox="0 0 52 52" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect x="4" y="6" width="26" height="8" rx="2" fill="#f85149" opacity="0.85"/>
  <rect x="4" y="17" width="18" height="8" rx="2" fill="#f85149" opacity="0.5"/>
  <rect x="22" y="28" width="26" height="8" rx="2" fill="#3fb950" opacity="0.85"/>
  <rect x="30" y="39" width="18" height="8" rx="2" fill="#3fb950" opacity="0.5"/>
</svg>`;

const SPLASH_QUOTES = [
  "Every change deserves a witness.",
  "Ship it. But know what you shipped.",
  "The diff is the truth.",
  "A hunk a day keeps the mystery away.",
  "Code doesn't lie. Commit messages do.",
  "Review small. Sleep well.",
  "Not all who wander are lost. Not all diffs are intentional.",
  "The only good surprise is no surprise.",
  "Blame is a feature, not a bug.",
  "Change is inevitable. Reviewing it is optional — but wise.",
  "If it compiles, it's done. If it diffs, it's hunkwise.",
  "Even Linus reviews his own patches.",
  "In the beginning was the diff, and the diff was good.",
  "You can't unsee a hunk once you've seen it.",
  "Refactoring: the art of changing everything and nothing.",
  "The best code review is the one you do before asking for one.",
  "A bug is just a feature you haven't documented yet.",
  "git blame: because someone has to be responsible.",
  "Move fast, break things, then review the diff.",
  "Every deleted line is a victory.",
  "There are two hard problems: naming things, cache invalidation, and off-by-one errors.",
  "The code you wrote six months ago was written by a stranger.",
  "If it's not reviewed, it's not real.",
  "Complexity is easy to add, hard to remove.",
  "Works on my machine — have you tried diffing it?",
  "The first rule of hunk club: you always review hunk club.",
  "Ship less. Review more. Sleep better.",
  "Fear leads to unreviewed code. Unreviewed code leads to production incidents.",
  "A diff a day keeps the rollback away.",
  "Your future self will thank you. Or blame you. It depends on the diff.",
];

/** Cached quote so it doesn't change on every render */
let cachedQuote = '';
/** Timestamp of when the cached quote was set */
let cachedQuoteTime = 0;
/** Minimum interval (ms) before picking a new quote */
const QUOTE_MIN_INTERVAL = 30000; // 30 seconds

/** @returns {string} */
function randomQuote() {
  const now = Date.now();
  if (!cachedQuote || (now - cachedQuoteTime) >= QUOTE_MIN_INTERVAL) {
    cachedQuote = SPLASH_QUOTES[Math.floor(Math.random() * SPLASH_QUOTES.length)];
    cachedQuoteTime = now;
  }
  return cachedQuote;
}

/**
 * @param {string} tag
 * @param {string} [cls]
 * @param {string} [text]
 * @returns {HTMLElement}
 */
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/**
 * @param {string} label
 * @param {string} cls
 * @param {() => void} onClick
 * @returns {HTMLButtonElement}
 */
function btn(label, cls, onClick) {
  const b = /** @type {HTMLButtonElement} */ (document.createElement('button'));
  b.textContent = label;
  if (cls) b.className = cls;
  b.addEventListener('click', e => { e.stopPropagation(); onClick(); });
  return b;
}


/** @param {HTMLElement} parent */
function appendIcon(parent) {
  const wrap = el('div', 'splash-icon');
  wrap.innerHTML = ICON_SVG;
  parent.appendChild(wrap);
}

/**
 * @param {{ enabled: boolean, ignorePatterns: string[], respectGitignore: boolean, totalFiles: number, totalAdded: number, totalRemoved: number, files: any[] }} state
 */
function render(state) {
  if (!app) return;
  app.innerHTML = '';

  if (!state.enabled) {
    renderSetupScreen();
    return;
  }

  if (view === 'settings') {
    renderSettingsScreen(state);
    return;
  }

  if (state.totalFiles === 0) {
    renderIdleScreen();
    return;
  }

  renderReviewScreen(state);
}

function renderSetupScreen() {
  if (!app) return;
  const screen = el('div', 'splash-screen');
  appendIcon(screen);
  screen.appendChild(el('p', 'splash-tagline', randomQuote()));
  screen.appendChild(btn('Enable for this project', 'btn-primary', () => {
    vscode.postMessage({ command: 'enable' });
  }));
  app.appendChild(screen);
}

function renderIdleScreen() {
  if (!app) return;
  const screen = el('div', 'splash-screen');
  appendIcon(screen);
  screen.appendChild(el('p', 'splash-tagline', randomQuote()));
  screen.appendChild(btn('Disable', 'btn-disable', () => {
    vscode.postMessage({ command: 'disable' });
  }));
  app.appendChild(screen);
}

/**
 * @param {{ ignorePatterns: string[], respectGitignore: boolean }} state
 */
function renderSettingsScreen(state) {
  if (!app) return;

  // Header with back button
  const header = el('div', 'settings-header');
  const backBtn = btn('← Back', 'btn-back', () => {
    view = 'main';
    if (currentState) render(currentState);
  });
  header.appendChild(backBtn);
  header.appendChild(el('span', 'settings-header-title', 'Settings'));
  app.appendChild(header);

  const body = el('div', 'settings-body');

  // ── Respect .gitignore ──
  const gitignoreSection = el('div', 'settings-section');
  gitignoreSection.appendChild(el('div', 'settings-section-title', 'Git Integration'));

  const checkRow = el('label', 'settings-check-row');
  const checkbox = /** @type {HTMLInputElement} */ (document.createElement('input'));
  checkbox.type = 'checkbox';
  checkbox.className = 'settings-checkbox';
  checkbox.checked = state.respectGitignore;
  checkbox.addEventListener('change', () => {
    vscode.postMessage({ command: 'setRespectGitignore', value: checkbox.checked });
  });
  const checkLabel = el('span', 'settings-check-label', 'Respect .gitignore');
  const checkDesc = el('span', 'settings-check-desc', 'Skip files already ignored by your project\'s .gitignore');
  checkRow.appendChild(checkbox);
  const checkText = el('div', 'settings-check-text');
  checkText.appendChild(checkLabel);
  checkText.appendChild(checkDesc);
  checkRow.appendChild(checkText);
  gitignoreSection.appendChild(checkRow);
  body.appendChild(gitignoreSection);

  // ── Exclude Patterns ──
  const patternSection = el('div', 'settings-section');
  patternSection.appendChild(el('div', 'settings-section-title', 'Exclude Patterns'));
  patternSection.appendChild(el('p', 'settings-section-desc', 'Glob patterns to exclude from change tracking (relative to workspace root).'));

  const patternList = el('div', 'pattern-list');

  // Protected system rule — always enforced, cannot be removed
  const protectedRow = el('div', 'pattern-row-inner pattern-row-protected');
  protectedRow.appendChild(el('span', 'pattern-text', '.vscode/hunkwise'));
  protectedRow.appendChild(el('span', 'pattern-lock', '🔒'));
  patternList.appendChild(protectedRow);

  for (const folder of state.ignorePatterns) {
    const inner = el('div', 'pattern-row-inner');
    const folderEl = el('span', 'pattern-text', folder);
    const delBtn = el('button', 'pattern-del', '');
    delBtn.title = 'Remove';
    delBtn.addEventListener('click', e => {
      e.stopPropagation();
      const newFolders = state.ignorePatterns.filter(f => f !== folder);
      vscode.postMessage({ command: 'setIgnorePatterns', folders: newFolders });
    });
    inner.appendChild(folderEl);
    inner.appendChild(delBtn);
    patternList.appendChild(inner);
  }

  const addRow = el('div', 'pattern-add-row');
  const addInput = /** @type {HTMLInputElement} */ (document.createElement('input'));
  addInput.type = 'text';
  addInput.className = 'pattern-input';
  addInput.placeholder = 'e.g. node_modules';
  const addBtn = el('button', 'pattern-add-btn', 'Add');
  addBtn.addEventListener('click', e => {
    e.stopPropagation();
    const val = addInput.value.trim();
    if (val && !state.ignorePatterns.includes(val)) {
      vscode.postMessage({ command: 'setIgnorePatterns', folders: [...state.ignorePatterns, val] });
    }
    addInput.value = '';
  });
  addInput.addEventListener('keydown', e => { if (e.key === 'Enter') addBtn.click(); });
  addRow.appendChild(addInput);
  addRow.appendChild(addBtn);
  patternList.appendChild(addRow);
  patternSection.appendChild(patternList);
  body.appendChild(patternSection);

  app.appendChild(body);
}

/**
 * File extension → background color for the badge
 * @param {string} fileName
 * @returns {string}
 */
function extColor(fileName) {
  const ext = (fileName.split('.').pop() ?? '').toLowerCase();
  /** @type {Record<string,string>} */
  const m = {
    ts:'#3178c6',tsx:'#3178c6',
    js:'#d4a017',jsx:'#d4a017',mjs:'#d4a017',
    json:'#d4a017',
    py:'#3572A5',
    go:'#00add8',
    rs:'#dea584',
    java:'#b07219',kt:'#a97bff',
    rb:'#cc342d',php:'#4f5d95',cs:'#178600',
    cpp:'#f34b7d',c:'#a8a8a8',h:'#a8a8a8',
    html:'#e34c26',htm:'#e34c26',
    css:'#563d7c',scss:'#c6538c',less:'#1d365d',
    md:'#4a90d9',mdx:'#4a90d9',
    yaml:'#cb171e',yml:'#cb171e',toml:'#9c4221',
    sh:'#89e051',bash:'#89e051',
    swift:'#F05138',vue:'#41b883',svelte:'#ff3e00',dart:'#00B4AB',
  };
  return m[ext] ?? '#6e7681';
}

/**
 * Create a small colored badge showing the file extension abbreviation
 * @param {string} fileName
 * @returns {HTMLElement}
 */
function fileIconBadge(fileName) {
  const ext = (fileName.split('.').pop() ?? '').toLowerCase();
  const abbr = ext.length <= 3 ? ext.toUpperCase() : ext.slice(0,3).toUpperCase();
  const badge = el('span', 'file-badge', abbr);
  badge.style.background = extColor(fileName);
  return badge;
}

/**
 * @param {{ enabled: boolean, ignorePatterns: string[], totalFiles: number, totalAdded: number, totalRemoved: number, files: any[] }} state
 */
function renderReviewScreen(state) {
  if (!app) return;

  // Summary header
  const header = el('div', 'review-header');
  const summary = el('div', 'review-summary');
  summary.appendChild(document.createTextNode(`${state.totalFiles} file${state.totalFiles > 1 ? 's' : ''} `));
  summary.appendChild(el('span', 'stat-added', `+${state.totalAdded}`));
  summary.appendChild(document.createTextNode(' '));
  summary.appendChild(el('span', 'stat-removed', `-${state.totalRemoved}`));
  const actions = el('div', 'review-actions');
  actions.appendChild(btn('✓ Accept', 'btn-review-accept', () => vscode.postMessage({ command: 'acceptAll' })));
  actions.appendChild(btn('↺ Discard', 'btn-review-discard', () => vscode.postMessage({ command: 'discardAll' })));
  header.appendChild(summary);
  header.appendChild(actions);
  app.appendChild(header);

  for (const file of state.files) {
    app.appendChild(renderFileGroup(file));
  }
}

/**
 * @param {{ filePath: string, fileName: string, dirName: string, addedLines: number, removedLines: number, pendingCount: number, isNew: boolean, isDeleted: boolean, hunks: any[] }} file
 */
function renderFileGroup(file) {
  const isSpecial = file.isNew || file.isDeleted;
  const isExpanded = !isSpecial && expandedFiles.has(file.filePath);
  const group = el('div', 'file-group');

  const fileRow = el('div', 'file-row');
  fileRow.addEventListener('click', () => {
    if (isSpecial) {
      if (file.isDeleted) {
        vscode.postMessage({ command: 'openDeletedDiff', filePath: file.filePath });
      } else {
        vscode.postMessage({ command: 'openFile', filePath: file.filePath });
      }
      return;
    }
    if (isExpanded) {
      expandedFiles.delete(file.filePath);
    } else {
      expandedFiles.add(file.filePath);
      if (file.hunks.length > 0) {
        vscode.postMessage({ command: 'jumpToHunk', filePath: file.filePath, hunkId: file.hunks[0].id });
      }
    }
    if (currentState) render(currentState);
  });

  const chevron = isSpecial ? el('span', 'file-chevron', '') : el('span', 'file-chevron', isExpanded ? '▼' : '▶');
  const fileIcon = fileIconBadge(file.fileName);
  const name = el('span', 'file-name', file.fileName);
  const badge = file.isNew ? el('span', 'file-status-badge file-status-new', 'new')
    : file.isDeleted ? el('span', 'file-status-badge file-status-deleted', 'deleted')
    : null;
  const dir = file.dirName ? el('span', 'file-dir', file.dirName) : null;

  const right = el('div', 'file-right');
  const stats = el('div', 'file-stats');
  if (file.addedLines > 0) stats.appendChild(el('span', 'stat-added', `+${file.addedLines}`));
  if (file.addedLines > 0 && file.removedLines > 0) stats.appendChild(document.createTextNode(' '));
  if (file.removedLines > 0) stats.appendChild(el('span', 'stat-removed', `-${file.removedLines}`));

  const fileActions = el('div', 'file-actions');
  const keepBtn = btn('✓', 'btn-action btn-action-keep', () => vscode.postMessage({ command: 'acceptFile', filePath: file.filePath }));
  keepBtn.title = 'Accept all changes';
  const undoBtn = btn('↺', 'btn-action btn-action-discard', () => vscode.postMessage({ command: 'discardFile', filePath: file.filePath }));
  undoBtn.title = 'Discard all changes';
  fileActions.appendChild(keepBtn);
  fileActions.appendChild(undoBtn);

  right.appendChild(stats);
  right.appendChild(fileActions);

  fileRow.appendChild(chevron);
  fileRow.appendChild(fileIcon);
  fileRow.appendChild(name);
  if (badge) fileRow.appendChild(badge);
  if (dir) fileRow.appendChild(dir);
  fileRow.appendChild(right);
  group.appendChild(fileRow);

  if (isExpanded) {
    const hunkList = el('div', 'hunk-list');
    for (const hunk of file.hunks) {
      const hunkRow = el('div', 'hunk-row');
      hunkRow.addEventListener('click', () => {
        vscode.postMessage({ command: 'jumpToHunk', filePath: hunk.filePath, hunkId: hunk.id });
      });
      const label = el('span', 'hunk-label', `@line ${hunk.newStart}`);
      const hunkStats = el('div', 'hunk-stats');
      hunkStats.appendChild(el('span', 'stat-added', `+${hunk.newLines}`));
      hunkStats.appendChild(document.createTextNode(' '));
      hunkStats.appendChild(el('span', 'stat-removed', `-${hunk.oldLines}`));
      const hunkActions = el('div', 'hunk-actions');
      const hk = btn('✓', 'btn-action btn-action-keep', () => vscode.postMessage({ command: 'acceptHunk', filePath: hunk.filePath, hunkId: hunk.id }));
      hk.title = 'Accept hunk';
      const hu = btn('↺', 'btn-action btn-action-discard', () => vscode.postMessage({ command: 'discardHunk', filePath: hunk.filePath, hunkId: hunk.id }));
      hu.title = 'Discard hunk';
      hunkActions.appendChild(hk);
      hunkActions.appendChild(hu);
      hunkRow.appendChild(label);
      hunkRow.appendChild(hunkStats);
      hunkRow.appendChild(hunkActions);
      hunkList.appendChild(hunkRow);
    }
    group.appendChild(hunkList);
  }

  return group;
}

window.addEventListener('message', event => {
  const msg = event.data;
  if (msg.type === 'loading') {
    if (!app) return;
    if (msg.loading) {
      isLoading = true;
      app.innerHTML = '';
      const screen = el('div', 'splash-screen');
      screen.appendChild(el('p', 'splash-tagline', 'Initializing…'));
      app.appendChild(screen);
    }
  } else if (msg.type === 'update') {
    currentState = msg.state;
    if (!msg.state.enabled) view = 'main';
    if (isLoading && app) {
      isLoading = false;
      // Render hidden first, then fade in
      app.classList.add('fade-hidden');
      render(msg.state);
      // Force a reflow so the transition fires
      void app.offsetWidth;
      app.classList.remove('fade-hidden');
    } else {
      render(msg.state);
    }
  } else if (msg.type === 'openSettings') {
    view = 'settings';
    if (currentState) render(currentState);
  }
});

vscode.postMessage({ command: 'ready' });
