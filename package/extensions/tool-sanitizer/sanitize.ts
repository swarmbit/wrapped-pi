// ============================================================
// sanitize.ts — Pure JSON/tool-argument sanitization functions
// ============================================================
// All functions here are pure and testable without pi runtime.
// The extension's index.ts calls these from the tool_call hook.
// ============================================================

import { Value } from "typebox";
import type { TSchema } from "typebox";

// ── Types ────────────────────────────────────────────────────

export interface SanitizeResult {
	/** The sanitized value (may be the same reference if nothing changed). */
	value: unknown;
	/** Descriptions of repairs made. */
	repairs: string[];
	/** Whether the value was changed from the original. */
	changed: boolean;
}

// ── Top-level entry ──────────────────────────────────────────

/**
 * Sanitize a tool-call input against its TypeBox parameter schema.
 *
 * Strategy:
 *  1. If the input isn't even an object, try to parse it as JSON.
 *  2. Walk the value together with the schema, repairing what we can:
 *     - Arrays of objects: drop non-object items and items missing required
 *       string fields.
 *     - Properties expected to be objects/arrays but arriving as strings:
 *       try JSON.parse (with light repair for trailing commas etc.).
 *     - Unknown or invalid properties: remove them.
 *  3. Never block — if we can't fix it, leave it and let pi's own
 *     validation report the error.
 */
export function sanitizeToolInput(
	input: unknown,
	schema: TSchema | undefined,
	toolName: string,
): SanitizeResult {
	const repairs: string[] = [];

	// ── Step 1: Ensure input is an object ──────────────────
	if (input === null || input === undefined) {
		// Nothing we can do
		return { value: input, repairs, changed: false };
	}

	if (typeof input === "string") {
		const parsed = tryParseJSON(input);
		if (parsed !== undefined) {
			repairs.push(`${toolName}: parsed top-level JSON string into object`);
			input = parsed;
		} else {
			// Can't parse, leave as-is
			return { value: input, repairs, changed: false };
		}
	}

	if (typeof input !== "object" || Array.isArray(input)) {
		// Not an object — nothing we can do
		return { value: input, repairs, changed: false };
	}

	// ── Step 2: Schema-guided walk ──────────────────────────
	if (schema) {
		input = walkSchema(input, schema, toolName, repairs);
	} else {
		// No schema — fall back to heuristic repairs for known tools
		input = heuristicRepair(input, toolName, repairs);
	}

	const changed = repairs.length > 0;
	return { value: input, repairs, changed };
}

// ── Schema-guided walk ──────────────────────────────────────

/**
 * Recursively walk a value against a TypeBox schema, making repairs.
 * Returns the (possibly mutated) value.
 */
