import * as vscode from 'vscode';
import { UsageStore } from '../agent/usageStore';
import { displayName, formatUsd, PRICING } from '../agent/models';

/**
 * Fixed categorical slots (validated for CVD-safe adjacent separation in both
 * light and dark VS Code themes). Assigned in this order, never cycled per
 * filter — known models first (matching PRICING key order), then any unknown
 * model IDs by first appearance.
 */
const MODEL_COLOR_SLOTS: { light: string; dark: string }[] = [
  { light: '#2a78d6', dark: '#3987e5' }, // blue
  { light: '#1baf7a', dark: '#199e70' }, // aqua
  { light: '#eda100', dark: '#c98500' }, // yellow
  { light: '#008300', dark: '#008300' }, // green
  { light: '#4a3aa7', dark: '#9085e9' }, // violet
  { light: '#e34948', dark: '#e66767' }, // red
  { light: '#e87ba4', dark: '#d55181' }, // magenta
  { light: '#eb6834', dark: '#d95926' }, // orange
];

/** Assigns each model a stable color slot: known models in PRICING order, then extras by first appearance. */
function modelColorOrder(models: string[]): string[] {
  const known = Object.keys(PRICING);
  const extras = models.filter((m) => !known.includes(m));
  return [...known, ...extras];
}

/** Singleton webview panel showing persisted usage history + billing estimate. */
export class UsagePanel {
  private static current: UsagePanel | undefined;
  private readonly panel: vscode.WebviewPanel;

  static show(store: UsageStore): void {
    if (UsagePanel.current) {
      UsagePanel.current.panel.reveal(vscode.ViewColumn.Active);
      UsagePanel.current.render();
      return;
    }
    UsagePanel.current = new UsagePanel(store);
  }

