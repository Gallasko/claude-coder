// @ts-check
// Minimal, dependency-free Markdown -> sanitized HTML renderer for the chat webview.
// Everything is HTML-escaped up front; only whitelisted tags we emit ourselves
// make it into the output, so model-authored HTML/script can never execute.
(function () {
  function escapeHtml(s) {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  const SAFE_URL = /^(https?:|mailto:|#|\/)/i;

  function safeUrl(url) {
    const trimmed = url.trim();
    return SAFE_URL.test(trimmed) ? escapeHtml(trimmed) : '#';
  }

  // Pull out `code spans` before other inline rules run, so markup inside
  // them (e.g. "**not bold**") is left alone, then splice them back in.
  function renderInline(text) {
    const codeSpans = [];
    let out = text.replace(/`([^`\n]+)`/g, (_m, code) => {
      codeSpans.push(escapeHtml(code));
      return ' CODE' + (codeSpans.length - 1) + 'CODE ';
    });

    out = escapeHtml(out);

    // Links: [text](url)
    out = out.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_m, t, u) => {
      return '<a href="' + safeUrl(u) + '" target="_blank" rel="noopener noreferrer">' + t + '</a>';
    });
    // Bare autolinks
    out = out.replace(/(^|[\s(])(https?:\/\/[^\s<]+)/g, (_m, pre, u) => {
      return pre + '<a href="' + safeUrl(u) + '" target="_blank" rel="noopener noreferrer">' + u + '</a>';
    });
    // Bold, then italics, then strikethrough
    out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
    out = out.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
    out = out.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
    out = out.replace(/(^|\W)_([^_\n]+)_(\W|$)/g, '$1<em>$2</em>$3');

    out = out.replace(/ CODE(\d+)CODE /g, (_m, i) => '<code>' + codeSpans[Number(i)] + '</code>');
    return out;
  }

  function renderTable(lines) {
    const cells = (line) =>
      line
        .trim()
        .replace(/^\||\|$/g, '')
        .split('|')
        .map((c) => c.trim());
    const header = cells(lines[0]);
    const rows = lines.slice(2).map(cells);
    let html = '<table><thead><tr>';
    header.forEach((h) => (html += '<th>' + renderInline(h) + '</th>'));
    html += '</tr></thead><tbody>';
    rows.forEach((r) => {
      html += '<tr>';
      r.forEach((c) => (html += '<td>' + renderInline(c) + '</td>'));
      html += '</tr>';
    });
    html += '</tbody></table>';
    return html;
  }

  const TABLE_SEP = /^\s*\|?(\s*:?-{2,}:?\s*\|)+\s*:?-{2,}:?\s*\|?\s*$/;
  const LIST_ITEM = /^(\s*)([-*+]|\d+\.)\s+(.*)$/;

  function renderList(items) {
    const ordered = /\d+\./.test(items[0][2]);
    const tag = ordered ? 'ol' : 'ul';
    let html = '<' + tag + '>';
    items.forEach(([, , , content]) => {
      html += '<li>' + renderInline(content) + '</li>';
    });
    html += '</' + tag + '>';
    return html;
  }

  function renderMarkdown(text) {
    if (!text) {
      return '';
    }
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    let html = '';
    let i = 0;
    let paragraph = [];

    function flushParagraph() {
      if (paragraph.length) {
        html += '<p>' + paragraph.map(renderInline).join('<br>') + '</p>';
        paragraph = [];
      }
    }

    while (i < lines.length) {
      const line = lines[i];

      // Fenced code block
      const fence = /^```(\S*)\s*$/.exec(line);
      if (fence) {
        flushParagraph();
        const lang = fence[1];
        const body = [];
        i++;
        while (i < lines.length && !/^```\s*$/.test(lines[i])) {
          body.push(lines[i]);
          i++;
        }
        i++; // skip closing fence (or EOF if unterminated mid-stream)
        const cls = lang ? ' class="language-' + escapeHtml(lang) + '"' : '';
        html += '<pre><code' + cls + '>' + escapeHtml(body.join('\n')) + '</code></pre>';
        continue;
      }

      // Blank line
      if (/^\s*$/.test(line)) {
        flushParagraph();
        i++;
        continue;
      }

      // Heading
      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading) {
        flushParagraph();
        const level = heading[1].length;
        html += '<h' + level + '>' + renderInline(heading[2]) + '</h' + level + '>';
        i++;
        continue;
      }

      // Horizontal rule
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
        flushParagraph();
        html += '<hr>';
        i++;
        continue;
      }

      // Table: header line followed by a separator line
      if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
        flushParagraph();
        const tableLines = [line, lines[i + 1]];
        i += 2;
        while (i < lines.length && lines[i].includes('|') && !/^\s*$/.test(lines[i])) {
          tableLines.push(lines[i]);
          i++;
        }
        html += renderTable(tableLines);
        continue;
      }

      // Blockquote
      if (/^\s*>\s?/.test(line)) {
        flushParagraph();
        const quoted = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          quoted.push(lines[i].replace(/^\s*>\s?/, ''));
          i++;
        }
        html += '<blockquote>' + renderMarkdown(quoted.join('\n')) + '</blockquote>';
        continue;
      }

      // List
      if (LIST_ITEM.test(line)) {
        flushParagraph();
        const items = [];
        while (i < lines.length && LIST_ITEM.test(lines[i])) {
          items.push(LIST_ITEM.exec(lines[i]));
          i++;
        }
        html += renderList(items);
        continue;
      }

      paragraph.push(line);
      i++;
    }
    flushParagraph();
    return html;
  }

  window.renderMarkdown = renderMarkdown;
})();
