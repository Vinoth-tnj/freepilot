import * as vscode from "vscode";
import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";

type ToolName = "list_files" | "read_file" | "search_code" | "propose_file_change";
type ToolArgs = Record<string, unknown>;

export interface ActivityData {
  undoable?: boolean;
  path?: string;
  oldContent?: string;
  existedBefore?: boolean;
}

export type ProgressReportFn = (message: string, activity?: ActivityData) => void;

const tools: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List workspace files (respects ignore patterns).",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Optional filename/path substring filter." },
          limit: { type: "integer", description: "Maximum results, at most 100." }
        },
        required: [],
        additionalProperties: false
      },
      "strict": false
    }
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a UTF-8 text file inside the active workspace.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" }
        },
        required: ["path"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "search_code",
      description: "Search text in workspace files.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "integer" }
        },
        required: ["query"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "propose_file_change",
      description: "Propose creating or replacing a text file. For existing files, provide the complete intended file content.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
          reason: { type: "string" }
        },
        required: ["path", "content", "reason"],
        additionalProperties: false
      }
    }
  }
];

export class Agent {
  private client: OpenAI;
  private model: string;
  private maxSteps: number;

  constructor(client: OpenAI, model: string, maxSteps: number) {
    this.client = client;
    this.model = model;
    this.maxSteps = maxSteps;
  }

  /**
   * Fetches only active/ready models from FreeLLMAPI via `/v1/models?available=true`.
   */
  public async listModels(): Promise<string[]> {
    const config = vscode.workspace.getConfiguration("freepilot");
    let baseUrl = config.get<string>("baseUrl", "http://127.0.0.1:31415").trim();
    if (!baseUrl.endsWith("/v1") && !baseUrl.endsWith("/v1/")) {
      baseUrl = baseUrl.replace(/\/+$/, "") + "/v1";
    }

    try {
      // Fetch available/ready models directly from FreeLLMAPI REST endpoint
      const res = await fetch(`${baseUrl}/models?available=true`);
      if (res.ok) {
        const body = (await res.json()) as { data?: Array<{ id: string }> };
        if (body.data && Array.isArray(body.data)) {
          const models = body.data.map(m => m.id).filter(Boolean);
          if (models.length > 0) {
            return models;
          }
        }
      }
    } catch {
      // Ignore network errors and fall back
    }
    return ["auto"];
  }

  async run(
    userRequest: string,
    report: ProgressReportFn
  ): Promise<string> {
    const messages: ChatCompletionMessageParam[] = [
      {
        role: "system",
        content: `You are FreePilot, a careful coding agent inside VS Code.
You can inspect the active workspace using tools and propose file changes.
Workflow: inspect relevant files, explain a concise plan, then use propose_file_change for each file you want to create or modify.
Never claim a change was applied unless reported as such.
Keep context focused. Do not read secrets, .env files, private keys, credentials, binaries, or files outside the workspace.
Use relative workspace paths. Avoid destructive changes. If requirements are ambiguous, ask a question.
For existing files, read them first and propose complete updated content. Keep changes minimal.
You may use list_files, read_file, search_code, and propose_file_change.`
      },
      {
        role: "user",
        content: userRequest
      }
    ];

    const maxSteps = Math.min(
      Math.max(this.maxSteps, 1),
      20
    );

    for (let step = 0; step < maxSteps; step++) {
      report(`Step ${step + 1}/${maxSteps}: Waiting for model response…`);

      let completion;
      try {
        completion = await this.client.chat.completions.create({
          model: this.model,
          messages,
          tools,
          tool_choice: "auto"
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        report(`Model request failed: ${detail}`);
        throw new Error(`FreeLLMAPI request failed at step ${step + 1}: ${detail}`);
      }

      const msg = completion.choices?.[0]?.message;
      if (!msg) {
        throw new Error("FreeLLMAPI returned no assistant message.");
      }
      messages.push(msg);

      if (!msg.tool_calls?.length) {
        const answer = msg.content?.trim();
        if (answer) {
          report("Response received.");
          return answer;
        }
        throw new Error(
          "The model returned neither text nor tool calls. " +
          "Check the model's response format and FreeLLMAPI logs."
        );
      }

      for (const call of msg.tool_calls) {
        if (call.type !== "function") continue;
        report(`Running tool: ${call.function.name} (step ${step + 1}/${maxSteps})…`);
        let result: string;
        try {
          const args = JSON.parse(call.function.arguments || "{}") as ToolArgs;
          result = await this.executeTool(call.function.name as ToolName, args, report);
        } catch (error) {
          result = JSON.stringify({
            error: error instanceof Error ? error.message : String(error)
          });
        }
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: result
        });
        report(`Tool finished: ${call.function.name}`);
      }
    }

    return `Stopped after ${maxSteps} agent steps. Ask me to continue if needed.`;
  }