  private constructor(private readonly store: UsageStore) {
    this.panel = vscode.window.createWebviewPanel(
      'claudeCoder.usage',
      'Claude Coder: Usage History',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.panel.onDidDispose(() => {
      UsagePanel.current = undefined;
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
    const s = this.store.summary();
    const nonce = Math.random().toString(36).slice(2);
    const totalCost = s.creditsCostUsd + s.subscriptionEstValueUsd;
    const graphData = {
      hour: this.store.buckets('hour'),
      day: this.store.buckets('day'),
      week: this.store.buckets('week'),
    };

    const modelOrder = modelColorOrder(s.byModel.map((m) => m.key));
    const modelColors: Record<string, { light: string; dark: string }> = {};
    modelOrder.forEach((m, i) => {
      modelColors[m] = MODEL_COLOR_SLOTS[i % MODEL_COLOR_SLOTS.length];
    });

    const legendRows = s.byModel
      .map(
        (m) =>
          `<div class="legend-item"><span class="legend-swatch" style="--legend-light:${
            modelColors[m.key].light
          };--legend-dark:${modelColors[m.key].dark}"></span>${esc(displayName(m.key))}</div>`
      )
      .join('');

    const dayRows = s.byDay
      .map(
        (d) =>
          `<tr><td>${d.key}</td><td>${d.requests}</td><td>${tok(d.inputTokens)}</td><td>${tok(
            d.outputTokens
          )}</td><td>${formatUsd(d.costUsd)}</td></tr>`
      )
      .join('');

    const modelRows = s.byModel
      .map(
        (m) =>
          `<tr><td>${esc(displayName(m.key))}</td><td>${m.requests}</td><td>${tok(m.inputTokens)}</td><td>${tok(
            m.outputTokens
          )}</td><td>${tok(m.cacheReadTokens)}</td><td>${formatUsd(m.costUsd)}</td></tr>`
      )
      .join('');

    const recentRows = this.store
      .recent(200)
      .map(
        (r) =>
          `<tr><td>${new Date(r.timestamp).toLocaleString()}</td><td>${esc(displayName(r.model))}</td><td>${
            r.kind
          }</td><td>${r.backend}</td><td>${tok(r.inputTokens)}</td><td>${tok(r.outputTokens)}</td><td>${formatUsd(
            r.costUsd
          )}</td></tr>`
      )
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
    h2 { margin-top: 24px; }
    .totals { display: flex; gap: 24px; flex-wrap: wrap; margin-bottom: 8px; }
    .stat { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border); border-radius: 6px; padding: 10px 16px; }
    .stat .label { font-size: 11px; opacity: 0.7; text-transform: uppercase; }
    .stat .value { font-size: 20px; font-weight: 600; }
    table { border-collapse: collapse; width: 100%; margin-bottom: 16px; }
    th, td { text-align: left; padding: 4px 10px; border-bottom: 1px solid var(--vscode-widget-border); font-size: 12px; }
    th { opacity: 0.7; font-weight: 500; }
    button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    .empty { opacity: 0.6; font-style: italic; }
    .graph-controls { margin-bottom: 8px; }
    .graph-controls button { opacity: 0.6; margin-right: 4px; }
    .graph-controls button.active { opacity: 1; }
    .graph { display: flex; align-items: flex-end; gap: 2px; height: 140px; border-bottom: 1px solid var(--vscode-widget-border); padding: 0 4px; }
    .graph-bar { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; height: 100%; min-width: 2px; }
    .graph-bar .bar { width: 100%; display: flex; flex-direction: column-reverse; border-radius: 2px 2px 0 0; min-height: 1px; overflow: hidden; }
    .graph-bar .bar-segment { width: 100%; }
    .graph-bar .bar-segment + .bar-segment { border-top: 1px solid var(--vscode-editorWidget-background); }
    .graph-bar .bar-label { font-size: 9px; opacity: 0.7; margin-top: 4px; white-space: nowrap; }
    .legend { display: flex; flex-wrap: wrap; gap: 4px 16px; margin: 8px 0; }
    .legend-item { display: flex; align-items: center; gap: 6px; font-size: 12px; }
    .legend-swatch { display: inline-block; width: 10px; height: 10px; border-radius: 2px; background: var(--legend-light); }
    body.vscode-dark .legend-swatch, body.vscode-high-contrast .legend-swatch { background: var(--legend-dark); }
  </style>
</head>
<body>
  <div class="totals">
    <div class="stat"><div class="label">Total requests</div><div class="value">${s.totalRequests}</div></div>
    <div class="stat"><div class="label">Total tokens</div><div class="value">${tok(s.totalTokens)}</div></div>
    <div class="stat"><div class="label">API credits spent</div><div class="value">${formatUsd(s.creditsCostUsd)}</div></div>
    <div class="stat"><div class="label">Subscription est. value</div><div class="value">${formatUsd(
      s.subscriptionEstValueUsd
    )}</div></div>
    <div class="stat"><div class="label">Combined</div><div class="value">${formatUsd(totalCost)}</div></div>
  </div>

  <h2>Usage graph</h2>
  ${
    s.totalRequests
      ? `<div class="graph-controls">
           <button class="gran-btn active" data-gran="hour">Hour</button>
           <button class="gran-btn" data-gran="day">Day</button>
           <button class="gran-btn" data-gran="week">Week</button>
         </div>
         <div id="graph" class="graph"></div>
         <div class="legend">${legendRows}</div>`
      : '<p class="empty">No usage recorded yet.</p>'
  }

  <h2>By day</h2>
  ${
    s.byDay.length
      ? `<table><tr><th>Day</th><th>Requests</th><th>In</th><th>Out</th><th>Cost</th></tr>${dayRows}</table>`
      : '<p class="empty">No usage recorded yet.</p>'
  }

  <h2>By model</h2>
  ${
    s.byModel.length
      ? `<table><tr><th>Model</th><th>Requests</th><th>In</th><th>Out</th><th>Cache read</th><th>Cost</th></tr>${modelRows}</table>`
      : '<p class="empty">No usage recorded yet.</p>'
  }

  <h2>Recent requests</h2>
  ${
    this.store.all().length
      ? `<table><tr><th>Time</th><th>Model</th><th>Kind</th><th>Backend</th><th>In</th><th>Out</th><th>Cost</th></tr>${recentRows}</table>`
      : '<p class="empty">No usage recorded yet.</p>'
  }

  <button id="reset">Clear usage history</button>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.getElementById('reset').addEventListener('click', () => {
      if (confirm('Clear all recorded usage history? This cannot be undone.')) {
        vscode.postMessage({ type: 'reset' });
      }
    });

    const graphData = ${JSON.stringify(graphData)};
    const modelOrder = ${JSON.stringify(modelOrder)};
    const modelColors = ${JSON.stringify(modelColors)};

    function colorFor(model) {
      const c = modelColors[model] || modelColors[modelOrder[modelOrder.length - 1]];
      const dark = document.body.classList.contains('vscode-dark') || document.body.classList.contains('vscode-high-contrast');
      return dark ? c.dark : c.light;
    }

    function renderGraph(gran) {
      const graphEl = document.getElementById('graph');
      if (!graphEl) {
        return;
      }
      graphEl.innerHTML = '';
      const buckets = graphData[gran];
      const maxCost = Math.max(0, ...buckets.map((b) => b.costUsd));
      const maxRequests = Math.max(0, ...buckets.map((b) => b.requests));
      const useCost = maxCost > 0;
      const max = useCost ? maxCost : maxRequests;
      const tickEvery = Math.max(1, Math.ceil(buckets.length / 8));

      buckets.forEach((b, i) => {
        const col = document.createElement('div');
        col.className = 'graph-bar';

        const bar = document.createElement('div');
        bar.className = 'bar';
        const value = useCost ? b.costUsd : b.requests;
        const pct = max > 0 ? Math.max((value / max) * 100, value > 0 ? 2 : 0) : 0;
        bar.style.height = pct + '%';

        const slices = modelOrder
          .map((model) => b.models.find((m) => m.model === model))
          .filter(Boolean);
        (slices.length ? slices : [{ model: modelOrder[0], requests: 0, costUsd: 0 }]).forEach((slice) => {
          const seg = document.createElement('div');
          seg.className = 'bar-segment';
          const segValue = useCost ? slice.costUsd : slice.requests;
          seg.style.flexGrow = String(Math.max(segValue, slices.length ? 0.0001 : 1));
          seg.style.background = colorFor(slice.model);
          seg.title = b.key + ' - ' + slice.model + ': ' + slice.requests + ' req, $' + slice.costUsd.toFixed(4);
          bar.appendChild(seg);
        });

        col.appendChild(bar);

        const label = document.createElement('div');
        label.className = 'bar-label';
        if (i % tickEvery === 0 || i === buckets.length - 1) {
          label.textContent = b.key;
        } else {
          label.innerHTML = '&nbsp;';
        }
        col.appendChild(label);

        graphEl.appendChild(col);
      });
    }

    document.querySelectorAll('.gran-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.gran-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        renderGraph(btn.dataset.gran);
      });
    });

    renderGraph('hour');
  </script>
</body>
</html>`;
  }
}

function tok(n: number): string {
  return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
}

function esc(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
}
