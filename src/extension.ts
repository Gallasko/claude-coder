import * as vscode from 'vscode';
import { Controller } from './controller';
import { ChatViewProvider } from './chat/provider';

let controllerRef: Controller | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const controller = new Controller(context);
  controllerRef = controller;
  const provider = new ChatViewProvider(context.extensionUri, controller);

  context.subscriptions.push(
    controller,
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('claudeCoder.newTask', () => controller.newTask()),
    vscode.commands.registerCommand('claudeCoder.setup', () => controller.runSetup()),
    vscode.commands.registerCommand('claudeCoder.setApiKey', () => controller.setApiKey()),
    vscode.commands.registerCommand('claudeCoder.escalate', () => controller.escalate()),
    vscode.commands.registerCommand('claudeCoder.showCosts', () => controller.showCosts()),
    vscode.commands.registerCommand('claudeCoder.showUsageHistory', () => controller.showUsageHistory()),
    vscode.commands.registerCommand('claudeCoder.showSubscriptionUsage', () => controller.showSubscriptionUsage()),
    vscode.commands.registerCommand('claudeCoder.showMemory', () => controller.showMemory()),
    vscode.commands.registerCommand('claudeCoder.addMemoryNote', async () => {
      const text = await vscode.window.showInputBox({
        prompt: 'Memory note for this project',
        placeHolder: 'e.g. Prefer named exports over default exports',
      });
      if (text) {
        await controller.addMemoryNote(text);
      }
    }),
    vscode.commands.registerCommand('claudeCoder.showChatHistory', () => controller.showChatHistory()),
    vscode.commands.registerCommand('claudeCoder.resetPermissions', () => controller.resetPermissions()),
    vscode.commands.registerCommand('claudeCoder.openInWindow', () => provider.openInWindow())
  );

  // Background freshness check for task memories (see taskMemoryStore.ts) —
  // catches files edited outside the extension (by the user directly) so
  // stale memories get flagged instead of silently going out of sync.
  const taskMemoryPoll = setInterval(() => void controller.pollTaskMemoryFreshness(), 5 * 60 * 1000);
  context.subscriptions.push({ dispose: () => clearInterval(taskMemoryPoll) });

  // Deferred tasks (see deferredTaskStore.ts) — prompts parked until the
  // subscription plan limit resets. Check once on activation (catch up after
  // a restart) and then every minute; interval-based so sleep/hibernate and
  // reloads are all covered by one mechanism.
  void controller.checkDueDeferredTasks();
  const deferredPoll = setInterval(() => void controller.checkDueDeferredTasks(), 60 * 1000);
  context.subscriptions.push({ dispose: () => clearInterval(deferredPoll) });
}

export async function deactivate(): Promise<void> {
  await controllerRef?.flushMemoryOnClose();
}