  private getRoot(): vscode.Uri {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) throw new Error("Open a project folder in VS Code first.");
    return folders[0].uri;
  }

  private async resolveSafe(pathValue: unknown): Promise<vscode.Uri> {
    if (typeof pathValue !== "string" || !pathValue.trim()) throw new Error("A relative path is required.");
    const rel = pathValue.replace(/\\/g, "/");
    if (rel.startsWith("/") || /^[a-zA-Z]:/.test(rel) || rel.split("/").some(p => p === "..") || rel.includes("\0")) {
      throw new Error("Path must stay inside the workspace.");
    }
    if (rel.split("/").some(p => [".env", ".ssh", ".aws"].includes(p) || p.endsWith(".pem") || p.endsWith(".key"))) {
      throw new Error("Access to likely secret files is blocked.");
    }
    const root = this.getRoot();
    const target = vscode.Uri.joinPath(root, rel);
    return target;
  }

  private async executeTool(name: ToolName, args: ToolArgs, report: ProgressReportFn): Promise<string> {
    if (name === "list_files") {
      const query = typeof args.query === "string" ? args.query.toLowerCase() : "";
      const limit = Math.min(Math.max(Number(args.limit) || 60, 1), 100);
      const uris = await vscode.workspace.findFiles(
        "**/*",
        "**/{.git,node_modules,dist,build,out,.venv}/**",
        limit
      );
      const result = uris
        .map(u => vscode.workspace.asRelativePath(u))
        .filter(p => !query || p.toLowerCase().includes(query));
      return JSON.stringify(result);
    }

    if (name === "read_file") {
      const uri = await this.resolveSafe(args.path);
      const bytes = await vscode.workspace.fs.readFile(uri);
      if (bytes.byteLength > 120_000) throw new Error("File is larger than the 120 KB read limit.");
      const content = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      if (content.includes("\0")) throw new Error("Binary-looking files cannot be read.");
      return JSON.stringify({ path: args.path, content: content.slice(0, 60_000) });
    }

    if (name === "search_code") {
      const query = String(args.query || "");
      if (!query.trim() || query.length > 200) throw new Error("Search query must be 1-200 characters.");
      const limit = Math.min(Math.max(Number(args.limit) || 30, 1), 50);
      const uris = await vscode.workspace.findFiles(
        "**/*",
        "**/{.git,node_modules,dist,build,out,.venv,.env}/**",
        500
      );
      const hits: Array<{ path: string; line: number; text: string }> = [];
      for (const uri of uris) {
        if (hits.length >= limit) break;
        const path = vscode.workspace.asRelativePath(uri);
        if (/\.(png|jpg|jpeg|gif|pdf|zip|so|a|o|bin|pem|key)$/i.test(path)) continue;
        let text: string;
        try {
          const bytes = await vscode.workspace.fs.readFile(uri);
          if (bytes.byteLength > 150_000) continue;
          text = new TextDecoder().decode(bytes);
          if (text.includes("\0")) continue;
        } catch {
          continue;
        }
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length && hits.length < limit; i++) {
          if (lines[i].toLowerCase().includes(query.toLowerCase())) {
            hits.push({ path, line: i + 1, text: lines[i].slice(0, 300) });
          }
        }
      }
      return JSON.stringify(hits);
    }

    if (name === "propose_file_change") {
      const uri = await this.resolveSafe(args.path);
      const content = args.content;
      if (typeof content !== "string") throw new Error("File content must be a string.");
      if (content.length > 200_000) throw new Error("Proposed file exceeds the 200 KB limit.");
      const exists = await vscode.workspace.fs.stat(uri).then(() => true, () => false);
      const oldText = exists ? new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)) : "";

      const config = vscode.workspace.getConfiguration("freepilot");
      const applyMode = config.get<string>("applyMode", "manual");

      if (applyMode === "auto") {
        const parent = vscode.Uri.joinPath(uri, "..");
        await vscode.workspace.fs.createDirectory(parent);
        await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
        report(`Auto-applied change to ${args.path}`, {
          undoable: true,
          path: String(args.path),
          oldContent: oldText,
          existedBefore: exists
        });
        return JSON.stringify({ status: "applied", path: args.path });
      }

      const choice = await vscode.window.showWarningMessage(
        `\`${exists ? "Replace" : "Create"} ${String(args.path)}? Reason: ${String(args.reason).slice(0, 250)}\``,
        { modal: true, detail: `\`Proposed content: ${content.length} characters. Review the file diff before approving.\`` },
        "Review & Apply"
      );
      if (choice !== "Review & Apply") return JSON.stringify({ status: "rejected", path: args.path });
      const language = this.guessLanguage(String(args.path));
      const doc = await vscode.workspace.openTextDocument({ language, content: oldText });
      const proposed = await vscode.workspace.openTextDocument({ language, content });
      await vscode.commands.executeCommand("vscode.diff", doc.uri, proposed.uri, `FreePilot proposal: ${args.path}`);
      const confirm = await vscode.window.showInformationMessage(
        `\`Apply proposed content to ${String(args.path)}?\``,
        { modal: true },
        "Apply Change"
      );
      if (confirm !== "Apply Change") return JSON.stringify({ status: "not applied", path: args.path });
      const parent = vscode.Uri.joinPath(uri, "..");
      await vscode.workspace.fs.createDirectory(parent);
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
      report(`Applied ${exists ? "update" : "new file"}: ${args.path}`);
      return JSON.stringify({ status: "applied", path: args.path });
    }

    throw new Error(`Unknown tool: ${name}`);
  }

  private guessLanguage(path: string): string {
    const ext = path.split(".").pop()?.toLowerCase();
    const map: Record<string, string> = {
      ts: "typescript",
      js: "javascript",
      cpp: "cpp",
      cc: "cpp",
      h: "cpp",
      hpp: "cpp",
      c: "c",
      py: "python",
      json: "json",
      md: "markdown",
      yml: "yaml",
      yaml: "yaml",
      xml: "xml",
      sh: "shellscript"
    };
    return map[ext || ""] || "plaintext";
  }
}