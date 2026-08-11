// ============================================================
// wpi — canonical JSON serialisation for nono profiles
// ============================================================
// Both authored profiles (wpi host profile, wpi-docker docker profile) are
// serialised deterministically — sorted keys, 2-space indent, trailing
// newline — so byte-for-byte comparison works for drift detection.
// ============================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sortKeys(obj: any): any {
  if (Array.isArray(obj)) return obj.map(sortKeys);
  if (obj && typeof obj === "object") {
    return Object.keys(obj)
      .sort()
      .reduce((acc, k) => {
        acc[k] = sortKeys(obj[k]);
        return acc;
      }, {} as Record<string, unknown>);
  }
  return obj;
}

/** Serialise a profile object to canonical JSON (sorted keys, 2-space, trailing newline). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function serializeCanonicalJson(profile: Record<string, any>): string {
  return JSON.stringify(sortKeys(profile), null, 2) + "\n";
}
