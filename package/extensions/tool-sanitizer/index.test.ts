// ============================================================
// Tests for tool-sanitizer extension
// ============================================================

import { describe, it, expect } from "vitest";
import {
	sanitizeToolInput,
	tryParseJSON,
} from "./sanitize";
import { Type } from "typebox";

// ── tryParseJSON ─────────────────────────────────────────────

describe("tryParseJSON", () => {
	it("parses valid JSON", () => {
		expect(tryParseJSON('{"key": "value"}')).toEqual({ key: "value" });
	});

	it("parses valid JSON arrays", () => {
		expect(tryParseJSON("[1, 2, 3]")).toEqual([1, 2, 3]);
	});

	it("repairs trailing commas before ]", () => {
		expect(tryParseJSON("[1, 2, 3,]")).toEqual([1, 2, 3]);
	});

	it("repairs trailing commas before }", () => {
		expect(tryParseJSON('{"a": 1,}')).toEqual({ a: 1 });
	});

	it("repairs single-quoted strings", () => {
		expect(tryParseJSON("{'key': 'value'}")).toEqual({ key: "value" });
	});

	it("returns undefined for unparseable strings", () => {
		expect(tryParseJSON("not json at all")).toBeUndefined();
	});

	it("parses plain quoted strings", () => {
		expect(tryParseJSON('"hello"')).toBe("hello");
	});
});

// ── sanitizeToolInput ─────────────────────────────────────────

