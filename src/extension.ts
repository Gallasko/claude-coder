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
    vscode.commands.registerCommand('claudeCoder.setApiKey', () => controller.setApiKey()),
    vscode.commands.registerCommand('claudeCoder.escalate', () => controller.escalate()),
    vscode.commands.registerCommand('claudeCoder.showCosts', () => controller.showCosts()),
    vscode.commands.registerCommand('claudeCoder.resetPermissions', () => controller.resetPermissions())
  );
}

export function deactivate(): void {}
