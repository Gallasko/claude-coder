import * as vscode from 'vscode';
import { ChatHistoryStore } from '../agent/chatHistoryStore';
import { displayName, formatUsd } from '../agent/models';

/** Singleton webview panel listing every recorded chat (cost, length, duration). */
export class ChatHistoryPanel {
  private static current: ChatHistoryPanel | undefined;
  private readonly panel: vscode.WebviewPanel;

  static show(store: ChatHistoryStore, currentProjectPath: string | undefined): void {
    if (ChatHistoryPanel.current) {
      ChatHistoryPanel.current.panel.reveal(vscode.ViewColumn.Active);
      ChatHistoryPanel.current.render();
      return;
    }
    ChatHistoryPanel.current = new ChatHistoryPanel(store, currentProjectPath);
  }

  private constructor(
    private readonly store: ChatHistoryStore,
    private readonly currentProjectPath: string | undefined
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'claudeCoder.chatHistory',
      'Claude Coder: Chat History',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.panel.onDidDispose(() => {
      ChatHistoryPanel.current = undefined;
    });
    this.panel.webview.onDidReceiveMessage((msg) => {
      if (msg?.type === 'reset') {
        this.store.reset();
        this.render();
      }
    });
    this.render();
  }

  private render(): void {
    this.panel.webview.html = this.html();
  }

  private html(): string {
    const chats = this.store.all();
    const nonce = Math.random().toString(36).slice(2);

    const totalCost = chats.reduce((sum, c) => sum + c.costUsd, 0);
    const totalMessages = chats.reduce((sum, c) => sum + c.promptCount, 0);
    const totalChars = chats.reduce((sum, c) => sum + c.userChars + c.assistantChars, 0);

    const rows = chats
      .map((c) => {
        const durationMs = Math.max(0, c.updatedAt - c.createdAt);
        const isCurrent = this.currentProjectPath && c.projectPath === this.currentProjectPath;
        return `<tr class="${isCurrent ? 'current' : ''}">
          <td>${new Date(c.createdAt).toLocaleString()}</td>
          <td>${esc(c.projectName)}</td>
          <td>${esc(c.title || '(untitled)')}</td>
          <td>${esc(displayName(c.model))}${c.backend === 'subscription' ? ' (plan)' : ''}</td>
          <td>${c.promptCount}</td>
          <td>${tok(c.userChars + c.assistantChars)}</td>
          <td>${tok(c.inputTokens + c.outputTokens)}</td>
          <td>${formatUsd(c.costUsd)}</td>
          <td>${duration(durationMs)}</td>
        </tr>`;
      })
      .join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 16px; }
    .totals { display: flex; gap: 24px; flex-wrap: wrap; margin-bottom: 16px; }
    .stat { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border); border-radius: 6px; padding: 10px 16px; }
    .stat .label { font-size: 11px; opacity: 0.7; text-transform: uppercase; }
    .stat .value { font-size: 20px; font-weight: 600; }
    table { border-collapse: collapse; width: 100%; margin-bottom: 16px; }
    th, td { text-align: left; padding: 4px 10px; border-bottom: 1px solid var(--vscode-widget-border); font-size: 12px; }
    th { opacity: 0.7; font-weight: 500; }
    tr.current { background: var(--vscode-list-inactiveSelectionBackground); }
    button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    .empty { opacity: 0.6; font-style: italic; }
  </style>
</head>
<body>
  <div class="totals">
    <div class="stat"><div class="label">Chats</div><div class="value">${chats.length}</div></div>
    <div class="stat"><div class="label">Messages</div><div class="value">${totalMessages}</div></div>
    <div class="stat"><div class="label">Total length</div><div class="value">${tok(totalChars)} chars</div></div>
    <div class="stat"><div class="label">Total cost</div><div class="value">${formatUsd(totalCost)}</div></div>
  </div>

  ${
    chats.length
      ? `<table><tr><th>Started</th><th>Project</th><th>Title</th><th>Model</th><th>Msgs</th><th>Length</th><th>Tokens</th><th>Cost</th><th>Duration</th></tr>${rows}</table>`
      : '<p class="empty">No chats recorded yet.</p>'
  }

  <button id="reset">Clear chat history</button>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.getElementById('reset').addEventListener('click', () => {
      if (confirm('Clear all recorded chat history? This cannot be undone.')) {
        vscode.postMessage({ type: 'reset' });
      }
    });
  </script>
</body>
</html>`;
  }
}

function tok(n: number): string {
  return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
}

function duration(ms: number): string {
  const mins = Math.round(ms / 60000);
  if (mins < 1) {
    return '<1m';
  }
  if (mins < 60) {
    return `${mins}m`;
  }
  return `${(mins / 60).toFixed(1)}h`;
}

function esc(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
}