function walkSchema(
	value: unknown,
	schema: TSchema,
	path: string,
	repairs: string[],
): unknown {
	// Handle schemas with [kind] properties that TypeBox uses
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const s = schema as any;
	const kind = s[Symbol.toStringTag] ?? s.kind;

	// ── Object schema ────────────────────────────────────
	if (kind === "Object" || kind === "Intersect" || (s.type === "object" && s.properties)) {
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			// Try parsing if it's a string
			if (typeof value === "string") {
				const parsed = tryParseJSON(value);
				if (parsed !== undefined && typeof parsed === "object" && !Array.isArray(parsed)) {
					repairs.push(`${path}: parsed JSON string into object`);
					value = parsed;
				} else {
					return value;
				}
			} else {
				return value;
			}
		}

		const obj = { ...(value as Record<string, unknown>) };

		if (kind === "Intersect" && Array.isArray(s.allOf)) {
			// Walk each sub-schema
			for (const sub of s.allOf) {
				walkObjectProperties(obj, sub, path, repairs);
			}
		} else if (s.properties) {
			walkObjectProperties(obj, schema, path, repairs);
		}

		return obj;
	}

	// ── Array schema ─────────────────────────────────────
	if (kind === "Array" || s.type === "array") {
		if (!Array.isArray(value)) {
			// Try to parse if it's a string
			if (typeof value === "string") {
				const parsed = tryParseJSON(value);
				if (Array.isArray(parsed)) {
					repairs.push(`${path}: parsed JSON string into array`);
					value = parsed;
				} else {
					return value;
				}
			} else {
				return value;
			}
		}

		const arr = value as unknown[];

		if (s.items) {
			const itemsSchema = s.items as TSchema;
			const itemKind = (itemsSchema as any)[Symbol.toStringTag] ?? (itemsSchema as any).kind;

			// If items are objects, drop non-object entries and entries missing required fields
			if (
				itemKind === "Object" ||
				(itemsSchema as any).type === "object"
			) {
				const required = getRequiredFields(itemsSchema);
				const filtered = arr.filter((item, i) => {
					if (item === null || typeof item !== "object" || Array.isArray(item)) {
						repairs.push(`${path}[${i}]: dropped non-object entry (${prettyType(item)})`);
						return false;
					}
					// Check required string fields
					for (const field of required) {
						const fieldSchema = (itemsSchema as any).properties?.[field];
						const isStringField = fieldSchema?.type === "string";
						if (!(field in (item as Record<string, unknown>))) {
							repairs.push(`${path}[${i}]: dropped object missing required field "${field}"`);
							return false;
						}
						if (isStringField && typeof (item as Record<string, unknown>)[field] !== "string") {
							repairs.push(`${path}[${i}]: dropped object with non-string required field "${field}" (${prettyType((item as Record<string, unknown>)[field])})`);
							return false;
						}
					}
					return true;
				});
				return filtered;
			}

			// Generic: walk each item against items schema
			return arr.map((item, i) =>
				walkSchema(item, itemsSchema, `${path}[${i}]`, repairs),
			);
		}

		return arr;
	}

	// ── Union schema ─────────────────────────────────────
	if (kind === "Union" || s.anyOf) {
		const variants = s.anyOf ?? s.oneOf;
		if (Array.isArray(variants)) {
			// Check if any variant already validates
			for (const variant of variants) {
				if (Value.Check(variant as TSchema, value)) {
					return value;
				}
			}
			// Try walking each variant, take first that validates after repair
			for (const variant of variants) {
				const repaired = walkSchema(
					structuredClone(value),
					variant as TSchema,
					path,
					[...repairs], // temp repairs — we'll add real ones if it works
				);
				if (Value.Check(variant as TSchema, repaired)) {
					// Successful repair — count temp repairs
					repairs.push(`${path}: repaired value to match union variant`);
					return repaired;
				}
			}
		}
		return value;
	}

	// ── String schema ────────────────────────────────────
	if (kind === "String" || s.type === "string") {
		if (typeof value !== "string") {
			// Try to coerce numbers/booleans to strings for convenience
			if (typeof value === "number" || typeof value === "boolean") {
				repairs.push(`${path}: coerced ${typeof value} to string`);
				return String(value);
			}
		}
		return value;
	}

	// ── Number/Integer schema ────────────────────────────
	if (kind === "Number" || kind === "Integer" || s.type === "number" || s.type === "integer") {
		if (typeof value === "string") {
			const num = Number(value);
			if (!isNaN(num) && value.trim() !== "") {
				repairs.push(`${path}: parsed string "${value}" as number`);
				return s.type === "integer" ? Math.round(num) : num;
			}
		}
		return value;
	}

	// ── Optional / UnionNull ────────────────────────────
	if (kind === "Optional" || kind === "UnionNull" || kind === "Nullable") {
		const inner = s.anyOf ? (s.anyOf as TSchema[])[0] : s.item ?? s;
		if (value === null || value === undefined) return value;
		return walkSchema(value, inner as TSchema, path, repairs);
	}

	return value;
}

/**
 * Walk object properties against a schema's `properties` and `required`.
 */
