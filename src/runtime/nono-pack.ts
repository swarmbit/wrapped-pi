// ============================================================
// wpi — nolabs-ai/pi pack wiring check
// ============================================================
// The nolabs-ai/pi nono pack (pulled by wpi setup / the docker entrypoint)
// carries pi extensions + skills and self-wires itself into
// ~/.pi/agent/settings.json during `nono pull` (wiring json_array_append,
// deduped by `source`). wpi verifies that wiring so setup/doctor can
// surface when pi would miss the pack's /nono-status extension even
// though the pack itself is installed.
// ============================================================

import * as path from "path";
import { readSettingsForDoctor } from "./package-wiring";

/** Registry pack install dir: ~/.config/nono/packages/nolabs-ai/pi. */
export function nonoPackDir(homeDir: string): string {
  return path.join(homeDir, ".config", "nono", "packages", "nolabs-ai", "pi");
}

/**
 * True when pi settings reference the pulled nolabs-ai/pi pack — the entry
 * nono appends on pull (string path or object-form with `source`).
 */
export function isNonoPackWired(settingsPath: string, homeDir: string): boolean {
  const settings = readSettingsForDoctor(settingsPath);
  if (settings === null) return false;
  const packages: unknown[] = Array.isArray(settings.packages) ? settings.packages : [];
  const packDir = nonoPackDir(homeDir);
  return packages.some((p) => {
    if (typeof p === "string") return p === packDir;
    if (p && typeof p === "object") {
      const source = (p as Record<string, unknown>).source;
      return typeof source === "string" && source === packDir;
    }
    return false;
  });
}
