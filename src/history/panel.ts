import * as vscode from 'vscode';
import { ChatHistoryStore } from '../agent/chatHistoryStore';
import { SummaryStore } from '../agent/summaryStore';
import { MessageStore } from '../agent/messageStore';
import { displayName, formatUsd } from '../agent/models';

interface DetailData {
  title: string;
  project: string;
  model: string;
  createdAt: number;
  reflections: { summary: string; highlights: string[]; createdAt: number }[];
  messages: { role: 'user' | 'assistant' | 'tool' | 'thinking'; text: string; createdAt: number }[];
}

/** Singleton webview panel listing every recorded chat (cost, length, duration, summary). */
export class ChatHistoryPanel {
  private static current: ChatHistoryPanel | undefined;
  private readonly panel: vscode.WebviewPanel;

  static show(
    store: ChatHistoryStore,
    summaries: SummaryStore,
    messages: MessageStore,
    currentProjectPath: string | undefined
  ): void {
    if (ChatHistoryPanel.current) {
      ChatHistoryPanel.current.panel.reveal(vscode.ViewColumn.Active);
      ChatHistoryPanel.current.render();
      return;
    }
    ChatHistoryPanel.current = new ChatHistoryPanel(store, summaries, messages, currentProjectPath);
  }

  private constructor(
    private readonly store: ChatHistoryStore,
    private readonly summaries: SummaryStore,
    private readonly messages: MessageStore,
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
        this.summaries.reset();
        this.messages.reset();
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

    const subscriptionCost = chats.reduce((sum, c) => sum + c.planCostUsd, 0);
    const apiCost = chats.reduce((sum, c) => sum + c.creditCostUsd, 0);
    const totalCost = subscriptionCost + apiCost;
    const totalMessages = chats.reduce((sum, c) => sum + c.promptCount, 0);
    const totalChars = chats.reduce((sum, c) => sum + c.userChars + c.assistantChars, 0);

    const rows = chats
      .map((c) => {
        const durationMs = Math.max(0, c.updatedAt - c.createdAt);
        const isCurrent = this.currentProjectPath && c.projectPath === this.currentProjectPath;
        const latest = this.summaries.latestForChat(c.id);
        return `<tr class="chat-row ${isCurrent ? 'current' : ''}" data-chat-id="${c.id}">
          <td>${new Date(c.createdAt).toLocaleString()}</td>
          <td>${esc(c.projectName)}</td>
          <td>${esc(c.title || '(untitled)')}</td>
          <td>${esc(displayName(c.model))}${c.backend === 'subscription' ? ' (plan)' : ''}</td>
          <td>${c.promptCount}</td>
          <td>${tok(c.userChars + c.assistantChars)}</td>
          <td>${tok(c.inputTokens + c.outputTokens)}</td>
          <td>${formatUsd(c.planCostUsd)}</td>
          <td>${formatUsd(c.creditCostUsd)}</td>
          <td>${duration(durationMs)}</td>
          <td class="summary" title="${esc(latest ? [latest.summary, ...latest.highlights].join('\n') : '')}">${esc(latest?.summary ?? '')}</td>
        </tr>`;
      })
      .join('');

    const details: Record<number, DetailData> = {};
    for (const c of chats) {
      details[c.id] = {
        title: c.title || '(untitled)',
        project: c.projectName,
        model: displayName(c.model),
        createdAt: c.createdAt,
        reflections: this.summaries.forChat(c.id).map((s) => ({
          summary: s.summary,
          highlights: s.highlights,
          createdAt: s.createdAt,
        })),
        messages: this.messages.forChat(c.id).map((m) => ({
          role: m.role,
          text: m.text,
          createdAt: m.createdAt,
        })),
      };
    }
    const detailsJson = JSON.stringify(details).replace(/</g, '\\u003c');

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
    td.summary { max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: 0.85; }
    th { opacity: 0.7; font-weight: 500; }
    tr.current { background: var(--vscode-list-inactiveSelectionBackground); }
    .chat-row { cursor: pointer; }
    .chat-row:hover { background: var(--vscode-list-hoverBackground); }
    button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    .empty { opacity: 0.6; font-style: italic; }
    .detail-row > td { padding: 0; }
    .detail-row .detail { margin: 4px 0; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border); border-radius: 6px; padding: 12px 16px; }
    .detail h2 { margin: 0 0 4px; font-size: 15px; }
    .detail .meta { opacity: 0.7; font-size: 12px; margin-bottom: 10px; }
    .detail .reflection { border-top: 1px solid var(--vscode-widget-border); padding: 8px 0; }
    .detail .reflection:first-of-type { border-top: none; }
    .detail .reflection .when { opacity: 0.6; font-size: 11px; }
    .detail ul { margin: 4px 0 0; padding-left: 18px; }
    .detail h3 { margin: 14px 0 6px; font-size: 12px; text-transform: uppercase; opacity: 0.7; }
    .detail .transcript { max-height: 420px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; }
    .detail .msg { border-radius: 6px; padding: 6px 10px; max-width: 90%; white-space: pre-wrap; font-size: 12px; }
    .detail .msg .when { opacity: 0.6; font-size: 10px; margin-bottom: 2px; }
    .detail .msg.user { align-self: flex-end; background: var(--vscode-list-inactiveSelectionBackground); }
    .detail .msg.assistant { align-self: flex-start; background: var(--vscode-editor-inactiveSelectionBackground, var(--vscode-list-hoverBackground)); }
    .detail .msg.tool { align-self: stretch; font-family: var(--vscode-editor-font-family, monospace); opacity: 0.8; background: var(--vscode-textBlockQuote-background); }
    .detail .msg.thinking { align-self: stretch; font-style: italic; opacity: 0.75; }
    .detail .transcript.hide-tool .msg.tool { display: none; }
    .detail .transcript.hide-thinking .msg.thinking { display: none; }
    .transcript-controls { display: flex; gap: 16px; font-size: 11px; opacity: 0.8; margin-bottom: 6px; }
    .transcript-controls label { display: flex; align-items: center; gap: 4px; cursor: pointer; }
  </style>
</head>
<body>
  <div class="totals">
    <div class="stat"><div class="label">Chats</div><div class="value">${chats.length}</div></div>
    <div class="stat"><div class="label">Messages</div><div class="value">${totalMessages}</div></div>
    <div class="stat"><div class="label">Total length</div><div class="value">${tok(totalChars)} chars</div></div>
    <div class="stat"><div class="label">Total cost</div><div class="value">${formatUsd(totalCost)}</div></div>
    <div class="stat"><div class="label">Subscription</div><div class="value">${formatUsd(subscriptionCost)}</div></div>
    <div class="stat"><div class="label">API</div><div class="value">${formatUsd(apiCost)}</div></div>
  </div>

