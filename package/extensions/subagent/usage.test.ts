import { describe, expect, it } from "vitest";
import type { Usage } from "@earendil-works/pi-ai";
import { sumUsage, UsageTracker } from "./usage";

function usage(input: number, cost: number): Usage {
	return {
		input, output: 1, cacheRead: 2, cacheWrite: 3, totalTokens: input + 6,
		cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

describe("UsageTracker", () => {
	it("replaces cumulative message snapshots and counts each completed turn once", () => {
		const tracker = new UsageTracker();
		tracker.previewAssistant(usage(3, 0.01));
		tracker.previewAssistant(usage(5, 0.02));
		expect(tracker.total.input).toBe(5);
		expect(tracker.total.cost.total).toBe(0.02);
		tracker.completeAssistant(usage(5, 0.02));
		expect(tracker.total.input).toBe(5);
		tracker.completeAssistant(usage(7, 0.03));
		expect(tracker.total.input).toBe(12);
		expect(tracker.total.cost.total).toBeCloseTo(0.05);
	});

	it("replaces each nested tool update by call ID, preserving parallel siblings", () => {
		const tracker = new UsageTracker();
		tracker.completeAssistant(usage(2, 0.01));
		tracker.updateTool("a", usage(10, 0.1));
		tracker.updateTool("b", usage(20, 0.2));
		tracker.updateTool("a", usage(15, 0.15));
		expect(tracker.total.input).toBe(37);
		expect(tracker.total.cost.total).toBeCloseTo(0.36);
		tracker.finishTool("a", usage(16, 0.16));
		tracker.finishTool("b", usage(21, 0.21));
		expect(tracker.total.input).toBe(39);
		expect(tracker.total.cost.total).toBeCloseTo(0.38);
	});

	it("discards non-authoritative partial usage if final tool result has none", () => {
		const tracker = new UsageTracker();
		tracker.updateTool("a", usage(10, 0.1));
		tracker.finishTool("a", undefined);
		expect(tracker.total).toEqual(sumUsage());
	});
});
