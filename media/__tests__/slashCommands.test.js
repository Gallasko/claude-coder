// @ts-check
import { describe, it, expect } from 'vitest';
import { SLASH_COMMANDS, matchCommandPrefix, parseSlashCommand, commandToMessage } from '../slashCommands.js';

const NON_HELP_COMMANDS = SLASH_COMMANDS.map((c) => c.name).filter((n) => n !== 'help');

describe('SLASH_COMMANDS table', () => {
  it('has exactly the expected command names (guards against drift vs provider.ts\'s switch)', () => {
    expect(SLASH_COMMANDS.map((c) => c.name)).toEqual([
      'setup',
      'new',
      'escalate',
      'costs',
      'usage',
      'plan-usage',
      'history',
      'memory',
      'reset-permissions',
      'commit',
      'deferred',
      'help',
    ]);
  });
});

describe('matchCommandPrefix', () => {
  it('returns all commands for a bare "/"', () => {
    expect(matchCommandPrefix('/')).toHaveLength(SLASH_COMMANDS.length);
  });

  it('filters by typed prefix', () => {
    expect(matchCommandPrefix('/pl').map((c) => c.name)).toEqual(['plan-usage']);
  });

  it('returns null once a full command plus argument has been typed (menu should close)', () => {
    expect(matchCommandPrefix('/plan-usage extra')).toBeNull();
  });

  it('returns null for text that is not a slash prefix at all', () => {
    expect(matchCommandPrefix('hello')).toBeNull();
  });
});

describe('parseSlashCommand', () => {
  it('parses a command with an argument', () => {
    expect(parseSlashCommand('/commit fix bug')).toEqual({ name: 'commit', arg: 'fix bug' });
  });

  it('parses /deferred cancel <id>', () => {
    expect(parseSlashCommand('/deferred cancel 3')).toEqual({ name: 'deferred', arg: 'cancel 3' });
  });

  it('parses a command with no argument', () => {
    expect(parseSlashCommand('/new')).toEqual({ name: 'new', arg: undefined });
  });

  it('returns null for an unrecognized command (falls through to a normal chat message)', () => {
    expect(parseSlashCommand('/unknownthing')).toBeNull();
  });

  it('returns null for plain text', () => {
    expect(parseSlashCommand('just a message')).toBeNull();
  });
});

describe('commandToMessage', () => {
  const expected = {
    setup: { type: 'runSetup' },
    new: { type: 'newTask' },
    escalate: { type: 'escalate' },
    costs: { type: 'showCosts' },
    usage: { type: 'showUsageHistory' },
    'plan-usage': { type: 'showSubscriptionUsage' },
    history: { type: 'showChatHistory' },
    memory: { type: 'showMemory' },
    'reset-permissions': { type: 'resetPermissions' },
    commit: { type: 'commit', text: 'msg' },
    deferred: { type: 'deferred', text: 'cancel 3' },
  };

  it.each(NON_HELP_COMMANDS)('maps /%s to the expected message', (name) => {
    const arg = name === 'commit' ? 'msg' : name === 'deferred' ? 'cancel 3' : undefined;
    expect(commandToMessage(name, arg)).toEqual(expected[name]);
  });

  it('defaults commit/deferred text to "" when no argument is given', () => {
    expect(commandToMessage('commit', undefined)).toEqual({ type: 'commit', text: '' });
    expect(commandToMessage('deferred', undefined)).toEqual({ type: 'deferred', text: '' });
  });

  it('returns null for "help" (handled locally in chat.js) and for unknown names', () => {
    expect(commandToMessage('help', undefined)).toBeNull();
    expect(commandToMessage('nonexistent', undefined)).toBeNull();
  });
});
