import type { Usage } from "@earendil-works/pi-ai";

export function emptyUsage(): Usage {
	return {
		input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

export function sumUsage(...usages: (Usage | undefined)[]): Usage {
	const total = emptyUsage();
	for (const usage of usages) {
		if (!usage) continue;
		total.input += usage.input || 0;
		total.output += usage.output || 0;
		total.cacheRead += usage.cacheRead || 0;
		total.cacheWrite += usage.cacheWrite || 0;
		total.totalTokens += usage.totalTokens || 0;
		total.cost.input += usage.cost?.input || 0;
		total.cost.output += usage.cost?.output || 0;
		total.cost.cacheRead += usage.cost?.cacheRead || 0;
		total.cost.cacheWrite += usage.cost?.cacheWrite || 0;
		total.cost.total += usage.cost?.total || 0;
		if (usage.cacheWrite1h !== undefined) total.cacheWrite1h = (total.cacheWrite1h || 0) + usage.cacheWrite1h;
		if (usage.reasoning !== undefined) total.reasoning = (total.reasoning || 0) + usage.reasoning;
	}
	return total;
}

/** The stream reports cumulative usage for *one* assistant message. Tool updates
 * are snapshots too; replace by call ID instead of adding every update. */
export class UsageTracker {
	private completed = emptyUsage();
	private inFlight = emptyUsage();
	private tools = new Map<string, Usage>();

	previewAssistant(usage: Usage | undefined): void {
		if (usage) this.inFlight = usage;
	}

	completeAssistant(usage: Usage | undefined): void {
		this.completed = sumUsage(this.completed, usage ?? this.inFlight);
		this.inFlight = emptyUsage();
	}

	updateTool(id: string, usage: Usage | undefined): void {
		if (usage) this.tools.set(id, usage);
	}

	finishTool(id: string, usage: Usage | undefined): void {
		// A partial tool update is not authoritative if the final result omits usage.
		if (usage) this.tools.set(id, usage);
		else this.tools.delete(id);
	}

	get total(): Usage {
		return sumUsage(this.completed, this.inFlight, ...this.tools.values());
	}
}
