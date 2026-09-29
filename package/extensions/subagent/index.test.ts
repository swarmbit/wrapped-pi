import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", () => ({ spawn: spawnMock }));
vi.mock("@earendil-works/pi-ai", () => ({ StringEnum: () => ({}) }));
vi.mock("@earendil-works/pi-coding-agent", () => ({
	CONFIG_DIR_NAME: ".pi",
	getAgentDir: () => "/fake",
	getMarkdownTheme: () => ({}),
	withFileMutationQueue: (_path: string, fn: () => Promise<void>) => fn(),
}));
vi.mock("typebox", () => ({ Type: {
	Object: () => ({}), String: () => ({}), Optional: () => ({}), Array: () => ({}), Boolean: () => ({}),
} }));
vi.mock("./agents.ts", () => ({
	discoverAgents: () => ({ projectAgentsDir: null, agents: ["worker", "scout", "reviewer"].map((name) => ({
		name, source: "user", systemPrompt: "", description: name,
	})) }),
}));
vi.mock("@earendil-works/pi-tui", () => ({
	Text: class { constructor(public text: string) {} },
	Markdown: class { constructor(public text: string) {} },
	Spacer: class {},
	Container: class { children: any[] = []; addChild(child: any) { this.children.push(child); } },
}));

import registerSubagent from "./index";

class FakeProcess extends EventEmitter {
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	exitCode: number | null = null;
	kill = vi.fn();
	constructor(public args: string[]) { super(); }
	send(event: unknown) { this.stdout.emit("data", Buffer.from(JSON.stringify(event) + "\n")); }
	close(code = 0) { this.exitCode = code; this.emit("close", code); }
}

const processes: FakeProcess[] = [];
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

function setup() {
	let tool: any;
	registerSubagent({ registerTool: (definition: any) => { tool = definition; } } as any);
	const updates: any[] = [];
	const execute = (params: object) => tool.execute("root", params, undefined, (update: any) => updates.push(update), {
		cwd: process.cwd(), hasUI: false,
	});
	const render = (result: any, expanded = false) => {
		const rendered = tool.renderResult(result, { expanded }, theme, {});
		return "children" in rendered ? rendered.children.map((c: any) => c.text || "").join("\n") : rendered.text;
	};
	return { tool, execute, updates, render };
}

function usage(input: number, cost: number) {
	return { input, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: input + 1,
		cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } };
}
function answer(proc: FakeProcess, text: string, input: number, cost: number) {
	proc.send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }],
		usage: usage(input, cost), stopReason: "stop", model: "test" } });
}

beforeEach(() => {
	processes.length = 0;
	spawnMock.mockReset().mockImplementation((_command: string, args: string[]) => {
		const proc = new FakeProcess(args);
		processes.push(proc);
		return proc;
	});
});

