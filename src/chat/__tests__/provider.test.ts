import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChatViewProvider } from '../provider';
import { Uri } from '../../test/mocks/vscode';

function makeFakeController() {
  return {
    handleUserMessage: vi.fn(async () => undefined),
    cancel: vi.fn(),
    newTask: vi.fn(),
    escalate: vi.fn(async () => undefined),
    handlePermissionResponse: vi.fn(),
    handleAskQuestionResponse: vi.fn(),
    showCosts: vi.fn(),
    showUsageHistory: vi.fn(async () => undefined),
    showSubscriptionUsage: vi.fn(async () => undefined),
    showChatHistory: vi.fn(async () => undefined),
    showMemory: vi.fn(async () => undefined),
    resetPermissions: vi.fn(async () => undefined),
    runSetup: vi.fn(async () => undefined),
    commitChanges: vi.fn(async () => undefined),
    handleDeferredCommand: vi.fn(async () => undefined),
    attachUi: vi.fn(),
  };
}

function makeFakeWebviewView() {
  let handler: ((msg: any) => void | Promise<void>) | undefined;
  const postMessage = vi.fn();
  return {
    view: {
      webview: {
        options: undefined as unknown,
        html: '',
        cspSource: 'vscode-webview:',
        asWebviewUri: (u: Uri) => u,
        onDidReceiveMessage: (fn: (msg: any) => void | Promise<void>) => {
          handler = fn;
        },
        postMessage,
      },
    },
    postMessage,
    send: async (msg: any) => {
      await handler!(msg);
    },
  };
}

describe('ChatViewProvider message dispatch', () => {
  let controller: ReturnType<typeof makeFakeController>;
  let view: ReturnType<typeof makeFakeWebviewView>;
  let provider: ChatViewProvider;

  beforeEach(() => {
    controller = makeFakeController();
    provider = new ChatViewProvider(Uri.file('/ext') as any, controller as any);
    view = makeFakeWebviewView();
    provider.resolveWebviewView(view.view as any);
  });

  it('attaches the UI once during resolveWebviewView, forwarding post() to webview.postMessage', () => {
    expect(controller.attachUi).toHaveBeenCalledTimes(1);
    const ui = controller.attachUi.mock.calls[0][0];
    ui.post({ type: 'notice', text: 'hi' });
    expect(view.postMessage).toHaveBeenCalledWith({ type: 'notice', text: 'hi' });
  });

  it.each([
    ['send', { type: 'send', text: 'hello' }, 'handleUserMessage', ['hello']],
    ['cancel', { type: 'cancel' }, 'cancel', []],
    ['newTask', { type: 'newTask' }, 'newTask', []],
    ['escalate', { type: 'escalate' }, 'escalate', []],
    ['permissionResponse', { type: 'permissionResponse', id: 7, choice: 'yes' }, 'handlePermissionResponse', [7, 'yes']],
    ['askQuestionResponse', { type: 'askQuestionResponse', id: 9, answers: { a: 'b' } }, 'handleAskQuestionResponse', [9, { a: 'b' }]],
    ['showCosts', { type: 'showCosts' }, 'showCosts', []],
    ['showUsageHistory', { type: 'showUsageHistory' }, 'showUsageHistory', []],
    ['showSubscriptionUsage', { type: 'showSubscriptionUsage' }, 'showSubscriptionUsage', []],
    ['showChatHistory', { type: 'showChatHistory' }, 'showChatHistory', []],
    ['showMemory', { type: 'showMemory' }, 'showMemory', []],
    ['resetPermissions', { type: 'resetPermissions' }, 'resetPermissions', []],
    ['runSetup', { type: 'runSetup' }, 'runSetup', []],
    ['commit', { type: 'commit', text: 'msg' }, 'commitChanges', ['msg']],
    ['deferred', { type: 'deferred', text: 'cancel 3' }, 'handleDeferredCommand', ['cancel 3']],
  ] as const)('%s dispatches to Controller.%s', async (_label, msg, method, args) => {
    await view.send(msg);
    expect((controller as any)[method]).toHaveBeenCalledWith(...args);
  });

  it('does nothing for an unrecognized message type', async () => {
    await expect(view.send({ type: 'totallyUnknown' })).resolves.toBeUndefined();
    for (const fn of Object.values(controller)) {
      if (fn !== controller.attachUi) {
        expect(fn).not.toHaveBeenCalled();
      }
    }
  });
});
