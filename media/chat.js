// @ts-check
(function () {
  const vscode = acquireVsCodeApi();

  const messagesEl = document.getElementById('messages');
  const inputEl = /** @type {HTMLTextAreaElement} */ (document.getElementById('input'));
  const sendBtn = document.getElementById('btn-send');
  const cancelBtn = document.getElementById('btn-cancel');
  const newBtn = document.getElementById('btn-new');
  const escalateBtn = document.getElementById('btn-escalate');
  const historyBtn = document.getElementById('btn-history');
  const modelEl = document.getElementById('session-model');
  const costEl = document.getElementById('session-cost');
  const taskEl = document.getElementById('task-line');
const memoryBannerEl = document.getElementById('memory-banner');
  const commandMenuEl = document.getElementById('command-menu');

  /** The assistant bubble currently being streamed into, if any. */
  let streamEl = null;
  /** Raw markdown accumulated for the bubble currently streaming. */
  let streamRaw = '';
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
    { name: 'setup', desc: 'Set up subscription or API key' },
    { name: 'new', desc: 'Start a new task (reset session)' },
    { name: 'escalate', desc: 'Restart task on the next bigger model' },
    { name: 'costs', desc: 'Show session cost breakdown' },
    { name: 'usage', desc: 'Show usage history & billing tracker' },
    { name: 'plan-usage', desc: 'Show Claude subscription plan rate limits (5-hour & weekly)' },
    { name: 'history', desc: 'Show all chats & sessions' },
    { name: 'memory', desc: 'Show project memory (notes, changes, file summaries)' },
    { name: 'reset-permissions', desc: 'Clear "always allow" permissions' },
    { name: 'commit', desc: 'Commit current changes (/commit <message>)' },
    { name: 'deferred', desc: 'List or cancel deferred tasks (/deferred cancel <id>)' },
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

  function runSlashCommand(name, arg) {
    inputEl.value = '';
    switch (name) {
      case 'setup':
        vscode.postMessage({ type: 'runSetup' });
        break;
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
      case 'plan-usage':
        vscode.postMessage({ type: 'showSubscriptionUsage' });
        break;
      case 'history':
        vscode.postMessage({ type: 'showChatHistory' });
        break;
      case 'memory':
        vscode.postMessage({ type: 'showMemory' });
        break;
      case 'reset-permissions':
        vscode.postMessage({ type: 'resetPermissions' });
        break;
      case 'commit':
        vscode.postMessage({ type: 'commit', text: arg || '' });
        break;
      case 'deferred':
        vscode.postMessage({ type: 'deferred', text: arg || '' });
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
    const cmdMatch = /^\/([\w-]+)(?:\s+([\s\S]*))?$/.exec(text);
    if (cmdMatch) {
      const known = SLASH_COMMANDS.find((c) => c.name === cmdMatch[1].toLowerCase());
      if (known) {
        closeCommandMenu();
        runSlashCommand(known.name, cmdMatch[2]);
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
  historyBtn.addEventListener('click', () => vscode.postMessage({ type: 'showChatHistory' }));
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
          streamRaw = '';
        }
        streamRaw += msg.text;
        streamEl.innerHTML = renderMarkdown(streamRaw);
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
        const isPlan = msg.kind === 'plan';
        const isDiff = msg.kind === 'diff';
        const card = document.createElement('div');
        card.className = 'msg permission' + (isPlan ? ' plan-approval' : '') + (isDiff ? ' diff-approval' : '');
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
        (isPlan
          ? [
              ['yes', 'Approve'],
              ['no', 'Reject'],
            ]
          : isDiff
            ? [
                ['yes', 'Apply'],
                ['always', "Apply, don't ask again"],
                ['no', 'Discard'],
              ]
            : [
                ['yes', 'Yes'],
                ['always', "Yes, don't ask again"],
                ['no', 'No'],
              ]
        ).forEach(([choice, label]) => {
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
          verdict.textContent = card.classList.contains('plan-approval')
            ? msg.choice === 'no'
              ? '✗ Rejected'
              : '✓ Approved'
            : card.classList.contains('diff-approval')
              ? msg.choice === 'no'
                ? '✗ Discarded'
                : msg.choice === 'always'
                  ? '✓ Applied (always)'
                  : '✓ Applied'
              : msg.choice === 'always'
                ? '✓ Allowed (always)'
                : msg.choice === 'yes'
                  ? '✓ Allowed'
                  : '✗ Denied';
          card.appendChild(verdict);
        }
        break;
      }
      case 'askQuestion': {
        streamEl = null;
        const card = document.createElement('div');
        card.className = 'msg question';
        card.dataset.questionId = String(msg.id);

        const questionEls = [];

        (msg.questions || []).forEach((q) => {
          const qBlock = document.createElement('div');
          qBlock.className = 'question-block';

          const chip = document.createElement('span');
          chip.className = 'question-header-chip';
          chip.textContent = q.header || '';
          qBlock.appendChild(chip);

          const qText = document.createElement('div');
          qText.className = 'question-text';
          qText.textContent = q.question;
          qBlock.appendChild(qText);

          const optionsEl = document.createElement('div');
          optionsEl.className = 'question-options';
          const selected = new Set();

          (q.options || []).forEach((opt) => {
            const b = document.createElement('button');
            b.className = 'question-option';
            b.textContent = opt.label;
            if (opt.description) {
              b.title = opt.description;
            }
            b.addEventListener('click', () => {
              if (q.multiSelect) {
                if (selected.has(opt.label)) {
                  selected.delete(opt.label);
                  b.classList.remove('selected');
                } else {
                  selected.add(opt.label);
                  b.classList.add('selected');
                }
              } else {
                selected.clear();
                optionsEl.querySelectorAll('.question-option').forEach((el) => el.classList.remove('selected'));
                selected.add(opt.label);
                b.classList.add('selected');
              }
              submitBtn.disabled = questionEls.some((qe) => qe.selected.size === 0);
            });
            optionsEl.appendChild(b);
          });

          qBlock.appendChild(optionsEl);
          card.appendChild(qBlock);
          questionEls.push({ question: q.question, selected });
        });

        const actions = document.createElement('div');
        actions.className = 'question-actions';

        const respond = (finalAnswers) => {
          vscode.postMessage({ type: 'askQuestionResponse', id: msg.id, answers: finalAnswers });
        };

        const submitBtn = document.createElement('button');
        submitBtn.className = 'question-submit';
        submitBtn.textContent = 'Submit';
        submitBtn.disabled = questionEls.some((qe) => qe.selected.size === 0);
        submitBtn.addEventListener('click', () => {
          const finalAnswers = {};
          questionEls.forEach((qe) => {
            finalAnswers[qe.question] = Array.from(qe.selected).join(', ');
          });
          respond(finalAnswers);
        });

        const skipBtn = document.createElement('button');
        skipBtn.className = 'perm-no';
        skipBtn.textContent = 'Skip';
        skipBtn.addEventListener('click', () => {
          const finalAnswers = {};
          questionEls.forEach((qe) => {
            finalAnswers[qe.question] = '';
          });
          respond(finalAnswers);
        });

        actions.appendChild(submitBtn);
        actions.appendChild(skipBtn);
        card.appendChild(actions);

        messagesEl.appendChild(card);
        scrollDown();
        break;
      }
      case 'askQuestionResolved': {
        const card = messagesEl.querySelector('.question[data-question-id="' + msg.id + '"]');
        if (card) {
          card.querySelectorAll('.question-option').forEach((el) => {
            el.disabled = true;
          });
          const actions = card.querySelector('.question-actions');
          if (actions) {
            actions.remove();
          }
          const verdict = document.createElement('div');
          verdict.className = 'perm-verdict allowed';
          verdict.style.whiteSpace = 'pre-wrap';
          const entries = Object.entries(msg.answers || {});
          verdict.textContent = entries.length
            ? entries.map(([q, a]) => q + ': ' + (a || '(skipped)')).join('\n')
            : '(skipped)';
          card.appendChild(verdict);
        }
        break;
      }
      case 'notice':
        addMsg('notice', msg.text);
        break;
      case 'memoryPending':
        if (msg.active) {
          memoryBannerEl.textContent = msg.text || 'Memory action pending…';
          memoryBannerEl.classList.remove('hidden');
        } else {
          memoryBannerEl.classList.add('hidden');
        }
        break;
      case 'setupNeeded': {
        streamEl = null;
        const card = document.createElement('div');
        card.className = 'msg setup';

        const title = document.createElement('div');
        title.className = 'setup-title';
        title.textContent = '🛠 ' + msg.title;
        card.appendChild(title);

        if (msg.detail) {
          const detail = document.createElement('div');
          detail.className = 'setup-detail';
          detail.textContent = msg.detail;
          card.appendChild(detail);
        }

        const buttons = document.createElement('div');
        buttons.className = 'perm-buttons';
        const run = document.createElement('button');
        run.textContent = 'Run setup';
        run.addEventListener('click', () => {
          vscode.postMessage({ type: 'runSetup' });
        });
        buttons.appendChild(run);
        card.appendChild(buttons);

        messagesEl.appendChild(card);
        scrollDown();
        break;
      }
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
