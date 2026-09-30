import { AssistantMessageComponent, BranchSummaryMessageComponent, CompactionSummaryMessageComponent, createBashToolDefinition, createEditToolDefinition, createFindToolDefinition, createGrepToolDefinition, createLsToolDefinition, createPowerShellToolDefinition, createReadToolDefinition, createWriteToolDefinition, CustomMessageComponent, getMarkdownTheme, UserMessageComponent, ToolExecutionComponent, type Theme } from "@earendil-works/pi-coding-agent";
import { Input, Text, matchesKey, truncateToWidth, type Component, type Focusable } from "@earendil-works/pi-tui";
import { MultiagentRuntime, childSessionCost, type Child, type AssistantMessage } from "./runtime.js";
import { INCOMING_MAIL, renderIncomingMail } from "./mailbox.js";
type TUI = ConstructorParameters<typeof ToolExecutionComponent>[5];

/** Separate display-only conversation; never rewrites the parent session/context. */
export class MultiagentView implements Component, Focusable {
  private input = new Input();
  private selected: string;
  private offset = 0;
  private mode: "steer" | "followUp" = "steer";
  private expanded = false;
  private notice = "";
  private unsubscribe: () => void;
  private timer?: NodeJS.Timeout;
  private components?: Component[];
  private busy = false;
  private disposed = false;
  get focused() { return this.input.focused; }
  set focused(value: boolean) { this.input.focused = value; }
  constructor(private runtime: MultiagentRuntime, id: string, private tui: TUI, private theme: Theme, private done: () => void) {
    this.selected = id;
    this.input.onSubmit = text => {
      if (!text.trim() || this.busy) return;
      const target = this.selected;
      void this.act(async () => { await runtime.send(target, text, this.mode); this.input.setValue(""); this.offset = 0; });
    };
    this.unsubscribe = runtime.subscribe(() => {
      this.components = undefined;
      if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; if (!this.disposed) tui.requestRender(); }, 80);
    });
  }
  private async act(action: () => Promise<void>) {
    if (this.busy) return;
    this.busy = true; this.notice = ""; this.tui.requestRender();
    try { await action(); } catch (error) { this.notice = (error as Error).message; }
    finally { this.busy = false; if (!this.disposed) this.tui.requestRender(); }
  }
  invalidate() { this.components = undefined; this.input.invalidate(); }
  dispose() { this.disposed = true; this.unsubscribe(); if (this.timer) clearTimeout(this.timer); }
  handleInput(data: string) {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) { this.done(); return; }
    if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
      const ids = [...this.runtime.children.keys()];
      const delta = matchesKey(data, "shift+tab") ? -1 : 1;
      this.selected = ids[(ids.indexOf(this.selected) + delta + ids.length) % ids.length]!;
      this.offset = 0; this.components = undefined; this.notice = "";
      void this.act(async () => { await this.runtime.connect(this.selected); });
    } else if (matchesKey(data, "ctrl+s")) void this.act(() => this.runtime.stop(this.selected));
    else if (matchesKey(data, "ctrl+t")) this.mode = this.mode === "steer" ? "followUp" : "steer";
    else if (matchesKey(data, "ctrl+o")) { this.expanded = !this.expanded; this.components = undefined; }
    else if (matchesKey(data, "pageUp")) this.offset += Math.max(1, this.tui.terminal.rows - 8);
    else if (matchesKey(data, "pageDown")) this.offset = Math.max(0, this.offset - Math.max(1, this.tui.terminal.rows - 8));
    else this.input.handleInput(data);
    this.tui.requestRender();
  }
  private history(child: Child): Component[] {
    const components: Component[] = [];
    const tools = new Map<string, ToolExecutionComponent>();
    const builtInRenderers: Record<string, any> = {
      bash: createBashToolDefinition(child.cwd), edit: createEditToolDefinition(child.cwd), find: createFindToolDefinition(child.cwd),
      grep: createGrepToolDefinition(child.cwd), ls: createLsToolDefinition(child.cwd), powershell: createPowerShellToolDefinition(child.cwd),
      read: createReadToolDefinition(child.cwd), write: createWriteToolDefinition(child.cwd),
    };
    const messages = child.partial ? [...child.messages, child.partial] : child.messages;
    for (const message of messages) {
      if (message.role === "user") {
        const text = typeof message.content === "string" ? message.content : message.content.map(p => p.type === "text" ? p.text : "[image]").join("\n");
        components.push(new UserMessageComponent(text, getMarkdownTheme()));
      } else if (message.role === "assistant") {
        // Sparse in-flight content arrays are valid while blocks arrive.
        const assistant = { ...message, content: message.content.filter(Boolean) } as AssistantMessage;
        const component = new AssistantMessageComponent(assistant, true, getMarkdownTheme());
        if (message === child.partial) component.updateContent(assistant, true);
        components.push(component);
        for (const part of assistant.content) if (part.type === "toolCall") {
          const fallbackRenderer = {
            renderCall: (args: unknown, theme: Theme) => {
              const fields = args && typeof args === "object" ? Object.entries(args as Record<string, unknown>) : [["input", args]];
              const readable = fields.map(([key, value]) => `${key}: ${typeof value === "string" ? value : Array.isArray(value) ? `[${value.length} items]` : value && typeof value === "object" ? "{…}" : String(value)}`).join(" · ");
              return new Text(theme.fg("toolTitle", `${part.name}${readable ? ` · ${readable}` : ""}`), 0, 0);
            },
          };
          const tool = new ToolExecutionComponent(part.name, part.id, part.arguments, { showImages: false }, builtInRenderers[part.name] ?? fallbackRenderer, this.tui, child.cwd);
          tool.setArgsComplete(); tool.setExpanded(this.expanded);
          const progress = child.tools.get(part.id);
          if (progress) {
            tool.markExecutionStarted();
            if (progress.result) tool.updateResult({ ...progress.result, isError: progress.result.isError ?? false }, progress.isPartial);
          }
          tools.set(part.id, tool); components.push(tool);
        }
      } else if (message.role === "toolResult") {
        const tool = tools.get(message.toolCallId);
        if (tool) tool.updateResult(message);
        else components.push(new Text(`${message.toolName}\n${message.content.filter(p => p.type === "text").map(p => p.text).join("\n")}`, 1, 0));
      } else if (message.role === "compactionSummary") {
        components.push(new CompactionSummaryMessageComponent(message, getMarkdownTheme()));
      } else if (message.role === "branchSummary") {
        components.push(new BranchSummaryMessageComponent(message, getMarkdownTheme()));
      } else if (message.role === "custom" && message.display) {
        const renderer = message.customType === INCOMING_MAIL ? renderIncomingMail : undefined;
        components.push(new CustomMessageComponent(message, renderer, getMarkdownTheme()));
      }
    }
    return components;
  }
  render(width: number): string[] {
    const child = this.runtime.get(this.selected);
    const tabs = [...this.runtime.children.values()].map(c => `${c.id === child.id ? "▸" : " "}${c.agent}:${c.id} ${c.status}`).join("  ");
    const input = this.input.render(width);
    const queueLines = [
      ...child.queue.steering.map(text => `Steer queued: ${text}`),
      ...child.queue.followUp.map(text => `Follow-up queued: ${text}`),
    ].map(text => truncateToWidth(this.theme.fg("warning", text.replace(/\s+/g, " ")), width));
    const height = Math.max(1, this.tui.terminal.rows - input.length - 5 - queueLines.length);
    this.components ??= this.history(child);
    const history = this.components.flatMap(c => c.render(width));
    const offset = Math.min(this.offset, Math.max(0, history.length - height));
    const end = history.length - offset;
    const visible = history.slice(Math.max(0, end - height), end);
    while (visible.length < height) visible.unshift("");
    const queued = child.queue.steering.length + child.queue.followUp.length;
    const latestAssistant = [...child.messages, ...(child.partial ? [child.partial] : [])].reverse().find(message => message.role === "assistant") as AssistantMessage | undefined;
    const model = latestAssistant?.provider && latestAssistant?.model
      ? `${latestAssistant.provider}/${latestAssistant.model}` : child.model ? `requested ${child.model}` : "unknown until first response";
    const cost = childSessionCost(child);
    return [
      truncateToWidth(this.theme.fg("accent", tabs), width),
      truncateToWidth(`Model: ${model} · Session cost: ${cost === undefined ? "unknown" : `$${cost.toFixed(4)}`}`, width),
      ...visible,
      ...queueLines,
      truncateToWidth(this.theme.fg("muted", `Tab agent · PgUp/PgDn scroll · Ctrl+O tools · Ctrl+S stop · Ctrl+T mode · Esc parent`), width),
      truncateToWidth(this.notice || child.error || `${this.busy ? "Sending… " : ""}${this.mode === "steer" ? "Steer / send" : "Follow-up / send"} to ${child.agent} (${queued} queued). Enter submits.`, width),
      ...input,
      "",
    ];
  }
}
