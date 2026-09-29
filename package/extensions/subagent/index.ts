/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message, Usage } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	getAgentDir,
	getMarkdownTheme,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";
import { emptyUsage, sumUsage, UsageTracker } from "./usage.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const PER_TASK_OUTPUT_CAP = 50 * 1024;
const PREVIEW_CAP = 240;
const UPDATE_INTERVAL_MS = 150;

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.turns || usage.input || usage.output || usage.cacheRead || usage.cacheWrite || usage.cost) {
		parts.push(`$${usage.cost.toFixed(4)}`);
	}
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

type RunStatus = "queued" | "running" | "completed" | "failed";

interface ProgressNode {
	id: string;
	agent: string;
	status: RunStatus;
	startedAt?: number;
	finishedAt?: number;
	usage: UsageStats;
	activity?: string;
	children: ProgressNode[];
}

interface SingleResult {
	id: string;
	status: RunStatus;
	startedAt?: number;
	finishedAt?: number;
	activity?: string;
	currentTool?: { id: string; name: string; args: Record<string, unknown> };
	children: ProgressNode[];
	tokenUsage: Usage;
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

function isFailedResult(result: SingleResult): boolean {
	return result.status === "failed" || (result.status === "completed" && (result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted"));
}

function usageStats(usage: Usage, turns: number, contextTokens: number): UsageStats {
	return {
		input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite,
		cost: usage.cost.total, contextTokens, turns,
	};
}

function totalUsage(results: SingleResult[]): Usage {
	// Each root already includes the usage of its descendants. Do not sum the tree.
	return sumUsage(...results.map((result) => result.tokenUsage));
}

function reportedToolUsage(result: any, toolName: string): Usage | undefined {
	if (result?.usage) return result.usage;
	// Older Pi versions or tool-result hooks may strip the optional usage field.
	// Our details still carry one inclusive total per root lane.
	if (toolName === "subagent" && Array.isArray(result?.details?.results)) {
		return sumUsage(...result.details.results.map((r: SingleResult) => r.tokenUsage));
	}
	return undefined;
}

function summarizeNested(details: unknown, parentId: string, callId: string): ProgressNode[] {
	if (!details || typeof details !== "object" || !Array.isArray((details as SubagentDetails).results)) return [];
	return (details as SubagentDetails).results.map((result, index) => ({
		id: `${parentId}/${callId}/${index + 1}`,
		agent: result.agent,
		status: result.status ?? (result.exitCode === -1 ? "running" : result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted" ? "failed" : "completed"),
		startedAt: result.startedAt,
		finishedAt: result.finishedAt,
		usage: result.usage,
		activity: result.currentTool ? `using ${result.currentTool.name}` : result.activity,
		children: (result.children || []).map((child) => prefixChildId(child, `${parentId}/${callId}/${index + 1}`)),
	}));
}

function prefixChildId(child: ProgressNode, parentId: string): ProgressNode {
	return { ...child, id: `${parentId}/${child.id}`, children: child.children.map((c) => prefixChildId(c, parentId)) };
}

function statusIcon(status: RunStatus): string {
	return status === "running" ? "⏳" : status === "queued" ? "·" : status === "failed" ? "✗" : "✓";
}

function makeResult(id: string, agent: string, task: string, status: RunStatus, step?: number): SingleResult {
	return {
		id, agent, task, status, step, agentSource: "unknown", exitCode: status === "failed" ? 1 : -1,
		messages: [], stderr: "", children: [], tokenUsage: emptyUsage(),
		usage: usageStats(emptyUsage(), 0, 0),
	};
}

function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}

function truncateParallelOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

	let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output preserved in tool details.]`;
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

async function runSingleAgent(
	defaultCwd: string,
	id: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		const failed = makeResult(id, agentName, task, "failed", step);
		failed.stderr = `Unknown agent: "${agentName}". Available agents: ${available}.`;
		return failed;
	}

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (agent.model) args.push("--model", agent.model);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult = makeResult(id, agentName, task, "running", step);
	currentResult.agentSource = agent.source;
	currentResult.model = agent.model;
	currentResult.startedAt = Date.now();
	const tracker = new UsageTracker();
	const activeTools = new Map<string, { id: string; name: string; args: Record<string, unknown> }>();
	const nestedTools = new Map<string, ProgressNode[]>();
	let turns = 0;
	let contextTokens = 0;
	let lastUpdate = 0;
	let pendingUpdate: NodeJS.Timeout | undefined;
	let heartbeat: NodeJS.Timeout | undefined;

	const refresh = () => {
		currentResult.tokenUsage = tracker.total;
		currentResult.usage = usageStats(currentResult.tokenUsage, turns, contextTokens);
		currentResult.currentTool = [...activeTools.values()].at(-1);
		currentResult.children = [...nestedTools.values()].flat();
	};

	const emitUpdate = (immediate = false) => {
		if (!onUpdate) return;
		const now = Date.now();
		if (!immediate && now - lastUpdate < UPDATE_INTERVAL_MS) {
			if (!pendingUpdate) pendingUpdate = setTimeout(() => {
				pendingUpdate = undefined;
				emitUpdate(true);
			}, UPDATE_INTERVAL_MS - (now - lastUpdate));
			return;
		}
		if (pendingUpdate) clearTimeout(pendingUpdate);
		pendingUpdate = undefined;
		refresh();
		lastUpdate = now;
		const snapshot = { ...currentResult, messages: currentResult.messages.slice(-20), usage: { ...currentResult.usage }, children: [...currentResult.children] };
		onUpdate({
			content: [{ type: "text", text: getFinalOutput(snapshot.messages) || "(running...)" }],
			details: makeDetails([snapshot]),
			usage: snapshot.tokenUsage,
		});
	};

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${task}`);
		let wasAborted = false;

