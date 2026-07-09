import * as vscode from 'vscode';
import { Controller } from '../controller';

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'claudeCoder.chat';
  private view: vscode.WebviewView | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly controller: Controller
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    webviewView.webview.html = this.html(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'send':
          await this.controller.handleUserMessage(String(msg.text ?? ''));
          break;
        case 'cancel':
          this.controller.cancel();
          break;
        case 'newTask':
          this.controller.newTask();
          break;
        case 'escalate':
          await this.controller.escalate();
          break;
        case 'permissionResponse':
          this.controller.handlePermissionResponse(msg.id, String(msg.choice));
          break;
        case 'showCosts':
          this.controller.showCosts();
          break;
        case 'showUsageHistory':
          await this.controller.showUsageHistory();
          break;
        case 'resetPermissions':
          await this.controller.resetPermissions();
          break;
        case 'runSetup':
          await this.controller.runSetup();
          break;
      }
    });

    this.controller.attachUi({
      post: (message) => {
        this.view?.webview.postMessage(message);
      },
    });
  }

  private html(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'chat.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'chat.css'));
    const nonce = Math.random().toString(36).slice(2);
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${styleUri}" rel="stylesheet">
</head>
<body>
  <div id="header">
    <span id="session-model"></span>
    <span id="session-cost"></span>
    <span class="spacer"></span>
    <button id="btn-escalate" title="Restart this task on the next bigger model">Escalate</button>
    <button id="btn-new" title="Archive this session and start fresh">New task</button>
  </div>
  <div id="task-line"></div>
  <div id="messages"></div>
  <div id="composer">
    <div id="command-menu" class="hidden"></div>
    <textarea id="input" rows="3" placeholder="Ask Claude to do something in this workspace… (try /)"></textarea>
    <div id="composer-buttons">
      <button id="btn-cancel" class="hidden">Stop</button>
      <button id="btn-send">Send</button>
    </div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
