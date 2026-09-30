import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RegistryStore } from "./store";
import { normalizeUsage } from "./usage";
import type { MemberSession } from "./types";

let dir: string;
let store: RegistryStore;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "orchestrator-store-")); store = new RegistryStore(join(dir, "registry.json"), dir); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function member(virtualId: string, id = "real-1"): MemberSession {
  return { id, virtualId, file: join(dir, `${id}.jsonl`), name: "A task", summary: "",
    lastActivityAt: "2026-01-01", origin: "attached", baselineSources: [] };
}
const usage = normalizeUsage({ input: 10, output: 2, cacheRead: 100, cacheWrite: 0, cost: { total: 0.1 } });

describe("persistent virtual registry", () => {
  it("roundtrips names and identities independently of Pi transcripts", () => {
    const created = store.create("Project Atlas");
    const reopened = new RegistryStore(store.file, dir);
    expect(reopened.find("project atlas").id).toBe(created.id);
    reopened.rename(created.id, "Renamed");
    expect(store.find("Renamed").id).toBe(created.id);
    expect(store.read().virtualSessions).toHaveLength(1);
    expect(store.read().lastSelectedVirtualId).toBe(created.id);
  });

  it("loads legacy goals without retaining them and removes them on the next save", () => {
    const virtual = store.create("Legacy");
    store.attach(member(virtual.id), []);
    const legacy = JSON.parse(readFileSync(store.file, "utf8"));
    legacy.members[0].goal = "Obsolete initial task";
    writeFileSync(store.file, JSON.stringify(legacy));
    expect(store.read().members[0]).not.toHaveProperty("goal");
    store.reconcile("real-1", [], { name: "A task", summary: "Latest messages" });
    const saved = JSON.parse(readFileSync(store.file, "utf8"));
    expect(saved.members[0]).not.toHaveProperty("goal");
    expect(saved.members[0].summary).toBe("Latest messages");
  });

  it.each(["", "  ", "a\nb", "a".repeat(101)])("rejects invalid name %j", name => {
    expect(() => store.create(name)).toThrow("name");
  });

  it("rejects duplicate creation and rename without changing the registry", () => {
    const a = store.create("One");
    store.create("Two");
    expect(() => store.create("ONE")).toThrow("already exists");
    expect(() => store.rename(a.id, "two")).toThrow("already exists");
    expect(store.read().virtualSessions).toHaveLength(2);
    expect(store.find("One").id).toBe(a.id);
  });

  it("deletes only the target metadata and preserves real transcripts", () => {
    const one = store.create("One");
    const two = store.create("Two");
    const real = member(one.id);
    writeFileSync(real.file, "preserved transcript");
    store.attach(real, [{ source: "baseline", realId: real.id, category: "worker", usage }]);
    store.record({ source: "worker", virtualId: one.id, realId: real.id, category: "worker", usage });
    store.record({ source: "decision", virtualId: one.id, category: "decision", usage });
    store.record({ source: "other", virtualId: two.id, category: "decision", usage });
    store.update(data => {
      data.lastSelectedVirtualId = one.id;
      data.requests.push({ id: "request", virtualId: one.id, state: "completed" });
    });
    store.delete(one.id);
    const data = store.read();
    expect(data.virtualSessions).toEqual([two]);
    expect(data.members).toEqual([]);
    expect(data.requests).toEqual([]);
    expect(data.usage.map(event => event.source)).toEqual(["other"]);
    expect(data.lastSelectedVirtualId).toBeUndefined();
    expect(readFileSync(real.file, "utf8")).toBe("preserved transcript");
    expect(store.create("One").id).not.toBe(one.id);
  });

  it("refuses deletion during execution or registry contention without changing metadata", () => {
    const one = store.create("One");
    const before = readFileSync(store.file, "utf8");
    const release = store.lease();
    expect(() => store.delete(one.id)).toThrow("Another orchestrator");
    release();
    writeFileSync(`${store.file}.lock`, "busy");
    expect(() => store.delete(one.id)).toThrow("locked");
    expect(existsSync(`${store.file}.execution`)).toBe(false);
    expect(readFileSync(store.file, "utf8")).toBe(before);
  });

  it("rejects unknown deletion and retains another group's resume selection", () => {
    const one = store.create("One");
    const two = store.create("Two");
    expect(() => store.delete("missing")).toThrow("no longer exists");
    expect(existsSync(`${store.file}.execution`)).toBe(false);
    store.delete(one.id);
    expect(store.read().lastSelectedVirtualId).toBe(two.id);
  });

  it("excludes pre-attachment costs and deduplicates repeated observations", () => {
    const virtual = store.create("One");
    const before = { source: "before", realId: "real-1", category: "worker" as const, usage };
    store.attach(member(virtual.id), [before]);
    const after = { ...before, source: "after" };
    store.reconcile("real-1", [before, after]);
    store.reconcile("real-1", [before, after]);
    const data = store.read();
    expect(data.usage).toHaveLength(2);
    expect(data.usage.find(item => item.source === "before")?.virtualId).toBeUndefined();
    expect(data.usage.find(item => item.source === "after")?.virtualId).toBe(virtual.id);
  });

  it("does not recount copied inference in another member", () => {
    const virtual = store.create("One");
    store.attach(member(virtual.id), []);
    store.attach(member(virtual.id, "clone"), []);
    store.reconcile("real-1", [{ source: "copied-entry", realId: "real-1", category: "worker", usage }]);
    store.reconcile("clone", [{ source: "copied-entry", realId: "clone", category: "worker", usage }]);
    expect(store.read().usage).toHaveLength(1);
  });

  it("refuses membership in two groups", () => {
    const one = store.create("One");
    const two = store.create("Two");
    store.attach(member(one.id), []);
    expect(() => store.attach(member(two.id), [])).toThrow("already belongs");
  });

  it("fails closed on corrupt data and releases the mutation lock on failure", () => {
    writeFileSync(store.file, "not JSON");
    expect(() => store.create("One")).toThrow();
    expect(readFileSync(store.file, "utf8")).toBe("not JSON");
    expect(existsSync(`${store.file}.lock`)).toBe(false);
  });

  it("checks workspace identity", () => {
    store.create("One");
    expect(() => new RegistryStore(store.file, "/another-workspace").read()).toThrow("Invalid");
  });

  it("fails fast on concurrent mutation and execution leases", () => {
    store.create("One");
    writeFileSync(`${store.file}.lock`, "someone else");
    expect(() => store.create("Two")).toThrow("locked");
    const release = store.lease();
    expect(() => store.lease()).toThrow("Another orchestrator");
    release();
    release();
    const next = store.lease();
    next();
  });
});