describe("sanitizeToolInput", () => {
	// ── edit tool schema (simplified) ──────────────────────

	const editSchema = Type.Object({
		path: Type.String(),
		edits: Type.Array(
			Type.Object({
				oldText: Type.String(),
				newText: Type.String(),
			}),
		),
	});

	// ── Top-level validity ────────────────────────────────

	it("leaves valid edit input unchanged", () => {
		const input = {
			path: "file.ts",
			edits: [
				{ oldText: "foo", newText: "bar" },
			],
		};
		const result = sanitizeToolInput(input, editSchema, "edit");
		expect(result.changed).toBe(false);
		expect(result.repairs).toEqual([]);
		expect(result.value).toEqual(input);
	});

	it("parses a top-level JSON string into an object", () => {
		const input = '{"path":"file.ts","edits":[{"oldText":"a","newText":"b"}]}';
		const result = sanitizeToolInput(input, editSchema, "edit");
		expect(result.changed).toBe(true);
		expect(result.repairs.length).toBeGreaterThanOrEqual(1);
		expect(result.value).toEqual({
			path: "file.ts",
			edits: [{ oldText: "a", newText: "b" }],
		});
	});

	it("drops non-object entries from edits array", () => {
		const input = {
			path: "file.ts",
			edits: [
				{ oldText: "a", newText: "b" },
				true as unknown,
				null as unknown,
				"some string" as unknown,
				{ oldText: "c", newText: "d" },
			],
		};
		const result = sanitizeToolInput(input, editSchema, "edit");
		expect(result.changed).toBe(true);
		expect(result.repairs).toHaveLength(3); // 3 invalid entries dropped
		expect((result.value as any).edits).toEqual([
			{ oldText: "a", newText: "b" },
			{ oldText: "c", newText: "d" },
		]);
	});

	it("drops entries missing required string fields", () => {
		const input = {
			path: "file.ts",
			edits: [
				{ oldText: "a" }, // missing newText
				{ newText: "b" }, // missing oldText
				{ oldText: 123, newText: "b" }, // oldText not string
				{ oldText: "c", newText: "d" }, // valid
			],
		};
		const result = sanitizeToolInput(input, editSchema, "edit");
		expect(result.changed).toBe(true);
		expect((result.value as any).edits).toEqual([
			{ oldText: "c", newText: "d" },
		]);
	});

	it("parses stringified edits array", () => {
		const input = {
			path: "file.ts",
			edits: '[{"oldText":"a","newText":"b"}]',
		};
		const result = sanitizeToolInput(input, editSchema, "edit");
		expect(result.changed).toBe(true);
		expect((result.value as any).edits).toEqual([
			{ oldText: "a", newText: "b" },
		]);
	});

	// ── Heuristic repair (no schema) ──────────────────────

	it("heals edit tool without schema", () => {
		const input = {
			path: "file.ts",
			edits: [
				{ oldText: "a", newText: "b" },
				true as unknown,
				null as unknown,
			],
		};
		const result = sanitizeToolInput(input, undefined, "edit");
		expect(result.changed).toBe(true);
		expect((result.value as any).edits).toEqual([
			{ oldText: "a", newText: "b" },
		]);
	});

	it("parses stringified edits without schema", () => {
		const input = {
			path: "file.ts",
			edits: '[{"oldText":"a","newText":"b"}, {"oldText":"c","newText":"d"}]',
		};
		const result = sanitizeToolInput(input, undefined, "edit");
		expect(result.changed).toBe(true);
		expect((result.value as any).edits).toEqual([
			{ oldText: "a", newText: "b" },
			{ oldText: "c", newText: "d" },
		]);
	});

	// ── Generic schema repairs ────────────────────────────

	it("repairs number-to-string coercion for string fields", () => {
		const schema = Type.Object({
			name: Type.String(),
		});
		const input = { name: 123 };
		const result = sanitizeToolInput(input, schema, "test");
		expect(result.changed).toBe(true);
		expect((result.value as any).name).toBe("123");
	});

	it("parses string-embedded JSON for object fields", () => {
		const innerSchema = Type.Object({ x: Type.Number() });
		const schema = Type.Object({
			data: innerSchema,
		});
		const input = {
			data: '{"x": 42}',
		};
		const result = sanitizeToolInput(input, schema, "test");
		expect(result.changed).toBe(true);
		expect((result.value as any).data).toEqual({ x: 42 });
	});

	it("leaves valid input unchanged for generic schema", () => {
		const schema = Type.Object({
			name: Type.String(),
			count: Type.Number(),
		});
		const input = { name: "hello", count: 5 };
		const result = sanitizeToolInput(input, schema, "test");
		expect(result.changed).toBe(false);
		expect(result.value).toEqual(input);
	});

	// ── Array of primitives ───────────────────────────────

	it("leaves valid arrays of strings unchanged", () => {
		const schema = Type.Object({
			items: Type.Array(Type.String()),
		});
		const input = { items: ["a", "b", "c"] };
		const result = sanitizeToolInput(input, schema, "test");
		expect(result.changed).toBe(false);
		expect(result.value).toEqual(input);
	});

	// ── Nested structures ─────────────────────────────────

	it("drops invalid items in nested object arrays", () => {
		const innerSchema = Type.Object({
			id: Type.String(),
			value: Type.Number(),
		});
		const schema = Type.Object({
			entries: Type.Array(innerSchema),
		});
		const input = {
			entries: [
				{ id: "1", value: 10 },
				"invalid" as unknown,
				{ id: "2", value: 20 },
				null as unknown,
			],
		};
		const result = sanitizeToolInput(input, schema, "test");
		expect(result.changed).toBe(true);
		expect((result.value as any).entries).toEqual([
			{ id: "1", value: 10 },
			{ id: "2", value: 20 },
		]);
	});

	it("drops entries missing required fields in nested arrays", () => {
		const innerSchema = Type.Object({
			id: Type.String(),
			value: Type.Number(),
		});
		const schema = Type.Object({
			entries: Type.Array(innerSchema),
		});
		const input = {
			entries: [
				{ id: "1", value: 10 },
				{ id: "2" }, // missing value
				{ value: 30 }, // missing id
			],
		};
		const result = sanitizeToolInput(input, schema, "test");
		expect(result.changed).toBe(true);
		expect((result.value as any).entries).toEqual([
			{ id: "1", value: 10 },
		]);
	});

	// ── Edge cases ────────────────────────────────────────

	it("returns null/undefined input unchanged", () => {
		const result1 = sanitizeToolInput(null, undefined, "test");
		expect(result1.changed).toBe(false);

		const result2 = sanitizeToolInput(undefined, undefined, "test");
		expect(result2.changed).toBe(false);
	});

	it("returns unparseable string unchanged with changed=false", () => {
		const result = sanitizeToolInput("not json", undefined, "test");
		// Can't parse — nothing was actually changed
		expect(result.changed).toBe(false);
	});

	it("handles empty objects gracefully", () => {
		const schema = Type.Object({});
		const input = {};
		const result = sanitizeToolInput(input, schema, "test");
		expect(result.changed).toBe(false);
	});

	// ── Unknown property removal ──────────────────────────

	describe("unknown property removal", () => {
		it("removes top-level extra properties not in the schema", () => {
			const schema = Type.Object({
				path: Type.String(),
			});
			const input = {
				path: "file.ts",
				bogus: "nope",
				extra: 42,
			};
			const result = sanitizeToolInput(input, schema, "test");
			expect(result.changed).toBe(true);
			expect(result.repairs).toContain("test.bogus: removed unknown property (not in schema)");
			expect(result.repairs).toContain("test.extra: removed unknown property (not in schema)");
			expect(result.value).toEqual({ path: "file.ts" });
		});

		it("removes extra properties recursively from nested objects", () => {
			const inner = Type.Object({ x: Type.Number() });
			const schema = Type.Object({ data: inner });
			const input = {
				data: { x: 1, y: 2, z: 3 },
				stray: true,
			};
			const result = sanitizeToolInput(input, schema, "test");
			expect(result.changed).toBe(true);
			expect(result.value).toEqual({ data: { x: 1 } });
			expect(result.repairs).toContain("test.stray: removed unknown property (not in schema)");
			expect(result.repairs).toContain("test.data.y: removed unknown property (not in schema)");
			expect(result.repairs).toContain("test.data.z: removed unknown property (not in schema)");
		});

		it("removes unknown properties from object array items", () => {
			const item = Type.Object({ id: Type.String() });
			const schema = Type.Object({ items: Type.Array(item) });
			const input = {
				items: [
					{ id: "a", junk: 1 },
					{ id: "b" },
				],
			};
			const result = sanitizeToolInput(input, schema, "test");
			expect(result.changed).toBe(true);
			expect(result.value).toEqual({
				items: [{ id: "a" }, { id: "b" }],
			});
			expect(result.repairs).toContain("test.items[0].junk: removed unknown property (not in schema)");
		});

		it("keeps extra properties when additionalProperties is true", () => {
			const schema = Type.Object(
				{ name: Type.String() },
				{ additionalProperties: true },
			);
			const input = { name: "x", extra: 1 };
			const result = sanitizeToolInput(input, schema, "test");
			expect(result.changed).toBe(false);
			expect(result.value).toEqual({ name: "x", extra: 1 });
		});

		it("respects explicit additionalProperties: false", () => {
			const schema = Type.Object(
				{ name: Type.String() },
				{ additionalProperties: false },
			);
			const input = { name: "x", extra: 1 };
			const result = sanitizeToolInput(input, schema, "test");
			expect(result.changed).toBe(true);
			expect(result.value).toEqual({ name: "x" });
		});

		it("keeps optional declared properties", () => {
			const schema = Type.Object({
				a: Type.String(),
				b: Type.Optional(Type.Number()),
			});
			const input = { a: "hi", b: 3 };
			const result = sanitizeToolInput(input, schema, "test");
			expect(result.changed).toBe(false);
			expect(result.value).toEqual({ a: "hi", b: 3 });
		});

		it("keeps pattern-matching properties via patternProperties", () => {
			const schema: any = {
				type: "object",
				properties: { name: { type: "string" } },
				patternProperties: { "^x-": { type: "string" } },
			};
			const input = { name: "n", "x-extra": "v", bogus: 1 };
			const result = sanitizeToolInput(input, schema, "test");
			expect(result.changed).toBe(true);
			expect(result.value).toEqual({ name: "n", "x-extra": "v" });
			expect(result.repairs).toContain("test.bogus: removed unknown property (not in schema)");
		});

		it("removes unknown keys from intersect schemas (union of members)", () => {
			const schema = Type.Intersect([
				Type.Object({ a: Type.String() }),
				Type.Object({ b: Type.Number() }),
			]);
			const input = { a: "x", b: 2, c: true };
			const result = sanitizeToolInput(input, schema, "test");
			expect(result.changed).toBe(true);
			expect(result.value).toEqual({ a: "x", b: 2 });
			expect(result.repairs).toContain("test.c: removed unknown property (not in schema)");
		});

		it("does not remove extras when there is no schema", () => {
			const input = { path: "f.ts", bogus: 1 };
			const result = sanitizeToolInput(input, undefined, "test");
			// No schema -> heuristic path does not strip unknown keys
			expect(result.value).toEqual({ path: "f.ts", bogus: 1 });
		});
	});
});