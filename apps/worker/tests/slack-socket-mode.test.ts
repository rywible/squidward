import { describe, expect, it } from "bun:test";

import { __testOnly } from "../src/slack-socket-mode";

const { isSlackSelfEvent, shouldHandleSlackMessage, isDirectMessageChannel, isSelfMention, normalizeSlackText, parseSlackAllowedUsers, parseOwnerControlCommand } =
  __testOnly;
const { isLikelyHeavySlackRequest } = __testOnly;

describe("slack socket mode routing", () => {
  it("ignores bot-authored event shapes", () => {
    expect(isSlackSelfEvent({ bot_id: "B123", type: "message" })).toBe(true);
    expect(isSlackSelfEvent({ type: "message", subtype: "message_changed" })).toBe(true);
  });

  it("ignores authorized bot user messages", () => {
    expect(isSlackSelfEvent({ user: "UBOT", type: "message", authorizedBotUsers: ["UUSER", "UBOT"] })).toBe(true);
  });

  it("uses known self user id for self filtering", () => {
    expect(isSlackSelfEvent({ user: "USQWD", type: "message", selfUserId: "USQWD" })).toBe(true);
    expect(isSlackSelfEvent({ user: "UOTHER", type: "message", selfUserId: "USQWD" })).toBe(false);
    expect(isSlackSelfEvent({ username: "USQWD", type: "message", selfUserId: "USQWD" })).toBe(true);
  });

  it("handles channel types", () => {
    expect(isDirectMessageChannel("D123")).toBe(true);
    expect(isDirectMessageChannel("G123")).toBe(true);
    expect(isDirectMessageChannel("C123")).toBe(false);
  });

  it("requires mentions in public channel messages when allowAllChannelMessages disabled", () => {
    expect(
      shouldHandleSlackMessage("message", "C123", "hello how are you", "UUSER", [], false, undefined)
    ).toBe(false);
    expect(
      shouldHandleSlackMessage("message", "C123", "hello <@USQWD> how are you", "UUSER", [], false, "USQWD")
    ).toBe(true);
    expect(
      shouldHandleSlackMessage("message", "C123", "hello <@USQWD> how are you", undefined, ["UUSER"], false, "USQWD")
    ).toBe(false);
    expect(
      shouldHandleSlackMessage(
        "message",
        "C123",
        "hello <@USQWD> how are you",
        "UOTHER",
        ["UUSER"],
        false,
        "USQWD"
      )
    ).toBe(false);
    expect(
      shouldHandleSlackMessage(
        "message",
        "C123",
        "hello <@USQWD> how are you",
        "UUSER",
        ["UUSER"],
        false,
        "USQWD"
      )
    ).toBe(true);
  });

  it("accepts app mentions and direct messages", () => {
    expect(shouldHandleSlackMessage("app_mention", "C123", "Hey bot", "UUSER", [], false, undefined)).toBe(true);
    expect(shouldHandleSlackMessage("message", "D123", "any text", "UUSER", [], false, undefined)).toBe(true);
    expect(shouldHandleSlackMessage("app_mention", "C123", "Hey bot", undefined, ["UUSER"], false, undefined)).toBe(false);
  });

  it("normalizes Slack text for routing", () => {
    expect(normalizeSlackText("hello <@USQWD>  world")).toBe("hello world");
  });

  it("supports explicit allow-all channel message mode", () => {
    expect(shouldHandleSlackMessage("message", "C123", "anything", "UUSER", [], true, undefined)).toBe(true);
    expect(shouldHandleSlackMessage("message", "C123", "anything", "UUSER", ["UOTHER"], true, undefined)).toBe(false);
  });

  it("parses allowed users from comma list", () => {
    expect(parseSlackAllowedUsers("  U1, U2 ,,U3  ")).toEqual(["U1", "U2", "U3"]);
    expect(parseSlackAllowedUsers("")).toEqual([]);
  });

  it("detects self mentions", () => {
    expect(isSelfMention("ping <@USQWD>", "USQWD")).toBe(true);
    expect(isSelfMention("ping bot", "USQWD")).toBe(false);
  });

  it("classifies heavy Slack requests", () => {
    expect(isLikelyHeavySlackRequest("implement this perf optimization in compiler/src/main.rs")).toBe(true);
    expect(isLikelyHeavySlackRequest("you there squidward?")).toBe(false);
  });

  it("parses owner control commands", () => {
    expect(parseOwnerControlCommand("control pause")).toEqual({ action: "pause" });
    expect(parseOwnerControlCommand("control approve run_123 looks good")).toEqual({
      action: "approve",
      target: "run_123",
      notes: "looks good",
    });
    expect(parseOwnerControlCommand("control replace run_123 fix flaky ci in parser")).toEqual({
      action: "replace",
      target: "run_123",
      notes: "fix flaky ci in parser",
    });
    expect(parseOwnerControlCommand("why is ci flaky")).toBeNull();
  });
});
