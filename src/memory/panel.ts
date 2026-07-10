import * as vscode from 'vscode';

export interface MemoryNoteView {
  id: number;
  text: string;
  createdAt: number;
}

export interface MemoryChangeView {
  path: string;
  tool: string;
  taskSummary: string;
  timestamp: number;
}

export interface MemoryFileSummaryView {
  path: string;
  summary: string;
  status: string;
  summarizedAt: number;
  detail: 'concise' | 'detailed';
  readCount: number;
}

export interface TaskMemoryView {
  id: number;
  title: string;
  summary: string;
  files: string[];
  staleFiles: string[];
  chatIds: number[];
  createdAt: number;
  updatedAt: number;
}

export interface MemoryPanelData {
  notes: MemoryNoteView[];
  changes: MemoryChangeView[];
  fileSummaries: MemoryFileSummaryView[];
  taskMemories: TaskMemoryView[];
  root: string | undefined;
}

/** Singleton webview panel showing project memory: task memories, notes, edit history, and the file-read cache. */
export class MemoryPanel {
  private static current: MemoryPanel | undefined;
  private static onReload: ((path: string) => void) | undefined;
  private readonly panel: vscode.WebviewPanel;

  static show(data: MemoryPanelData, onReload?: (path: string) => void): void {
    MemoryPanel.onReload = onReload;
    if (MemoryPanel.current) {
      MemoryPanel.current.panel.reveal(vscode.ViewColumn.Active);
      MemoryPanel.current.render(data);
      return;
    }
    MemoryPanel.current = new MemoryPanel(data);
  }

