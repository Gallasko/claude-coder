// @ts-check
// Pure, DOM-free slash-command table and parsing, shared between the chat webview (chat.js,
// loaded as a plain <script>) and its unit tests (Node/Vitest, loaded via module.exports).
(function (root) {
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

  /** Matches the still-being-typed "/foo" prefix in the composer and returns candidate commands, or null when the text isn't a bare slash-prefix (menu should close). */
  function matchCommandPrefix(inputValue) {
    const m = /^\/([\w-]*)$/.exec(inputValue);
    if (!m) {
      return null;
    }
    const typed = m[1].toLowerCase();
    return SLASH_COMMANDS.filter((c) => c.name.startsWith(typed));
  }

  /** Parses a fully-typed "/command arg" line into its known command + argument, or null if unrecognized (falls through to a normal chat message). */
  function parseSlashCommand(text) {
    const m = /^\/([\w-]+)(?:\s+([\s\S]*))?$/.exec(text);
    if (!m) {
      return null;
    }
    const known = SLASH_COMMANDS.find((c) => c.name === m[1].toLowerCase());
    return known ? { name: known.name, arg: m[2] } : null;
  }

  /** Maps a known command name to the message posted to the extension host. 'help' is handled locally in chat.js (needs addMsg, a DOM function) and returns null here. */
  function commandToMessage(name, arg) {
    switch (name) {
      case 'setup':
        return { type: 'runSetup' };
      case 'new':
        return { type: 'newTask' };
      case 'escalate':
        return { type: 'escalate' };
      case 'costs':
        return { type: 'showCosts' };
      case 'usage':
        return { type: 'showUsageHistory' };
      case 'plan-usage':
        return { type: 'showSubscriptionUsage' };
      case 'history':
        return { type: 'showChatHistory' };
      case 'memory':
        return { type: 'showMemory' };
      case 'reset-permissions':
        return { type: 'resetPermissions' };
      case 'commit':
        return { type: 'commit', text: arg || '' };
      case 'deferred':
        return { type: 'deferred', text: arg || '' };
      default:
        return null;
    }
  }

  const api = { SLASH_COMMANDS, matchCommandPrefix, parseSlashCommand, commandToMessage };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.SlashCommands = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
