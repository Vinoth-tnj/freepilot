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
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    view.webview.html = this.getHtml();

    view.webview.onDidReceiveMessage(async message => {
      if (message?.type === "configure") {
        await vscode.commands.executeCommand("freepilot.configure");
        return;
      }
      if (message?.type === "selectModel") {
        try {
          if (!this.factory) throw new Error("Agent not initialized.");
          const agent = await this.factory();
          const list = await agent.listModels();
          const selected = await vscode.window.showQuickPick(list, { placeHolder: "Select Model from FreeLLMAPI" });
          if (selected) {
            await vscode.workspace.getConfiguration("freepilot").update("model", selected, vscode.ConfigurationTarget.Global);
            this.post({ type: "notification", text: `Active model updated to: ${selected}` });
          }
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(`Failed to fetch models: ${detail}`);
        }
        return;
      }
      if (message?.type === "togglePermission") {
        const modes = [
          { label: "Manual Review (Default)", description: "Pause and ask for approval on file edits", value: "manual" },
          { label: "Auto-Apply", description: "Stream edits directly into files with Undo option", value: "auto" }
        ];
        const chosen = await vscode.window.showQuickPick(modes, { placeHolder: "Select Execution Permission Mode" });
        if (chosen) {
          await vscode.workspace.getConfiguration("freepilot").update("applyMode", chosen.value, vscode.ConfigurationTarget.Global);
          this.post({ type: "permissionUpdated", mode: chosen.label });
          this.post({ type: "notification", text: `Permission mode set to: ${chosen.label}` });
        }
        return;
      }
      if (message?.type === "attachContext") {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
          const relPath = vscode.workspace.asRelativePath(editor.document.uri);
          this.post({ type: "contextAttached", path: relPath });
        } else {
          vscode.window.showInformationMessage("Open a file tab to attach code context.");
        }
        return;
      }
      if (message?.type === "undo") {
        const relPath = message.path;
        if (typeof relPath === "string" && relPath) {
          try {
            const root = vscode.workspace.workspaceFolders?.[0]?.uri;
            if (!root) throw new Error("No workspace folder open.");
            const uri = vscode.Uri.joinPath(root, relPath);
            if (message.existedBefore) {
              await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(message.oldContent ?? ""));
            } else {
              await vscode.workspace.fs.delete(uri, { recursive: false, useTrash: false });
            }
            this.post({ type: "notification", text: `Undone change to ${relPath}` });
            this.post({ type: "undoSuccess", id: message.id });
          } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            this.post({ type: "error", text: `Failed to undo change to ${relPath}: ${detail}` });
          }
        }
        return;
      }
      if (message?.type !== "ask" || typeof message.text !== "string" || !message.text.trim()) return;

      this.post({ type: "loading", text: "Thinking and inspecting workspace…" });
      try {
        if (!this.factory) throw new Error("Agent is not ready.");
        const agent = await this.factory();
        const answer = await agent.run(message.text.slice(0, 12000), (text, activity) => {
          if (activity) {
            this.post({ type: "activity", text, ...activity });
          } else {
            this.post({ type: "loading", text });
          }
        });
        this.post({ type: "assistant", text: answer });
      } catch (e) {
        this.post({ type: "error", text: e instanceof Error ? e.message : String(e) });
      }
    });
  }

  private post(message: unknown) {
    this.view?.webview.postMessage(message);
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
      --radius: 8px;
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
      padding: 8px 12px;
      border-bottom: 1px solid var(--vscode-sideBar-border, var(--vscode-panel-border));
      display: flex;
      align-items: center;
      justify-content: space-between;
      background-color: var(--vscode-editor-background);
    }
    .header-left {
      display: flex;
      align-items: center;
      gap: 6px;
      color: var(--vscode-foreground);
    }
    .header-left svg {
      width: 14px;
      height: 14px;
    }
    .header-title {
      font-weight: 600;
      font-size: 12px;
      color: var(--vscode-foreground);
    }
    #messages {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .welcome-container {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      text-align: center;
      height: 100%;
      color: var(--vscode-descriptionForeground);
      gap: 8px;
      padding: 20px;
    }
    .welcome-icon {
      color: var(--vscode-foreground);
    }
    .welcome-icon svg {
      width: 40px;
      height: 40px;
    }
    .welcome-title {
      font-size: 15px;
      font-weight: 600;
      color: var(--vscode-foreground);
    }
    .welcome-sub {
      font-size: 12px;
      line-height: 1.4;
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
    }
    .msg.error {
      background-color: var(--vscode-inputValidation-errorBackground);
      color: var(--vscode-inputValidation-errorForeground);
      border: 1px solid var(--vscode-inputValidation-errorBorder);
    }
    
    /* Copilot-style Collapsible Thought & Agent Steps */
    .agent-progress-box {
      border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
      background-color: var(--vscode-editor-background);
      border-radius: var(--radius);
      font-size: 12px;
      overflow: hidden;
      margin-bottom: 4px;
    }
    details.agent-accordion {
      padding: 8px 12px;
    }
    details.agent-accordion summary {
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--vscode-descriptionForeground);
      font-weight: 500;
      outline: none;
      user-select: none;
    }
    details.agent-accordion summary::-webkit-details-marker {
      display: none;
    }
    details.agent-accordion summary::before {
      content: "▶";
      font-size: 9px;
      transition: transform 0.2s;
    }
    details.agent-accordion[open] summary::before {
      transform: rotate(90deg);
    }
    .spinner {
      width: 12px;
      height: 12px;
      border: 2px solid var(--vscode-progressBar-background, #007acc);
      border-top-color: transparent;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    .steps-list {
      margin-top: 8px;
      padding-left: 20px;
      display: flex;
      flex-direction: column;
      gap: 4px;
      color: var(--vscode-descriptionForeground);
      font-style: italic;
    }

    .msg.activity {
      background-color: var(--vscode-editor-background);
      border: 1px dashed var(--vscode-widget-border, var(--vscode-panel-border));
      color: var(--vscode-foreground);
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      font-size: 12px;
      border-radius: var(--radius);
      margin-bottom: 4px;
    }
    .undo-btn {
      padding: 3px 8px;
      font-size: 11px;
      background: var(--vscode-button-secondaryBackground, var(--vscode-editor-inactiveSelectionBackground));
      color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
      border: none;
      border-radius: 4px;
      cursor: pointer;
      flex-shrink: 0;
    }
    .undo-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-hoverBackground));
    }
    .input-container {
      padding: 12px;
      background-color: var(--vscode-sideBar-background);
      border-top: 1px solid var(--vscode-sideBar-border, var(--vscode-panel-border));
    }
    .prompt-box {
      border: 1px solid var(--vscode-input-border, var(--vscode-widget-border));
      border-radius: var(--radius);
      background-color: var(--vscode-input-background);
      padding: 8px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .prompt-box:focus-within {
      border-color: var(--vscode-focusBorder);
    }
    .context-pill {
      display: inline-flex;
      align-items: center;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 11px;
      width: fit-content;
      gap: 4px;
    }
    .context-pill .close-btn {
      cursor: pointer;
      font-weight: bold;
      margin-left: 2px;
    }
    textarea {
      width: 100%;
      box-sizing: border-box;
      resize: none;
      height: 48px;
      background: transparent;
      border: none;
      color: var(--vscode-input-foreground);
      font-family: inherit;
      font-size: 13px;
      outline: none;
    }
    .prompt-toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-top: 1px solid var(--vscode-panel-border, rgba(255,255,255,0.06));
      padding-top: 6px;
    }
    .toolbar-left, .toolbar-right {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .tool-btn {
      background: transparent;
      border: none;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      cursor: pointer;
      padding: 3px 6px;
      border-radius: 4px;
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .tool-btn:hover {
      background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.08));
      color: var(--vscode-foreground);
    }
    .send-btn {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 4px;
      width: 24px;
      height: 24px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
    }
    .send-btn:hover {
      background: var(--vscode-button-hoverBackground);
    }
    .footer-status-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 4px 0 4px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }
    .status-item {
      display: flex;
      align-items: center;
      gap: 4px;
      cursor: pointer;
    }
    .status-item:hover {
      color: var(--vscode-foreground);
    }
    button.link-btn {
      background: transparent;
      color: var(--vscode-textLink-foreground);
      border: none;
      cursor: pointer;
      padding: 0;
      font-size: 11px;
    }
    button.link-btn:hover {
      text-decoration: underline;
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-left">
      <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M12 2L2 9l10 4 10-4-10-7z" fill="var(--vscode-symbolIcon-keywordForeground, #007acc)" opacity="0.15" />
        <path d="M2.5 10.5L20.5 3L13 21L10 13.5L2.5 10.5Z" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M20.5 3L10 13.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M18 14.5L18.8 16.2L20.5 17L18.8 17.8L18 19.5L17.2 17.8L15.5 17L17.2 16.2L18 14.5Z" fill="var(--vscode-symbolIcon-keywordForeground, #007acc)"/>
      </svg>
      <span class="header-title">FreePilot</span>
    </div>
    <button id="config" class="link-btn">Configure</button>
  </div>
  
  <div id="messages" aria-live="polite">
    <div class="welcome-container" id="welcome-view">
      <div class="welcome-icon">
        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M12 2L2 9l10 4 10-4-10-7z" fill="var(--vscode-symbolIcon-keywordForeground, #007acc)" opacity="0.15" />
          <path d="M2.5 10.5L20.5 3L13 21L10 13.5L2.5 10.5Z" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M20.5 3L10 13.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M18 14.5L18.8 16.2L20.5 17L18.8 17.8L18 19.5L17.2 17.8L15.5 17L17.2 16.2L18 14.5Z" fill="var(--vscode-symbolIcon-keywordForeground, #007acc)"/>
        </svg>
      </div>
      <div class="welcome-title">Build with FreePilot</div>
      <div class="welcome-sub">Ask me to inspect, explain, or code.</div>
    </div>
  </div>

  <div class="input-container">
    <div class="prompt-box">
      <div id="context-container"></div>
      <textarea id="prompt" placeholder="Describe what to build…"></textarea>
      <div class="prompt-toolbar">
        <div class="toolbar-left">
          <button class="tool-btn" id="btn-attach" title="Attach Active File Context">＋</button>
          <button class="tool-btn" title="Agent Mode">🤖 Agent</button>
          <button class="tool-btn" id="btn-model" title="Select FreeLLMAPI Model">Models ▾</button>
        </div>
        <div class="toolbar-right">
          <button class="send-btn" id="send" title="Send Prompt (Ctrl+Enter)">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <line x1="12" y1="19" x2="12" y2="5"></line>
              <polyline points="5 12 12 5 19 12"></polyline>
            </svg>
          </button>
        </div>
      </div>
    </div>
    <div class="footer-status-bar">
      <div class="status-item" id="status-local">
        <span>🟢 Local / API Ready</span>
      </div>
      <div class="status-item" id="status-permissions" title="Click to toggle permission mode">
        <span id="perm-label">🛡️ Default permissions</span>
      </div>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const messages = document.getElementById('messages');
    const welcomeView = document.getElementById('welcome-view');
    const promptBox = document.getElementById('prompt');
    const contextContainer = document.getElementById('context-container');
    let attachedFile = '';
    let currentProgressBox = null;
    let currentStepsList = null;
    let currentSummaryText = null;

    function addMessage(text, cls='') {
      if (welcomeView) {
        welcomeView.remove();
      }
      const el = document.createElement('div');
      el.className = 'msg ' + cls;
      el.textContent = text;
      messages.appendChild(el);
      el.scrollIntoView({ block: 'end', behavior: 'smooth' });
    }

    function addNotification(text) {
      if (welcomeView) {
        welcomeView.remove();
      }
      const el = document.createElement('div');
      el.className = 'msg status';
      el.textContent = text;
      messages.appendChild(el);
      el.scrollIntoView({ block: 'end', behavior: 'smooth' });
    }

    function handleLoading(text) {
      if (welcomeView) {
        welcomeView.remove();
      }
      if (!currentProgressBox) {
        currentProgressBox = document.createElement('div');
        currentProgressBox.className = 'agent-progress-box';

        const details = document.createElement('details');
        details.className = 'agent-accordion';
        details.open = true; // Open while working

        const summary = document.createElement('summary');
        const spinner = document.createElement('div');
        spinner.className = 'spinner';
        
        currentSummaryText = document.createElement('span');
        currentSummaryText.textContent = text;

        summary.appendChild(spinner);
        summary.appendChild(currentSummaryText);
        details.appendChild(summary);

        currentStepsList = document.createElement('div');
        currentStepsList.className = 'steps-list';
        details.appendChild(currentStepsList);

        currentProgressBox.appendChild(details);
        messages.appendChild(currentProgressBox);
      } else {
        if (currentSummaryText) {
          currentSummaryText.textContent = text;
        }
        const stepItem = document.createElement('div');
        stepItem.textContent = text;
        if (currentStepsList) {
          currentStepsList.appendChild(stepItem);
        }
      }
      currentProgressBox.scrollIntoView({ block: 'end', behavior: 'smooth' });
    }

    function finalizeProgress(successText = "Agent finished successfully") {
      if (currentProgressBox) {
        const details = currentProgressBox.querySelector('details');
        const spinner = currentProgressBox.querySelector('.spinner');
        if (spinner) {
          spinner.remove(); // Remove spinner when done
        }
        if (currentSummaryText) {
          currentSummaryText.textContent = successText;
        }
        if (details) {
          details.open = false; // Automatically minimize/collapse like Copilot!
        }
        currentProgressBox = null;
        currentStepsList = null;
        currentSummaryText = null;
      }
    }

    function addActivityMessage(data) {
      if (welcomeView) {
        welcomeView.remove();
      }
      const el = document.createElement('div');
      el.className = 'msg activity';
      
      const span = document.createElement('span');
      span.textContent = data.text;
      el.appendChild(span);

      if (data.undoable) {
        const id = 'undo-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
        el.dataset.undoId = id;
        const btn = document.createElement('button');
        btn.className = 'undo-btn';
        btn.textContent = 'Undo';
        btn.addEventListener('click', () => {
          btn.disabled = true;
          btn.textContent = 'Undoing…';
          vscode.postMessage({
            type: 'undo',
            id: id,
            path: data.path,
            oldContent: data.oldContent,
            existedBefore: data.existedBefore
          });
        });
        el.appendChild(btn);
      }

      messages.appendChild(el);
      el.scrollIntoView({ block: 'end', behavior: 'smooth' });
    }

    function handleUndoSuccess(id) {
      const el = document.querySelector('[data-undo-id="' + id + '"]');
      if (el) {
        const btn = el.querySelector('.undo-btn');
        if (btn) {
          btn.textContent = 'Undone';
          btn.disabled = true;
        }
      }
    }

    document.getElementById('send').addEventListener('click', () => {
      let text = promptBox.value.trim();
      if (!text) return;
      if (attachedFile) {
        text = 'Context file: ' + attachedFile + '\\n\\n' + text;
      }
      addMessage(text, 'user');
      promptBox.value = '';
      attachedFile = '';
      contextContainer.innerHTML = '';
      vscode.postMessage({ type: 'ask', text });
    });

    document.getElementById('config').addEventListener('click', () => {
      vscode.postMessage({ type: 'configure' });
    });

    document.getElementById('btn-model').addEventListener('click', () => {
      vscode.postMessage({ type: 'selectModel' });
    });

    document.getElementById('btn-attach').addEventListener('click', () => {
      vscode.postMessage({ type: 'attachContext' });
    });

    document.getElementById('status-permissions').addEventListener('click', () => {
      vscode.postMessage({ type: 'togglePermission' });
    });

    promptBox.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        document.getElementById('send').click();
      }
    });

    window.addEventListener('message', event => {
      const m = event.data;
      if (m.type === 'loading') {
        handleLoading(m.text);
      }
      else if (m.type === 'notification') {
        addNotification(m.text);
      }
      else if (m.type === 'activity') {
        addActivityMessage(m);
      }
      else if (m.type === 'undoSuccess') {
        handleUndoSuccess(m.id);
      }
      else if (m.type === 'contextAttached') {
        attachedFile = m.path;
        contextContainer.innerHTML = '';
        const pill = document.createElement('div');
        pill.className = 'context-pill';
        pill.textContent = '📄 ' + m.path + ' ';
        const closeBtn = document.createElement('span');
        closeBtn.className = 'close-btn';
        closeBtn.textContent = '×';
        closeBtn.addEventListener('click', () => {
          contextContainer.innerHTML = '';
          attachedFile = '';
        });
        pill.appendChild(closeBtn);
        contextContainer.appendChild(pill);
      }
      else if (m.type === 'permissionUpdated') {
        document.getElementById('perm-label').textContent = '🛡️ ' + m.mode;
      }
      else if (m.type === 'assistant' || m.type === 'answer') {
        finalizeProgress("Thought & completed steps");
        addMessage(m.text, 'assistant');
      }
      else if (m.type === 'error') {
        finalizeProgress("Agent encountered an error");
        addMessage(m.text, 'error');
      }
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