  private constructor(private data: MemoryPanelData) {
    this.panel = vscode.window.createWebviewPanel(
      'claudeCoder.memory',
      'Claude Coder: Project Memory',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.panel.onDidDispose(() => {
      MemoryPanel.current = undefined;
    });
    this.panel.webview.onDidReceiveMessage((msg) => {
      if (msg?.type === 'reload' && typeof msg.path === 'string') {
        MemoryPanel.onReload?.(msg.path);
      }
    });
    this.render(data);
  }

  static notice(text: string): void {
    void MemoryPanel.current?.panel.webview.postMessage({ type: 'notice', text });
  }

  private render(data: MemoryPanelData): void {
    this.data = data;
    this.panel.webview.html = this.html();
  }

  private html(): string {
    const { notes, changes, fileSummaries, taskMemories, root } = this.data;

    const taskMemoryCards = taskMemories
      .map((m) => {
        const staleSet = new Set(m.staleFiles);
        const fileTags = m.files
          .map((f) => `<code class="${staleSet.has(f) ? 'stale' : ''}">${esc(f)}</code>`)
          .join(' ');
        return `<div class="memory-card">
          <div class="memory-card-header">
            <h3>${esc(m.title || '(untitled task)')}</h3>
            <span class="meta">updated ${new Date(m.updatedAt).toLocaleString()}</span>
          </div>
          <div class="memory-summary">${esc(m.summary).replace(/\n/g, '<br>')}</div>
          ${fileTags ? `<div class="memory-files"><strong>Files:</strong> ${fileTags}</div>` : ''}
          ${m.staleFiles.length ? `<div class="stale-note">${m.staleFiles.length} file(s) changed on disk since this memory was last refreshed</div>` : ''}
          <div class="meta">chats: ${m.chatIds.join(', ')} · created ${new Date(m.createdAt).toLocaleString()}</div>
        </div>`;
      })
      .join('');

    const noteLines = notes
      .map((n) => `<li><span class="meta">${new Date(n.createdAt).toLocaleString()}</span> ${esc(n.text)}</li>`)
      .join('');
    const changeLines = changes
      .map(
        (c) =>
          `<li><span class="meta">${new Date(c.timestamp).toLocaleString()} · ${esc(c.tool)}</span> ${esc(c.path)} <span class="meta">(${esc(c.taskSummary || 'unknown task')})</span></li>`
      )
      .join('');
    const summaryLines = fileSummaries
      .map(
        (s) =>
          `<li><span class="tag tag-${esc(s.status)}">${esc(s.status)}</span>${
            s.detail === 'detailed' ? '<span class="tag tag-detail">detailed</span>' : ''
          } ${esc(s.path)} — ${esc(s.summary)} <span class="meta">(read ${s.readCount}×)</span> <button class="reload" data-path="${esc(s.path)}">Reload</button></li>`
      )
      .join('');

    const nonce = String(Date.now()) + Math.floor(Math.random() * 1e9);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 16px; }
    h2 { font-size: 13px; text-transform: uppercase; opacity: 0.7; margin: 24px 0 8px; }
    h2:first-child { margin-top: 0; }
    .subtitle { opacity: 0.6; font-size: 12px; margin-top: -4px; }
    .empty { opacity: 0.6; font-style: italic; font-size: 12px; }
    ul { list-style: none; margin: 0; padding: 0; }
    li { padding: 4px 0; border-bottom: 1px solid var(--vscode-widget-border); font-size: 12px; }
    li:last-child { border-bottom: none; }
    .meta { opacity: 0.6; font-size: 11px; }
    .tag { display: inline-block; border-radius: 3px; padding: 0 5px; font-size: 10px; text-transform: uppercase; margin-right: 4px; }
    .tag-fresh { background: var(--vscode-testing-iconPassed, #2a8); color: #fff; }
    .tag-stale { background: var(--vscode-testing-iconQueued, #c90); color: #fff; }
    .tag-unknown { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
    .tag-detail { background: var(--vscode-charts-purple, #8957e5); color: #fff; }
    .memory-card { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border); border-radius: 6px; padding: 10px 14px; margin-bottom: 10px; }
    .memory-card-header { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
    .memory-card-header h3 { margin: 0; font-size: 13px; }
    .memory-summary { font-size: 12px; margin: 6px 0; white-space: pre-wrap; }
    .memory-files { font-size: 11px; margin-top: 6px; }
    .memory-files code { background: var(--vscode-textCodeBlock-background); border-radius: 3px; padding: 1px 4px; margin-right: 4px; display: inline-block; margin-bottom: 2px; }
    .memory-files code.stale { outline: 1px solid var(--vscode-testing-iconQueued, #c90); }
    .stale-note { font-size: 11px; color: var(--vscode-testing-iconQueued, #c90); margin-top: 4px; }
    button.reload { font-size: 10px; margin-left: 6px; padding: 0 6px; cursor: pointer; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; border-radius: 3px; }
    button.reload:hover { background: var(--vscode-button-secondaryHoverBackground); }
    button.reload:disabled { opacity: 0.6; cursor: default; }
    #toast { position: fixed; bottom: 16px; right: 16px; background: var(--vscode-notifications-background, #333); color: var(--vscode-notifications-foreground, #fff); border: 1px solid var(--vscode-widget-border); border-radius: 4px; padding: 8px 12px; font-size: 12px; opacity: 0; transform: translateY(8px); transition: opacity 0.15s ease, transform 0.15s ease; pointer-events: none; }
    #toast.show { opacity: 1; transform: translateY(0); }
  </style>
</head>
<body>
  <h2>Task memories</h2>
  <div class="subtitle">${root ? esc(root) : 'no workspace open'} — auto-built as tasks touch files, refreshed every few prompts</div>
  ${taskMemories.length ? taskMemoryCards : '<p class="empty">No task memories recorded yet.</p>'}

  <h2>Notes</h2>
  ${notes.length ? `<ul>${noteLines}</ul>` : '<p class="empty">No notes. Add one with "Claude Coder: Add Memory Note".</p>'}

  <h2>Recent changes</h2>
  ${changes.length ? `<ul>${changeLines}</ul>` : '<p class="empty">No changes recorded.</p>'}

  <h2>File summaries (read cache)</h2>
  ${fileSummaries.length ? `<ul>${summaryLines}</ul>` : '<p class="empty">No cached file summaries.</p>'}

  <div id="toast"></div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('button.reload');
      if (btn) {
        btn.disabled = true;
        btn.textContent = 'Reloading…';
        vscode.postMessage({ type: 'reload', path: btn.dataset.path });
      }
    });
    let toastTimer;
    window.addEventListener('message', (e) => {
      if (e.data?.type === 'notice') {
        const toast = document.getElementById('toast');
        toast.textContent = e.data.text;
        toast.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toast.classList.remove('show'), 2500);
      }
    });
  </script>
</body>
</html>`;
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'));
}
