import { describe, expect, it } from "bun:test";

import { extractTaggedPayload, parseCodexPayload } from "../src/codex-output";

describe("codex output harness", () => {
  it("extracts tagged payload", () => {
    const raw = "noise\nBEGIN_AGENT_PAYLOAD\n{\"status\":\"done\",\"summary\":\"ok\",\"actionsTaken\":[],\"proposedChanges\":{\"files\":[],\"estimatedLoc\":0,\"risk\":\"low\"},\"memoryProposals\":[],\"nextSteps\":[]}\nEND_AGENT_PAYLOAD\nnoise";
    const extracted = extractTaggedPayload(raw);
    expect(extracted).not.toBeNull();
    expect(extracted).toContain('"status":"done"');
  });

  it("parses valid payload and repairs trailing commas", () => {
    const raw = [
      "BEGIN_AGENT_PAYLOAD",
      '{"status":"done","summary":"ok","actionsTaken":[],"proposedChanges":{"files":[],"estimatedLoc":0,"risk":"low",},"memoryProposals":[],"nextSteps":[],}',
      "END_AGENT_PAYLOAD",
    ].join("\n");
    const parsed = parseCodexPayload(raw);
    expect(parsed.payload.status).toBe("done");
    expect(parsed.payload.summary).toBe("ok");
  });

  it("parses payload wrapped inside codex exec json output_text", () => {
    const wrapped = JSON.stringify({
      type: "response.completed",
      output_text: [
        "BEGIN_AGENT_PAYLOAD",
        '{"status":"done","summary":"wrapped ok","actionsTaken":[],"proposedChanges":{"files":[],"estimatedLoc":0,"risk":"low"},"memoryProposals":[],"nextSteps":[]}',
        "END_AGENT_PAYLOAD",
      ].join("\n"),
    });
    const parsed = parseCodexPayload(wrapped);
    expect(parsed.payload.status).toBe("done");
    expect(parsed.payload.summary).toBe("wrapped ok");
  });
});
