import { describe, expect, test } from "bun:test";

import { HEARTBEAT_MODES, PERSONA_TRAITS } from "../src/types";

describe("core domain constants", () => {
  test("exposes required heartbeat modes", () => {
    expect(HEARTBEAT_MODES).toEqual(["active", "idle", "off-hours"]);
  });

  test("includes required persona traits", () => {
    expect(PERSONA_TRAITS).toContain("directness");
    expect(PERSONA_TRAITS).toContain("risk_tolerance_within_policy");
    expect(PERSONA_TRAITS).toContain("supportiveness");
  });
});
