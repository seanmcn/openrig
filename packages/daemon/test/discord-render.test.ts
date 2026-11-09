import { describe, expect, it } from "vitest";
import { buildOutboundMessage, reconcileToken } from "../src/domain/gateway/slack/message.js";
import { renderSlackPost, DISCORD_BUTTON_STYLE } from "../src/domain/gateway/discord/render.js";

const ask = (over: Record<string, unknown> = {}) => buildOutboundMessage({
  qitemId: "q1",
  ownerNotificationKind: "human-required",
  summary: "Ship the release?",
  body: "The build is green.\n\n- tests pass\n- **docs** updated",
  humanQuestions: [
    { id: "ship", question: "Ship it today?", options: [{ id: "yes", label: "Yes", recommended: true }, { id: "no", label: "No" }] },
    { id: "notes", question: "Release notes?", options: [{ id: "short", label: "Short" }, { id: "long", label: "Long" }, { id: "none", label: "None" }] },
  ],
  ...over,
}, { sourceLabel: "openrig", attribution: { seat: "lead@rig", rig: "rig", session: "lead@rig" }, mentionUserId: "123456789012345678", evidenceLink: "https://example.com/proof", reconcileMarker: reconcileToken("dec-1") });

const buttons = (msg: { components?: Array<{ components: Array<{ label: string; style: number; custom_id: string }> }> }) =>
  (msg.components ?? []).map((row) => row.components);

describe("rendering a Slack post for Discord", () => {
  it("an ask: one root with a button row per question, the why and evidence in its thread", () => {
    const r = renderSlackPost(ask());
    expect(r.opensThread).toBe(true);
    const rows = buttons(r.messages[0]!);
    expect(rows.map((row) => row.map((b) => b.label))).toEqual([["Yes (recommended)", "No"], ["Short", "Long", "None"]]);
    expect(rows[0]![0]!.style).toBe(DISCORD_BUTTON_STYLE.success);
    expect(rows[0]![1]!.style).toBe(DISCORD_BUTTON_STYLE.secondary);
    expect(rows[0]![0]!.custom_id).toBe("or-q:ship|or-opt:yes");
    const root = r.messages[0]!.content;
    expect(root).toContain("<@123456789012345678>");
    expect(root).toContain("**Ship the release?**");
    expect(root).toContain("Ship it today?");
    expect(root).not.toContain("The build is green");
    const thread = r.messages.slice(1).map((m) => m.content).join("\n");
    expect(thread).toContain("The build is green.");
    expect(thread).toContain("- tests pass");
    expect(thread).toContain("**docs**");
    expect(thread).toContain("https://example.com/proof");
    expect(r.messages.slice(1).every((m) => !m.components?.length)).toBe(true);
  });

  it("only the asked person is pinged", () => {
    const r = renderSlackPost(ask({ body: "cc <@999999999999999999> and @everyone"}));
    expect(r.messages[0]!.allowed_mentions).toEqual({ parse: [], users: ["123456789012345678"] });
    for (const m of r.messages.slice(1)) expect(m.allowed_mentions).toEqual({ parse: [], users: [] });
  });

  it("carries the reconcile marker in the root, where a history scan finds it", () => {
    const r = renderSlackPost(ask());
    expect(r.messages[0]!.content).toContain(reconcileToken("dec-1"));
  });

  it("an update fits one message and opens no thread", () => {
    const r = renderSlackPost(buildOutboundMessage({ qitemId: "u1", summary: "Deployed", body: "All *good*", ownerNotificationKind: "update" }, { sourceLabel: "openrig" }));
    expect(r.opensThread).toBe(false);
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]!.content).toContain("**Deployed**");
    expect(r.messages[0]!.components ?? []).toHaveLength(0);
  });

  it("a long update is split under Discord's 2000-character limit, the rest in a thread", () => {
    const long = Array.from({ length: 60 }, (_, i) => `Line ${i} of a long report that keeps going.`).join("\n");
    const r = renderSlackPost(buildOutboundMessage({ qitemId: "u2", summary: "Report", body: long }, { sourceLabel: "openrig" }));
    expect(r.opensThread).toBe(true);
    expect(r.messages.length).toBeGreaterThan(1);
    for (const m of r.messages) expect(m.content.length).toBeLessThanOrEqual(2000);
    expect(r.messages.map((m) => m.content).join("\n")).toContain("Line 59 of a long report");
  });

  it("a recommended label too long for a button keeps its full text in the message", () => {
    const label = "A".repeat(75);
    const r = renderSlackPost(ask({ humanQuestions: [{ id: "q", question: "Pick", options: [{ id: "a", label, recommended: true }, { id: "b", label: "B" }] }] }));
    const b = buttons(r.messages[0]!)[0]![0]!;
    expect(b.label.length).toBeLessThanOrEqual(80);
    expect(b.label.endsWith("(recommended)")).toBe(true);
    expect(r.messages[0]!.content).toContain(label);
  });

  it("plain text (a click acknowledgement) converts Slack mrkdwn", () => {
    const r = renderSlackPost({ text: "Your answer is *recorded*: <https://x.example|details> &amp; more" });
    expect(r.messages[0]!.content).toBe("Your answer is **recorded**: [details](https://x.example) & more");
  });

  it("more question rows than Discord allows is an invalid_blocks refusal", () => {
    const blocks = Array.from({ length: 6 }, (_, i) => ({ type: "actions", block_id: `or-q:q${i}`, elements: [{ type: "button", action_id: "or-opt:a", text: { type: "plain_text", text: "A" } }] }));
    expect(() => renderSlackPost({ text: "x", blocks })).toThrow(/invalid_blocks/);
  });
});
