import * as vscode from 'vscode';
import { Controller } from './controller';
import { ChatViewProvider } from './chat/provider';

export function activate(context: vscode.ExtensionContext): void {
  const controller = new Controller(context);
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
    vscode.commands.registerCommand('claudeCoder.resetPermissions', () => controller.resetPermissions())
  );

  // Background freshness check for task memories (see taskMemoryStore.ts) —
  // catches files edited outside the extension (by the user directly) so
  // stale memories get flagged instead of silently going out of sync.
  const taskMemoryPoll = setInterval(() => void controller.pollTaskMemoryFreshness(), 5 * 60 * 1000);
  context.subscriptions.push({ dispose: () => clearInterval(taskMemoryPoll) });
}

export function deactivate(): void {}
