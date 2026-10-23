import * as vscode from "vscode";
import { Agent } from "../agent";

export class ChatViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private factory?: () => Promise<Agent>;

  constructor(private context: vscode.ExtensionContext) {}

  setAgentFactory(factory: () => Promise<Agent>) {
    this.factory = factory;
  }

  resolveWebviewView(view: vscode.WebviewView) {
    console.log("[FreePilot] Resolving chat webview");
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    view.webview.html = this.getHtml();
    console.log("[FreePilot] Webview HTML assigned");

    view.webview.onDidReceiveMessage(async message => {
      if (message?.type === "configure") {
        await vscode.commands.executeCommand("freepilot.configure");
        return;
      }
      if (message?.type !== "ask" || typeof message.text !== "string" || !message.text.trim()) return;
      
      this.addMessage("status", "Thinking and inspecting workspace…");
      try {
        if (!this.factory) throw new Error("Agent is not ready.");
        const agent = await this.factory();
        const answer = await agent.run(message.text.slice(0, 12000), text => this.addMessage("status", text));
        this.addMessage("assistant", answer);
      } catch (e) {
        this.addMessage("error", e instanceof Error ? e.message : String(e));
      }
    });
  }

  private post(message: unknown) {
    this.view?.webview.postMessage(message);
  }

  private addMessage(type: string, text: string) {
    this.post({ type, text });
  }

  private getHtml(): string {
    const nonce = this.getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    :root {
      --radius: 6px;
    }
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background-color: var(--vscode-sideBar-background);
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      height: 100vh;
      box-sizing: border-box;
    }
    .header {
      padding: 10px 14px;
      border-bottom: 1px solid var(--vscode-sideBar-border, var(--vscode-panel-border));
      display: flex;
      align-items: center;
      justify-content: space-between;
      background-color: var(--vscode-editor-background);
    }
    .header-title {
      font-weight: 600;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--vscode-descriptionForeground);
    }
    #messages {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .msg {
      white-space: pre-wrap;
      word-break: break-word;
      padding: 10px 12px;
      border-radius: var(--radius);
      font-size: 13px;
      line-height: 1.4;
    }
    .msg.user {
      background-color: var(--vscode-button-secondaryBackground, var(--vscode-editor-inactiveSelectionBackground));
      color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
      align-self: flex-end;
      max-width: 88%;
      border-bottom-right-radius: 2px;
    }
    .msg.assistant {
      background-color: var(--vscode-editor-background);
      border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
      align-self: stretch;
      border-top-left-radius: 2px;
    }
    .msg.status {
      color: var(--vscode-descriptionForeground);
      font-style: italic;
      font-size: 11px;
      text-align: center;
      padding: 4px;
      background: transparent;
    }
    .msg.error {
      background-color: var(--vscode-inputValidation-errorBackground);
      color: var(--vscode-inputValidation-errorForeground);
      border: 1px solid var(--vscode-inputValidation-errorBorder);
    }
    .input-area {
      padding: 10px 12px;
      border-top: 1px solid var(--vscode-sideBar-border, var(--vscode-panel-border));
      background-color: var(--vscode-sideBar-background);
    }
    textarea {
      width: 100%;
      box-sizing: border-box;
      resize: none;
      height: 64px;
      padding: 8px 10px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: var(--radius);
      font-family: inherit;
      font-size: 13px;
    }
    textarea:focus {
      outline: 1px solid var(--vscode-focusBorder);
    }
    .row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-top: 6px;
    }
    .button-group {
      display: flex;
      gap: 6px;
    }
    button {
      padding: 5px 10px;
      font-size: 12px;
      font-weight: 500;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      border: none;
      border-radius: var(--radius);
      cursor: pointer;
    }
    button:hover {
      background: var(--vscode-button-hoverBackground);
    }
    button.link-btn {
      background: transparent;
      color: var(--vscode-textLink-foreground);
      padding: 4px 2px;
    }
    button.link-btn:hover {
      background: transparent;
      text-decoration: underline;
    }
    .hint {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
    }
  </style>
</head>
<body>
  <div class="header">
    <span class="header-title">FreePilot Agent</span>
    <button id="config" class="link-btn">Configure</button>
  </div>
  
  <div id="messages" aria-live="polite">
    <div class="msg assistant">👋 Hello! I am your FreePilot coding agent. Ask me to inspect, explain, create, or modify files in your workspace.</div>
  </div>

  <div class="input-area">
    <textarea id="prompt" placeholder="Ask FreePilot anything (Ctrl+Enter to send)…"></textarea>
    <div class="row">
      <span class="hint">Edits require your approval</span>
      <button id="send">Send</button>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const messages = document.getElementById('messages');
    const promptBox = document.getElementById('prompt');

    function addMessage(text, cls='') {
      const el = document.createElement('div');
      el.className = 'msg ' + cls;
      el.textContent = text;
      messages.appendChild(el);
      el.scrollIntoView({ block: 'end', behavior: 'smooth' });
    }

    document.getElementById('send').addEventListener('click', () => {
      const text = promptBox.value.trim();
      if (!text) return;
      addMessage(text, 'user');
      promptBox.value = '';
      vscode.postMessage({ type: 'ask', text });
    });

    document.getElementById('config').addEventListener('click', () => {
      vscode.postMessage({ type: 'configure' });
    });

    promptBox.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        document.getElementById('send').click();
      }
    });

    window.addEventListener('message', event => {
      const m = event.data;
      if (m.type === 'status') addMessage(m.text, 'status');
      else if (m.type === 'assistant' || m.type === 'answer') addMessage(m.text, 'assistant');
      else if (m.type === 'error') addMessage(m.text, 'error');
    });
  </script>
</body>
</html>`;
  }

  private getNonce() {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  }
}