function walkObjectProperties(
	obj: Record<string, unknown>,
	schema: TSchema,
	path: string,
	repairs: string[],
): void {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const s = schema as any;
	if (!s.properties) return;

	for (const [key, propSchema] of Object.entries(s.properties as Record<string, TSchema>)) {
		if (!(key in obj)) continue;

		const original = obj[key];
		const repaired = walkSchema(original, propSchema, `${path}.${key}`, repairs);
		if (repaired !== original) {
			obj[key] = repaired;
		}
	}
}

// ── Heuristic repair (no schema) ─────────────────────────────

/**
 * Fall back to heuristic repairs when we don't have a schema.
 * Currently handles the `edit` tool's `edits` array.
 */
function heuristicRepair(
	value: unknown,
	toolName: string,
	repairs: string[],
): unknown {
	if (typeof value !== "object" || value === null) return value;
	const obj = value as Record<string, unknown>;

	if (toolName === "edit") {
		repairs.push(...healEditTool(obj));
	}

	return obj;
}

/**
 * Edit-specific repairs (kept from the original edit-robust extension):
 *  - Parse `edits` if sent as a JSON string.
 *  - Drop non-object / invalid entries from the `edits` array.
 */
function healEditTool(obj: Record<string, unknown>): string[] {
	const repairs: string[] = [];

	// Parse edits if sent as a JSON string
	if (typeof obj.edits === "string") {
		const parsed = tryParseJSON(obj.edits);
		if (Array.isArray(parsed)) {
			obj.edits = parsed;
			repairs.push("edit.edits: parsed JSON string into array");
		}
	}

	// Filter invalid entries from edits array
	if (Array.isArray(obj.edits)) {
		const original = obj.edits as unknown[];
		const filtered = original.filter((item, i) => {
			if (!isValidEdit(item)) {
				repairs.push(`edit.edits[${i}]: dropped invalid entry (${prettyType(item)})`);
				return false;
			}
			return true;
		});
		obj.edits = filtered;
	}

	return repairs;
}

function isValidEdit(edit: unknown): boolean {
	if (edit === null || typeof edit !== "object" || Array.isArray(edit)) return false;
	const e = edit as { oldText?: unknown; newText?: unknown };
	return typeof e.oldText === "string" && typeof e.newText === "string";
}

// ── JSON parsing with light repair ────────────────────────────

/**
 * Try to JSON.parse a string, with light repair for common LLM mistakes:
 *  - Trailing commas before ] or }
 *  - Single-quoted strings → double-quoted
 */
export function tryParseJSON(text: string): unknown {
	// First, try a straight parse
	try {
		return JSON.parse(text);
	} catch {
		// Try light repair
	}

	// Repair: trailing commas before ] or }
	let repaired = text.replace(/,\s*([\]\}])/g, "$1");

	// Repair: single-quoted strings → double-quoted (simple cases only)
	repaired = repairSingleQuotedStrings(repaired);

	try {
		return JSON.parse(repaired);
	} catch {
		return undefined;
	}
}

/**
 * Replace single-quoted strings with double-quoted strings.
 * Only handles simple, non-nested, non-escaped cases.
 */
function repairSingleQuotedStrings(text: string): string {
	// Match 'string' where string doesn't contain quotes
	// This is a simple heuristic and won't handle all edge cases
	return text.replace(/'([^']*?)'/g, '"$1"');
}

// ── TypeBox helpers ──────────────────────────────────────────

function getRequiredFields(schema: TSchema): string[] {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const s = schema as any;
	if (Array.isArray(s.required)) return s.required as string[];
	return Object.keys(s.properties ?? {});
}

// ── Pretty helpers ───────────────────────────────────────────

function prettyType(value: unknown): string {
	if (value === null) return "null";
	if (value === undefined) return "undefined";
	if (Array.isArray(value)) return "array";
	return typeof value;
}