  ${
    chats.length
      ? `<table><tr><th>Started</th><th>Project</th><th>Title</th><th>Model</th><th>Msgs</th><th>Length</th><th>Tokens</th><th>Plan cost</th><th>Credit cost</th><th>Duration</th><th>Summary</th></tr>${rows}</table>`
      : '<p class="empty">No chats recorded yet.</p>'
  }

  <button id="reset">Clear chat history</button>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const details = ${detailsJson};

    function fmt(ts) {
      return new Date(ts).toLocaleString();
    }

    function renderDetail(id) {
      const d = details[id];
      if (!d) {
        return null;
      }
      const container = document.createElement('div');
      container.className = 'detail';
      const h2 = document.createElement('h2');
      h2.textContent = d.title;
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = d.project + ' · ' + d.model + ' · started ' + fmt(d.createdAt);
      container.appendChild(h2);
      container.appendChild(meta);

      const transcriptHeading = document.createElement('h3');
      transcriptHeading.textContent = 'Transcript';
      container.appendChild(transcriptHeading);

      if (!d.messages.length) {
        const p = document.createElement('p');
        p.className = 'empty';
        p.textContent = 'No messages recorded for this chat.';
        container.appendChild(p);
      } else {
        const controls = document.createElement('div');
        controls.className = 'transcript-controls';
        const toolLabel = document.createElement('label');
        const toolCheckbox = document.createElement('input');
        toolCheckbox.type = 'checkbox';
        toolLabel.appendChild(toolCheckbox);
        toolLabel.append(' Show commands');
        const thinkLabel = document.createElement('label');
        const thinkCheckbox = document.createElement('input');
        thinkCheckbox.type = 'checkbox';
        thinkLabel.appendChild(thinkCheckbox);
        thinkLabel.append(' Show thoughts');
        controls.appendChild(toolLabel);
        controls.appendChild(thinkLabel);
        container.appendChild(controls);

        const transcript = document.createElement('div');
        transcript.className = 'transcript hide-tool hide-thinking';
        toolCheckbox.addEventListener('change', () => {
          transcript.classList.toggle('hide-tool', !toolCheckbox.checked);
        });
        thinkCheckbox.addEventListener('change', () => {
          transcript.classList.toggle('hide-thinking', !thinkCheckbox.checked);
        });
        for (const m of d.messages) {
          const div = document.createElement('div');
          div.className = 'msg ' + m.role;
          const when = document.createElement('div');
          when.className = 'when';
          const label = m.role === 'user' ? 'You' : m.role === 'assistant' ? 'Claude' : m.role === 'tool' ? 'Command' : 'Thought';
          when.textContent = label + ' · ' + fmt(m.createdAt);
          const text = document.createElement('div');
          text.textContent = m.text;
          div.appendChild(when);
          div.appendChild(text);
          transcript.appendChild(div);
        }
        container.appendChild(transcript);
      }

      const reflectionsHeading = document.createElement('h3');
      reflectionsHeading.textContent = 'AI reflections';
      container.appendChild(reflectionsHeading);

      if (!d.reflections.length) {
        const p = document.createElement('p');
        p.className = 'empty';
        p.textContent = 'No reflections recorded for this chat.';
        container.appendChild(p);
      } else {
        for (const r of d.reflections) {
          const div = document.createElement('div');
          div.className = 'reflection';
          const when = document.createElement('div');
          when.className = 'when';
          when.textContent = fmt(r.createdAt);
          const summary = document.createElement('div');
          summary.textContent = r.summary;
          div.appendChild(when);
          div.appendChild(summary);
          if (r.highlights.length) {
            const ul = document.createElement('ul');
            for (const h of r.highlights) {
              const li = document.createElement('li');
              li.textContent = h;
              ul.appendChild(li);
            }
            div.appendChild(ul);
          }
          container.appendChild(div);
        }
      }
      return container;
    }

    let openDetailRow = null;

    document.querySelectorAll('.chat-row').forEach((row) => {
      row.addEventListener('click', () => {
        if (openDetailRow && openDetailRow.previousElementSibling === row) {
          openDetailRow.remove();
          openDetailRow = null;
          return;
        }
        if (openDetailRow) {
          openDetailRow.remove();
          openDetailRow = null;
        }
        const container = renderDetail(row.dataset.chatId);
        if (!container) {
          return;
        }
        const tr = document.createElement('tr');
        tr.className = 'detail-row';
        const td = document.createElement('td');
        td.colSpan = 11;
        td.appendChild(container);
        tr.appendChild(td);
        row.insertAdjacentElement('afterend', tr);
        openDetailRow = tr;
        tr.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
    });

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