		emitUpdate(true);
		heartbeat = setInterval(() => emitUpdate(true), 1000);
		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? defaultCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let buffer = "";
			const decoder = new StringDecoder("utf8");
			let streamText = "";
			let killTimer: NodeJS.Timeout | undefined;

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_start" && event.message?.role === "assistant") streamText = "";
				if (event.type === "message_update") {
					tracker.previewAssistant(event.usage);
					if (event.assistantMessageEvent?.type === "text_delta") {
						streamText = (streamText + event.assistantMessageEvent.delta).slice(-PREVIEW_CAP);
						currentResult.activity = streamText.trim();
					}
					emitUpdate();
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					if (msg.role === "assistant") {
						currentResult.messages.push(msg);
						turns++;
						tracker.completeAssistant(msg.usage);
						contextTokens = msg.usage?.totalTokens || contextTokens;
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
						const text = msg.content.find((part) => part.type === "text");
						if (text?.type === "text") currentResult.activity = text.text.slice(-PREVIEW_CAP).trim();
					}
					emitUpdate();
				}

				if (event.type === "tool_execution_start") {
					activeTools.set(event.toolCallId, { id: event.toolCallId, name: event.toolName, args: event.args || {} });
					emitUpdate(true);
				}
				if (event.type === "tool_execution_update" || event.type === "tool_execution_end") {
					const result = event.type === "tool_execution_end" ? event.result : event.partialResult;
					const toolUsage = reportedToolUsage(result, event.toolName);
					if (event.type === "tool_execution_end") tracker.finishTool(event.toolCallId, toolUsage);
					else tracker.updateTool(event.toolCallId, toolUsage);
					if (event.toolName === "subagent" && result?.details) {
						nestedTools.set(event.toolCallId, summarizeNested(result.details, id, event.toolCallId));
					}
					if (event.type === "tool_execution_end") activeTools.delete(event.toolCallId);
					emitUpdate(event.type === "tool_execution_end");
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += decoder.write(data);
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			const killProc = () => {
				wasAborted = true;
				proc.kill("SIGTERM");
				killTimer = setTimeout(() => {
					if (proc.exitCode === null) proc.kill("SIGKILL");
				}, 5000);
			};
			proc.on("close", (code) => {
				if (killTimer) clearTimeout(killTimer);
				signal?.removeEventListener("abort", killProc);
				buffer += decoder.end();
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 1);
			});

			proc.on("error", (error) => {
				currentResult.stderr += error.message;
				resolve(1);
			});

