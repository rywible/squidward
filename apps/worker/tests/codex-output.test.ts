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

  it("repairs raw newlines inside tagged payload strings", () => {
    const payload = [
      "BEGIN_AGENT_PAYLOAD",
      '{"status":"done","summary":"Prepared safe\nNext: add coverage","actionsTaken":[{"kind":"analysis","detail":"review","evidenceRefs":["a1"]}],"proposedChanges":{"files":["x.rs"],"estimatedLoc":4,"risk":"low"},"memoryProposals":[],"nextSteps":["nothing"]}',
      "END_AGENT_PAYLOAD",
    ].join("\n");
    const parsed = parseCodexPayload(payload);
    expect(parsed.payload.status).toBe("done");
    expect(parsed.payload.summary).toBe("Prepared safe Next: add coverage");
  });

  it("extracts payload from codex event stream where JSON is inside text field", () => {
    const payload = [
      "BEGIN_AGENT_PAYLOAD",
      '{"status":"done","summary":"streamed","actionsTaken":[],"proposedChanges":{"files":[],"estimatedLoc":0,"risk":"low"},"memoryProposals":[],"nextSteps":[]}',
      "END_AGENT_PAYLOAD",
    ].join("\n");
    const wrappedStream = [
      JSON.stringify({ type: "thread.started", thread_id: "t1" }),
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "item_0",
          type: "agent_message",
          text: payload,
        },
      }),
      JSON.stringify({ type: "turn.finished" }),
    ].join("\n");
    const parsed = parseCodexPayload(wrappedStream);
    expect(parsed.payload.status).toBe("done");
    expect(parsed.payload.summary).toBe("streamed");
  });

  it("recovers payload when end tag is missing but JSON object is complete", () => {
    const raw = [
      '{"type":"thread.started"}',
      "BEGIN_AGENT_PAYLOAD",
      '{"status":"blocked","summary":"partial tag recovered","actionsTaken":[],"proposedChanges":{"files":[],"estimatedLoc":0,"risk":"low"},"memoryProposals":[],"nextSteps":["retry"]}',
    ].join("\n");
    const parsed = parseCodexPayload(raw);
    expect(parsed.payload.status).toBe("blocked");
    expect(parsed.payload.summary).toBe("partial tag recovered");
  });
});
