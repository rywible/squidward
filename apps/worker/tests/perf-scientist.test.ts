import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { computeBalancedPerfScore, resolveBenchmarkRoot } from "../src/perf-scientist";

describe("computeBalancedPerfScore", () => {
  it("increases when latency and throughput improve", () => {
    const base = computeBalancedPerfScore({
      latencyGainPct: 1,
      throughputGainPct: 1,
      allocRegressPct: 0,
      rcRegressPct: 0,
    });
    const better = computeBalancedPerfScore({
      latencyGainPct: 4,
      throughputGainPct: 3,
      allocRegressPct: 0,
      rcRegressPct: 0,
    });

    expect(better.score).toBeGreaterThan(base.score);
  });

  it("penalizes allocation and rc regressions", () => {
    const clean = computeBalancedPerfScore({
      latencyGainPct: 3,
      throughputGainPct: 2,
      allocRegressPct: 0,
      rcRegressPct: 0,
    });
    const noisy = computeBalancedPerfScore({
      latencyGainPct: 3,
      throughputGainPct: 2,
      allocRegressPct: 15,
      rcRegressPct: 10,
    });

    expect(noisy.score).toBeLessThan(clean.score);
  });
});

describe("resolveBenchmarkRoot", () => {
  it("uses manifest suite directory when root is parent benchmarks dir", () => {
    const root = mkdtempSync(join(tmpdir(), "aps-bench-"));
    const benchmarksDir = join(root, "benchmarks");
    const suiteDir = join(benchmarksDir, "macro");
    mkdirSync(suiteDir, { recursive: true });
    const manifestPath = join(suiteDir, "bench.toml");
    writeFileSync(manifestPath, "name='macro'");

    const resolved = resolveBenchmarkRoot(benchmarksDir, manifestPath);
    expect(resolved).toBe(suiteDir);
  });
});
