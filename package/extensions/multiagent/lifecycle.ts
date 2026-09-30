import type { EntryRenderer } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

export const LIFECYCLE_ENTRY = "wpi-multiagent-lifecycle";
export interface LifecycleEvent {
  action: "started" | "stopped" | "failed";
  task?: string;
  id: string;
  agent: string;
  model?: string;
  error?: string;
}

/** Compact branch-local lifecycle record; unlike a custom message it never enters model context. */
export const renderLifecycleEntry: EntryRenderer<LifecycleEvent> = (entry, _options, theme) => {
  const event = entry.data;
  if (!event || !["started", "stopped", "failed"].includes(event.action)) return undefined;
  const title = event.action === "failed" ? "Agent failed" : event.action === "stopped" ? "Agent stopped" : "Agent started";
  const color = event.action === "failed" ? "error" : event.action === "stopped" ? "warning" : "accent";
  const detail = `${event.agent}:${event.id}${event.model ? ` · requested ${event.model}` : ""}${event.task ? ` · ${event.task}` : ""}${event.error ? ` · ${event.error}` : ""}`;
  const box = new Box(1, 1, value => theme.bg("customMessageBg", value));
  box.addChild(new Text(`${theme.fg(color, title)}\n${theme.fg("dim", detail)}`, 0, 0));
  return box;
};
