import * as vscode from "vscode";
import OpenAI from "openai";
import { Agent } from "./agent";
import { ChatViewProvider } from "./ui/chatView";

const SECRET_KEY = "";

export function activate(context: vscode.ExtensionContext) {
  console.log("[FreePilot] Extension activated");
  const provider = new ChatViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("freepilot.chatView", provider, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode.commands.registerCommand("freepilot.openChat", async () => {
      await vscode.commands.executeCommand("workbench.view.extension.freepilot");
    }),
    vscode.commands.registerCommand("freepilot.configure", async () => {
      const key = await vscode.window.showInputBox({
        title: "FreeLLMAPI API key",
        prompt: "Enter the unified key from your FreeLLMAPI dashboard",
        password: true,
        ignoreFocusOut: true
      });
      if (key?.trim()) {
        await context.secrets.store(SECRET_KEY, key.trim());
        vscode.window.showInformationMessage("FreePilot API key saved securely.");
      }
    })
  );

  provider.setAgentFactory(async () => {
    const apiKey = await context.secrets.get(SECRET_KEY);
    if (!apiKey) {
      const choice = await vscode.window.showWarningMessage(
        "Configure your FreeLLMAPI key before using FreePilot.",
        "Configure Key"
      );
      if (choice === "Configure Key") {
        await vscode.commands.executeCommand("freepilot.configure");
      }
      throw new Error("API key is not configured. Run FreePilot: Configure.");
    }
    const config = vscode.workspace.getConfiguration("freepilot");
    const client = new OpenAI({
      apiKey,
      baseURL: config.get<string>("baseUrl", ""),
      timeout: 300_000,
      maxRetries: 1
    });
    return new Agent(client, config.get<string>("model", "auto"), config.get<number>("maxAgentSteps", 8));
  });
}
export function deactivate() {}