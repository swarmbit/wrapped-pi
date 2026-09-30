import { readFileSync } from "node:fs";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";

describe("Laya English example", () => {
  it("pins the same model in Compose, wpi, and the sample request", () => {
    const compose = load(readFileSync("example/laya/docker-compose.yml", "utf8")) as any;
    const config = load(readFileSync("example/laya/wpi-laya.yml", "utf8")) as any;
    const request = JSON.parse(readFileSync("example/laya/request.json", "utf8"));
    expect(compose.services.laya.environment.LAYA_MODELS).toBe("english");
    expect(compose.services.laya.environment.LAYA_PRELOAD).toBe("1");
    expect(config.docker.env.WPI_ORCHESTRATOR_DECISION_MODEL).toBe("english");
    expect(request.model).toBe("english");
    expect(request.state.request).toContain("I was charged twice");
  });
  it("uses English when the orchestrator model is not explicitly configured", () => {
    expect(readFileSync("package/extensions/orchestrator/index.ts", "utf8"))
      .toContain('process.env.WPI_ORCHESTRATOR_DECISION_MODEL || "english"');
  });
});
