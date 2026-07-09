// @ts-check
(function () {
  const vscode = acquireVsCodeApi();

  const messagesEl = document.getElementById('messages');
  const inputEl = /** @type {HTMLTextAreaElement} */ (document.getElementById('input'));
  const sendBtn = document.getElementById('btn-send');
  const cancelBtn = document.getElementById('btn-cancel');
  const newBtn = document.getElementById('btn-new');
  const escalateBtn = document.getElementById('btn-escalate');
  const modelEl = document.getElementById('session-model');
  const costEl = document.getElementById('session-cost');
  const taskEl = document.getElementById('task-line');
  const commandMenuEl = document.getElementById('command-menu');

  /** The assistant bubble currently being streamed into, if any. */
  let streamEl = null;
  /** The ephemeral "working…" indicator shown while a turn runs. */
  let workingEl = null;
  /** The collapsible "thinking" block for the current turn, if any. */
  let thinkingEl = null;
  let thinkingBodyEl = null;

  function fmtTok(n) {
    return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
  }

  function updateWorking(phase, tokens) {
    if (!workingEl) {
      workingEl = document.createElement('div');
      workingEl.className = 'msg working';
      const spin = document.createElement('span');
      spin.className = 'spinner';
      const label = document.createElement('span');
      label.className = 'working-label';
      workingEl.appendChild(spin);
      workingEl.appendChild(label);
    }
    workingEl.querySelector('.working-label').textContent =
      phase + ' · ~' + fmtTok(tokens) + ' tok';
    messagesEl.appendChild(workingEl); // keep it pinned at the bottom
    scrollDown();
  }

  function clearWorking() {
    if (workingEl) {
      workingEl.remove();
      workingEl = null;
    }
  }

  function ensureThinking() {
    if (!thinkingEl) {
      thinkingEl = document.createElement('div');
      thinkingEl.className = 'msg thinking';

      const header = document.createElement('div');
      header.className = 'thinking-header';
      const toggle = document.createElement('button');
      toggle.className = 'thinking-toggle';
      toggle.textContent = 'Show thinking';
      const label = document.createElement('span');
      label.className = 'thinking-label';
      label.textContent = '🧠 Thinking…';
      header.appendChild(label);
      header.appendChild(toggle);

      thinkingBodyEl = document.createElement('pre');
      thinkingBodyEl.className = 'thinking-body hidden';

      toggle.addEventListener('click', () => {
        const hidden = thinkingBodyEl.classList.toggle('hidden');
        toggle.textContent = hidden ? 'Show thinking' : 'Hide thinking';
      });

      thinkingEl.appendChild(header);
      thinkingEl.appendChild(thinkingBodyEl);
      messagesEl.appendChild(thinkingEl);
    }
    return thinkingEl;
  }

  function appendThinking(text) {
    ensureThinking();
    thinkingBodyEl.textContent += text;
    if (workingEl) {
      messagesEl.appendChild(workingEl); // stay pinned below
    }
    scrollDown();
  }

  function clearThinking() {
    thinkingEl = null;
    thinkingBodyEl = null;
  }

  const SLASH_COMMANDS = [
    { name: 'new', desc: 'Start a new task (reset session)' },
    { name: 'escalate', desc: 'Restart task on the next bigger model' },
    { name: 'costs', desc: 'Show session cost breakdown' },
    { name: 'usage', desc: 'Show usage history & billing tracker' },
    { name: 'reset-permissions', desc: 'Clear "always allow" permissions' },
    { name: 'help', desc: 'List available commands' },
  ];

  let commandMatches = [];
  let activeCommandIndex = 0;

  function closeCommandMenu() {
    commandMenuEl.classList.add('hidden');
    commandMenuEl.innerHTML = '';
    commandMatches = [];
    activeCommandIndex = 0;
  }

  function renderCommandMenu() {
    commandMenuEl.innerHTML = '';
    commandMatches.forEach((cmd, i) => {
      const item = document.createElement('div');
      item.className = 'command-item' + (i === activeCommandIndex ? ' active' : '');

      const name = document.createElement('span');
      name.className = 'cmd-name';
      name.textContent = '/' + cmd.name;

      const desc = document.createElement('span');
      desc.className = 'cmd-desc';
      desc.textContent = cmd.desc;

      item.appendChild(name);
      item.appendChild(desc);
      // mousedown (not click) so the textarea doesn't blur before we handle the selection.
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        applyCommand(cmd);
      });
      commandMenuEl.appendChild(item);
    });
    commandMenuEl.classList.toggle('hidden', commandMatches.length === 0);
  }

  function updateCommandMenu() {
    const match = /^\/([\w-]*)$/.exec(inputEl.value);
    if (!match) {
      closeCommandMenu();
      return;
    }
    const typed = match[1].toLowerCase();
    commandMatches = SLASH_COMMANDS.filter((c) => c.name.startsWith(typed));
    activeCommandIndex = 0;
    renderCommandMenu();
  }

  function applyCommand(cmd) {
    closeCommandMenu();
    inputEl.focus();
    runSlashCommand(cmd.name);
  }

  function runSlashCommand(name) {
    inputEl.value = '';
    switch (name) {
      case 'new':
        vscode.postMessage({ type: 'newTask' });
        break;
      case 'escalate':
        setBusy(true);
        vscode.postMessage({ type: 'escalate' });
        break;
      case 'costs':
        vscode.postMessage({ type: 'showCosts' });
        break;
      case 'usage':
        vscode.postMessage({ type: 'showUsageHistory' });
        break;
      case 'reset-permissions':
        vscode.postMessage({ type: 'resetPermissions' });
        break;
      case 'help':
        addMsg('notice', 'Available commands:\n' + SLASH_COMMANDS.map((c) => '/' + c.name + ' — ' + c.desc).join('\n'));
        break;
      default:
        addMsg('notice', 'Unknown command: /' + name);
    }
  }

  function scrollDown() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function addMsg(cls, text) {
    const div = document.createElement('div');
    div.className = 'msg ' + cls;
    div.textContent = text;
    messagesEl.appendChild(div);
    scrollDown();
    return div;
  }

  function setBusy(busy) {
    sendBtn.classList.toggle('hidden', busy);
    cancelBtn.classList.toggle('hidden', !busy);
  }

  function send() {
    const text = inputEl.value.trim();
    if (!text) {
      return;
    }
    const cmdMatch = /^\/([\w-]+)$/.exec(text);
    if (cmdMatch) {
      const known = SLASH_COMMANDS.find((c) => c.name === cmdMatch[1].toLowerCase());
      if (known) {
        closeCommandMenu();
        runSlashCommand(known.name);
        return;
      }
    }
    closeCommandMenu();
    addMsg('user', text);
    inputEl.value = '';
    streamEl = null;
    clearThinking();
    setBusy(true);
    updateWorking('sending', 0);
    vscode.postMessage({ type: 'send', text });
  }

  sendBtn.addEventListener('click', send);
  inputEl.addEventListener('input', updateCommandMenu);
  inputEl.addEventListener('keydown', (e) => {
    if (!commandMenuEl.classList.contains('hidden') && commandMatches.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        activeCommandIndex = (activeCommandIndex + 1) % commandMatches.length;
        renderCommandMenu();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        activeCommandIndex = (activeCommandIndex - 1 + commandMatches.length) % commandMatches.length;
        renderCommandMenu();
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        applyCommand(commandMatches[activeCommandIndex]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeCommandMenu();
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  cancelBtn.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
  newBtn.addEventListener('click', () => vscode.postMessage({ type: 'newTask' }));
  escalateBtn.addEventListener('click', () => {
    setBusy(true);
    vscode.postMessage({ type: 'escalate' });
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'delta':
        if (!streamEl) {
          streamEl = addMsg('assistant', '');
        }
        streamEl.textContent += msg.text;
        if (workingEl) {
          messagesEl.appendChild(workingEl); // stay below the streaming text
        }
        scrollDown();
        break;
      case 'working':
        updateWorking(msg.phase, msg.tokens);
        break;
      case 'thinking':
        appendThinking(msg.text);
        break;
      case 'accepted':
        updateWorking('accepted', 0);
        break;
      case 'toolUse':
        streamEl = null;
        addMsg('tool', '⚙ ' + msg.name + '  ' + (msg.detail || ''));
        break;
      case 'toolResult':
        if (!msg.ok) {
          addMsg('tool error', '✗ ' + msg.name + ': ' + (msg.preview || 'failed'));
        }
        break;
      case 'permission': {
        streamEl = null;
        const card = document.createElement('div');
        card.className = 'msg permission';
        card.dataset.permId = String(msg.id);

        const title = document.createElement('div');
        title.className = 'perm-title';
        title.textContent = msg.title;
        card.appendChild(title);

        if (msg.detail) {
          const detail = document.createElement('pre');
          detail.className = 'perm-detail';
          detail.textContent = msg.detail;
          card.appendChild(detail);
        }

        const buttons = document.createElement('div');
        buttons.className = 'perm-buttons';
        [
          ['yes', 'Yes'],
          ['always', "Yes, don't ask again"],
          ['no', 'No'],
        ].forEach(([choice, label]) => {
          const b = document.createElement('button');
          b.textContent = label;
          b.className = 'perm-' + choice;
          b.addEventListener('click', () => {
            vscode.postMessage({ type: 'permissionResponse', id: msg.id, choice });
          });
          buttons.appendChild(b);
        });
        card.appendChild(buttons);
        messagesEl.appendChild(card);
        scrollDown();
        break;
      }
      case 'permissionResolved': {
        const card = messagesEl.querySelector('.permission[data-perm-id="' + msg.id + '"]');
        if (card) {
          const buttons = card.querySelector('.perm-buttons');
          if (buttons) {
            buttons.remove();
          }
          const verdict = document.createElement('div');
          verdict.className = 'perm-verdict ' + (msg.choice === 'no' ? 'denied' : 'allowed');
          verdict.textContent =
            msg.choice === 'always' ? '✓ Allowed (always)' : msg.choice === 'yes' ? '✓ Allowed' : '✗ Denied';
          card.appendChild(verdict);
        }
        break;
      }
      case 'notice':
        addMsg('notice', msg.text);
        break;
      case 'error':
        clearWorking();
        addMsg('notice error', msg.text);
        setBusy(false);
        break;
      case 'taskSwitch':
        streamEl = null;
        addMsg('switch', msg.text);
        break;
      case 'turnDone':
        clearWorking();
        streamEl = null;
        clearThinking();
        setBusy(false);
        break;
      case 'sessionInfo':
        modelEl.textContent = msg.model + ' · ' + msg.effort;
        costEl.textContent = msg.costLine || msg.cost + ' (total ' + msg.totalCost + ')';
        taskEl.textContent = msg.task || '';
        break;
    }
  });
})();
