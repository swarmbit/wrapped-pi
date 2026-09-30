import type { RuntimeState } from "./types";

const key = Symbol.for("wpi.orchestrator.runtime.v1");
const globals = globalThis as typeof globalThis & { [key]?: Map<string, RuntimeState> };

/** Only one interactive Pi host per process/workspace is supported in this MVP. */
export function runtimeFor(workspace: string): RuntimeState {
  const runtimes = globals[key] ??= new Map();
  let state = runtimes.get(workspace);
  if (!state) {
    state = { enabled: false, busy: false, epoch: 0, pending: new Map(), history: new Map(), heldDrafts: [] };
    runtimes.set(workspace, state);
  }
  return state;
}