			if (signal) {
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		currentResult.status = wasAborted || exitCode !== 0 || currentResult.stopReason === "error" || currentResult.stopReason === "aborted"
			? "failed" : "completed";
		currentResult.finishedAt = Date.now();
		refresh(); // Accounting must work even when the caller does not subscribe to updates.
		emitUpdate(true);
		if (wasAborted) throw new Error("Subagent was aborted");
		return currentResult;
	} finally {
		if (pendingUpdate) clearTimeout(pendingUpdate);
		if (heartbeat) clearInterval(heartbeat);
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
});

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			`Default agent scope is "user" (from ${path.join(getAgentDir(), "agents")}).`,
			`To enable project-local agents in ${CONFIG_DIR_NAME}/agents, set agentScope: "both" (or "project").`,
		].join(" "),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
				});

			if (modeCount !== 1) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
				if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
				}
			}

			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

					// Create update callback that includes all previous results
					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								// Combine completed results with current streaming result
								const currentResult = partial.details?.results[0];
								if (currentResult) {
									const allResults = [...results, currentResult];
									onUpdate({
										content: partial.content,
										details: makeDetails("chain")(allResults),
										usage: totalUsage(allResults),
									});
								}
							}
						: undefined;

					const result = await runSingleAgent(
						ctx.cwd,
						`${_toolCallId}/${i + 1}`,
						agents,
						step.agent,
						taskWithContext,
						step.cwd,
						i + 1,
						signal,
						chainUpdate,
						makeDetails("chain"),
					);
					results.push(result);

					const isError = isFailedResult(result);
					if (isError) {
						const errorMsg = getResultOutput(result);
						return {
							content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}` }],
							details: makeDetails("chain")(results),
							usage: totalUsage(results),
							isError: true,
						};
					}
					previousOutput = getFinalOutput(result.messages);
				}
				return {
					content: [{ type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" }],
					details: makeDetails("chain")(results),
					usage: totalUsage(results),
				};
			}

			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS)
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: makeDetails("parallel")([]),
					};

				// Track all results for streaming updates
				const allResults: SingleResult[] = new Array(params.tasks.length);

				// Initialize placeholder results
				for (let i = 0; i < params.tasks.length; i++) {
					allResults[i] = makeResult(`${_toolCallId}/${i + 1}`, params.tasks[i].agent, params.tasks[i].task, "queued");
				}

				const emitParallelUpdate = () => {
					if (onUpdate) {
						const running = allResults.filter((r) => r.status === "running").length;
						const done = allResults.filter((r) => r.status === "completed" || r.status === "failed").length;
						const queued = allResults.length - done - running;
						onUpdate({
							content: [
								{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running, ${queued} queued...` },
							],
							details: makeDetails("parallel")([...allResults]),
							usage: totalUsage(allResults),
						});
					}
				};

				emitParallelUpdate();
				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
					const result = await runSingleAgent(
						ctx.cwd,
						`${_toolCallId}/${index + 1}`,
						agents,
						t.agent,
						t.task,
						t.cwd,
						undefined,
						signal,
						// Per-task update callback
						(partial) => {
							if (partial.details?.results[0]) {
								allResults[index] = partial.details.results[0];
								emitParallelUpdate();
							}
						},
						makeDetails("parallel"),
					);
					allResults[index] = result;
					emitParallelUpdate();
					return result;
				});

				const successCount = results.filter((r) => !isFailedResult(r)).length;
				const summaries = results.map((r) => {
					const output = truncateParallelOutput(getResultOutput(r));
					const status = isFailedResult(r)
						? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
						: "completed";
					return `### [${r.agent}] ${status}\n\n${output}`;
				});
				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
						},
					],
					details: makeDetails("parallel")(results),
					usage: totalUsage(results),
				};
			}

			if (params.agent && params.task) {
				const result = await runSingleAgent(
					ctx.cwd,
					`${_toolCallId}/1`,
					agents,
					params.agent,
					params.task,
					params.cwd,
					undefined,
					signal,
					onUpdate,
					makeDetails("single"),
				);
				const isError = isFailedResult(result);
				if (isError) {
					const errorMsg = getResultOutput(result);
					return {
						content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
						details: makeDetails("single")([result]),
						usage: result.tokenUsage,
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
					details: makeDetails("single")([result]),
					usage: result.tokenUsage,
				};
			}

			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: makeDetails("single")([]),
			};
		},

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "user";
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					// Clean up {previous} placeholder for display
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", step.agent) +
						theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`);
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || "...";
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			const elapsed = (r: SingleResult): string => r.startedAt
				? ` ${Math.floor(((r.finishedAt ?? Date.now()) - r.startedAt) / 1000)}s` : "";
			const activity = (r: SingleResult): string => r.currentTool
				? formatToolCall(r.currentTool.name, r.currentTool.args, theme.fg.bind(theme))
				: theme.fg("muted", (r.activity || (r.status === "queued" ? "queued" : "waiting for output")).replace(/\s+/g, " ").slice(0, PREVIEW_CAP));
			const renderChildren = (nodes: ProgressNode[], depth = 1): string => nodes.map((node) => {
				const indent = "  ".repeat(depth);
				const duration = node.startedAt ? ` ${Math.floor(((node.finishedAt ?? Date.now()) - node.startedAt) / 1000)}s` : "";
				const line = `${indent}↳ ${statusIcon(node.status)} ${node.agent}${duration} ${theme.fg("dim", `↑${formatTokens(node.usage.input)} ↓${formatTokens(node.usage.output)} $${node.usage.cost.toFixed(4)}${node.children.length ? " (incl. nested)" : ""}`)}`;
				const recent = node.activity ? `\n${indent}  ${theme.fg("muted", node.activity.replace(/\s+/g, " ").slice(0, PREVIEW_CAP))}` : "";
				return line + recent + (node.children.length ? `\n${renderChildren(node.children, depth + 1)}` : "");
			}).join("\n");
			const rootSpend = (results: SingleResult[]): string => {
				const usage = totalUsage(results);
				return `↑${formatTokens(usage.input)} ↓${formatTokens(usage.output)} $${usage.cost.total.toFixed(4)} reported`;
			};

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isError = isFailedResult(r);
				const icon = theme.fg(r.status === "failed" ? "error" : r.status === "completed" ? "success" : "warning", statusIcon(r.status));
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
					if (isError && r.errorMessage)
						container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					if (r.status === "running" || r.status === "queued") container.addChild(new Text(`Now: ${activity(r)}${elapsed(r)}`, 0, 0));
					if (r.children.length) container.addChild(new Text(renderChildren(r.children), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					if (displayItems.length === 0 && !finalOutput) {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					} else {
						for (const item of displayItems) {
							if (item.type === "toolCall")
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
					}
					const usageStr = formatUsageStats(r.usage, r.model);
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("dim", usageStr ? `${usageStr} reported${r.children.length ? " (incl. nested)" : ""}` : rootSpend([r])), 0, 0));
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
				if (r.status === "running" || r.status === "queued") text += `\n${activity(r)}${elapsed(r)}`;
				if (r.children.length) text += `\n${renderChildren(r.children)}`;
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const usageStr = formatUsageStats(r.usage, r.model);
				text += `\n${theme.fg("dim", usageStr ? `${usageStr} reported${r.children.length ? " (incl. nested)" : ""}` : rootSpend([r]))}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "chain") {
				const successCount = details.results.filter((r) => r.status === "completed").length;
				const isRunning = details.results.some((r) => r.status === "running" || r.status === "queued");
				const icon = isRunning ? theme.fg("warning", "⏳") : successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							icon +
								" " +
								theme.fg("toolTitle", theme.bold("chain ")) +
								theme.fg("accent", `${successCount}/${details.results.length} steps`),
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = theme.fg(r.status === "failed" ? "error" : r.status === "completed" ? "success" : "warning", statusIcon(r.status));
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}`,
								0,
								0,
							),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));
						if (r.status === "running") container.addChild(new Text(`Now: ${activity(r)}${elapsed(r)}`, 0, 0));
						if (r.children.length) container.addChild(new Text(renderChildren(r.children), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const stepUsage = formatUsageStats(r.usage, r.model);
						if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
					}

					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("dim", `Total: ${rootSpend(details.results)}`), 0, 0));
					return container;
				}

				// Collapsed view
				let text =
					icon +
					" " +
					theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${details.results.length} steps`);
				for (const r of details.results) {
					const rIcon = theme.fg(r.status === "failed" ? "error" : r.status === "completed" ? "success" : "warning", statusIcon(r.status));
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (r.status === "running") text += `\n${activity(r)}${elapsed(r)}`;
					if (r.children.length) text += `\n${renderChildren(r.children)}`;
					if (displayItems.length === 0) {
						if (r.status !== "running") text += `\n${theme.fg("muted", "(no output)")}`;
					} else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				text += `\n\n${theme.fg("dim", `Total: ${rootSpend(details.results)}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "parallel") {
				const running = details.results.filter((r) => r.status === "running").length;
				const queued = details.results.filter((r) => r.status === "queued").length;
				const successCount = details.results.filter((r) => r.status === "completed").length;
				const failCount = details.results.filter((r) => r.status === "failed").length;
				const isRunning = running + queued > 0;
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: failCount > 0
						? theme.fg("warning", "◐")
						: theme.fg("success", "✓");
				const status = isRunning
					? `${successCount + failCount}/${details.results.length} done, ${running} running, ${queued} queued`
					: `${successCount}/${details.results.length} tasks`;

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = theme.fg(r.status === "failed" ? "error" : r.status === "completed" ? "success" : "warning", statusIcon(r.status));
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));
						if (r.status === "running" || r.status === "queued") container.addChild(new Text(`Now: ${activity(r)}${elapsed(r)}`, 0, 0));
						if (r.children.length) container.addChild(new Text(renderChildren(r.children), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const taskUsage = formatUsageStats(r.usage, r.model);
						if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
					}

					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("dim", `Total: ${rootSpend(details.results)}`), 0, 0));
					return container;
				}

				// Collapsed view
				let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const r of details.results) {
					const rIcon = theme.fg(r.status === "failed" ? "error" : r.status === "completed" ? "success" : "warning", statusIcon(r.status));
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (r.status === "running" || r.status === "queued") text += `\n${activity(r)}${elapsed(r)}`;
					if (r.children.length) text += `\n${renderChildren(r.children)}`;
					if (displayItems.length === 0) {
						if (r.status === "completed" || r.status === "failed") text += `\n${theme.fg("muted", "(no output)")}`;
					} else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				text += `\n\n${theme.fg("dim", `Total: ${rootSpend(details.results)}`)}`;
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});
}