describe("subagent progress", () => {
	it("shows streaming text, current tools, and live spend before completion", async () => {
		const { execute, updates, render } = setup();
		const done = execute({ agent: "worker", task: "Fix build" });
		await vi.waitFor(() => expect(processes).toHaveLength(1));
		const proc = processes[0];
		expect(updates.at(-1).details.results[0].status).toBe("running");
		proc.send({ type: "message_update", usage: usage(3, 0.01), assistantMessageEvent: { type: "text_delta", delta: "Investigating" } });
		proc.send({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "bash", args: { command: "ls -la" } });
		expect(render(updates.at(-1))).toContain("$ ls -la");
		expect(render(updates.at(-1))).toContain("$0.0100");
		answer(proc, "Build fixed", 5, 0.02);
		proc.send({ type: "tool_execution_end", toolCallId: "tool-1", toolName: "bash", result: { content: [] } });
		proc.close();
		const result = await done;
		expect(result.content[0].text).toBe("Build fixed");
		expect(result.usage.input).toBe(5); // stream's 3 tokens were a preview, not an extra turn
		expect(result.usage.cost.total).toBeCloseTo(0.02);
		expect(result.details.results[0].status).toBe("completed");
		expect(render(result)).toContain("✓ worker");
	});

	it("keeps parallel lanes separate and counts nested and grandchild usage once", async () => {
		const { execute, updates, render } = setup();
		const done = execute({ tasks: [{ agent: "worker", task: "A" }, { agent: "reviewer", task: "B" }] });
		await vi.waitFor(() => expect(processes).toHaveLength(2));
		const [a, b] = processes;
		const initial = updates[0].details.results;
		expect(initial.map((r: any) => r.status)).toEqual(["queued", "queued"]);
		answer(a, "delegating", 2, 0.01);
		answer(b, "reviewing", 3, 0.02);
		a.send({ type: "tool_execution_start", toolCallId: "nested", toolName: "subagent", args: { tasks: [] } });
		const nested = (cost: number, input: number) => ({ mode: "single", results: [{ agent: "scout", status: "running", exitCode: -1,
			tokenUsage: usage(input, cost),
			usage: { input, output: 1, cacheRead: 0, cacheWrite: 0, turns: 1, contextTokens: 11, cost },
			children: [{ id: "child/1", agent: "worker", status: "running", usage: { cost: 0.03 }, activity: "working", children: [] }],
		}] });
		a.send({ type: "tool_execution_update", toolCallId: "nested", toolName: "subagent",
			partialResult: { details: nested(0.04, 10), usage: usage(10, 0.04) } });
		await vi.waitFor(() => expect(updates.at(-1).usage.cost.total).toBeCloseTo(0.07)); // A .01 + B .02 + nested .04
		expect(render(updates.at(-1))).toContain("↳ ⏳ scout");
		expect(render(updates.at(-1))).toContain("↳ ⏳ worker");
		a.send({ type: "tool_execution_update", toolCallId: "nested", toolName: "subagent",
			partialResult: { details: nested(0.06, 12) } }); // fallback when a Pi hook strips usage
		await vi.waitFor(() => expect(updates.at(-1).usage.cost.total).toBeCloseTo(0.09)); // replacement, not .13
		b.close(); // B completes before A
		a.send({ type: "tool_execution_end", toolCallId: "nested", toolName: "subagent",
			result: { details: nested(0.07, 14) } });
		a.close();
		const result = await done;
		expect(result.usage.cost.total).toBeCloseTo(0.10);
		expect(result.details.results.map((r: any) => r.id)).toEqual(["root/1", "root/2"]);
		expect(result.details.results[0].children[0].id).toBe("root/1/nested/1");
		expect(result.details.results[0].children[0].children[0].id).toBe("root/1/nested/1/child/1");
		expect(render(result, true)).toContain("Total: ↑19"); // 2 + 3 + 14
	});

	it("queues excess parallel lanes and keeps their IDs stable as slots free up", async () => {
		const { execute, updates } = setup();
		const tasks = Array.from({ length: 5 }, (_, i) => ({ agent: "scout", task: `task ${i + 1}` }));
		const done = execute({ tasks });
		await vi.waitFor(() => expect(processes).toHaveLength(4));
		expect(updates.at(-1).details.results.map((r: any) => r.status)).toEqual([
			"running", "running", "running", "running", "queued",
		]);
		answer(processes[1], "done 2", 2, 0.02);
		processes[1].close();
		await vi.waitFor(() => expect(processes).toHaveLength(5));
		expect(updates.at(-1).details.results[4].id).toBe("root/5");
		for (const [i, proc] of processes.entries()) {
			if (i === 1) continue;
			answer(proc, `done ${i}`, 1, 0.01);
			proc.close();
		}
		const result = await done;
		expect(result.details.results.map((r: any) => r.id)).toEqual(tasks.map((_, i) => `root/${i + 1}`));
		expect(result.usage.cost.total).toBeCloseTo(0.06);
	});

	it("counts child usage even without a streaming subscriber", async () => {
		const { tool } = setup();
		const done = tool.execute("root", { agent: "worker", task: "A" }, undefined, undefined, {
			cwd: process.cwd(), hasUI: false,
		});
		await vi.waitFor(() => expect(processes).toHaveLength(1));
		answer(processes[0], "done", 4, 0.04);
		processes[0].close();
		expect((await done).usage.cost.total).toBeCloseTo(0.04);
	});

	it("totals sequential steps and marks failed runs without a false success icon", async () => {
		const { execute, updates, render } = setup();
		const done = execute({ chain: [{ agent: "scout", task: "find" }, { agent: "worker", task: "use {previous}" }] });
		await vi.waitFor(() => expect(processes).toHaveLength(1));
		answer(processes[0], "location", 4, 0.04);
		processes[0].close();
		await vi.waitFor(() => expect(processes).toHaveLength(2));
		expect(processes[1].args.some((arg) => arg.includes("use location"))).toBe(true);
		expect(render(updates.at(-1))).toContain("⏳ chain");
		answer(processes[1], "oops", 6, 0.06);
		processes[1].close(1);
		const result = await done;
		expect(result.isError).toBe(true);
		expect(result.usage.cost.total).toBeCloseTo(0.1);
		expect(result.details.results.map((r: any) => r.status)).toEqual(["completed", "failed"]);
		expect(render(result)).toContain("✗ chain");
	});
});
