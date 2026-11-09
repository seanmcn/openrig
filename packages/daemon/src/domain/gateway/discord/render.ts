// A Slack post (fallback text + Block Kit blocks, as the gateway's chat logic builds it) as Discord messages.
//
// The layout rules (issue #15):
// - An ask (a post with question buttons or a reply hint) is one root message: the sender line, the headline with its
//   @-mention, the questions and one button row per question, the recommended option a success-style button labelled
//   "(recommended)". Its why and evidence go in a thread started from that root, so the person replies there.
// - Anything else is one message; one too long for Discord's 2000 characters continues in a thread from its first part.
// - The post's reconcile marker rides as a small line in the root, where a history scan for an unconfirmed attempt finds it.
// - Only the person the post @-mentions is pinged: every message names its allowed mentions.
//
// A layout Discord can't show (more than five button rows, a button id over Discord's limit) is refused as Slack refuses a
// bad payload, `invalid_blocks`, so the delivery layer treats it as permanent and tells the asking seat.

import { CHANNEL_REPLY_HINT, HUMAN_REQUIRED_REPLY_HINT, OPTION_ACTION_PREFIX, QUESTION_BLOCK_PREFIX, TYPED_REPLY_HINT } from "../slack/message.js";

export const DISCORD_CONTENT_CAP = 2000;
const BUTTON_LABEL_CAP = 80;
const CUSTOM_ID_CAP = 100;
const MAX_ROWS = 5;
const MAX_BUTTONS = 5;
const MAX_EMBEDS = 9; // ten per message, one kept for a long ask's root text
const EMBED_DESCRIPTION_CAP = 4096;
const RECOMMENDED = " (recommended)";

export const DISCORD_BUTTON_STYLE = { primary: 1, secondary: 2, success: 3 } as const;

export interface DiscordButton { type: 2; style: number; label: string; custom_id: string }
export interface DiscordActionRow { type: 1; components: DiscordButton[] }
export interface DiscordMessageBody {
  content: string;
  components?: DiscordActionRow[];
  embeds?: Array<{ image?: { url: string }; description?: string }>;
  allowed_mentions: { parse: string[]; users: string[] };
}
export interface RenderedPost {
  /** In order: the first is the root (or, posting into a thread, the first reply). */
  messages: DiscordMessageBody[];
  /** A thread follows from the root: an ask always opens one, a long post when it needs one. */
  opensThread: boolean;
  /** The post asks the person something (question buttons or a reply hint). */
  ask: boolean;
  /** Plain-text title for that thread. */
  threadName: string;
}

export class DiscordRenderError extends Error {
  constructor(detail: string) { super(`invalid_blocks: ${detail}`); }
}

type Block = { type?: string; block_id?: string; text?: { type?: string; text?: string }; elements?: unknown[]; image_url?: string; alt_text?: string };

const HINTS = new Set([TYPED_REPLY_HINT, CHANNEL_REPLY_HINT, HUMAN_REQUIRED_REPLY_HINT]);
const MARKER = /\(or-mark:[^)\s]*\)/;
const EMOJI: Record<string, string> = { rotating_light: "🚨", warning: "⚠️", white_check_mark: "✅", x: "❌", bell: "🔔" };

const unescape = (s: string) => s.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");

/** One mrkdwn line outside a code fence as Discord Markdown. Code spans and links are set aside first so their insides
 *  are never reformatted. */
function mrkdwnLine(line: string): string {
  const held: string[] = [];
  const hold = (s: string) => `\u0000${held.push(s) - 1}\u0000`;
  let out = line
    .replace(/`[^`\n]+`/g, (m) => hold(unescape(m)))
    .replace(/<(https?:\/\/[^|>\s]+)\|([^>]+)>/g, (_, url: string, label: string) => hold(`[${unescape(label)}](${unescape(url)})`))
    .replace(/<(https?:\/\/[^|>\s]+)>/g, (_, url: string) => hold(unescape(url)))
    .replace(/<([@#][A-Za-z0-9]+)>/g, (_, ref: string) => hold(`<${ref}>`))
    .replace(/<!(here|channel|everyone)>/g, (_, who: string) => hold(`@${who}`))
    .replace(/:([a-z_]+):/g, (m, name: string) => EMOJI[name] ?? m)
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![\w*])/g, "$1**$2**")
    .replace(/(^|[^\w~])~(?=\S)([^~\n]+?)(?<=\S)~(?![\w~])/g, "$1~~$2~~");
  out = unescape(out);
  if (/^\s*#/.test(out)) out = out.replace("#", "\\#"); // Slack shows a leading # as text; Discord would make a heading
  return out.replace(/\u0000(\d+)\u0000/g, (_, i: string) => held[Number(i)] ?? "");
}

/** Slack mrkdwn (entity-escaped, with fences) as Discord Markdown. */
export function mrkdwnToDiscord(text: string): string {
  let inFence = false;
  return text.split("\n").map((line) => {
    if (/^\s*```/.test(line)) {
      const toggles = (line.match(/```/g) ?? []).length % 2 === 1;
      const converted = unescape(line);
      if (toggles) inFence = !inFence;
      return converted;
    }
    return inFence ? unescape(line) : mrkdwnLine(line);
  }).join("\n");
}

const escapeLiteral = (s: string) => s.replace(/([*_~`|\\])/g, "\\$1");

type RichEl = { type?: string; text?: string; url?: string; style?: { bold?: boolean; italic?: boolean; strike?: boolean; code?: boolean }; elements?: RichEl[]; style_?: string };

function richInline(els: RichEl[] | undefined): string {
  return (els ?? []).map((el) => {
    if (el.type === "link") return el.text ? `[${escapeLiteral(el.text)}](${el.url})` : String(el.url ?? "");
    if (el.type === "user") return `<@${(el as { user_id?: string }).user_id}>`;
    let t = el.style?.code ? `\`${el.text ?? ""}\`` : escapeLiteral(el.text ?? "");
    if (el.style?.bold) t = `**${t}**`;
    if (el.style?.italic) t = `_${t}_`;
    if (el.style?.strike) t = `~~${t}~~`;
    return t;
  }).join("");
}

/** A Slack `rich_text` block (the body's lists) as Markdown lines. */
function richText(block: Block): string {
  const lines: string[] = [];
  for (const raw of (block.elements ?? []) as Array<RichEl & { style?: unknown; indent?: number; offset?: number }>) {
    if (raw.type === "rich_text_list") {
      const ordered = (raw as { style?: string }).style === "ordered";
      const indent = "  ".repeat(Math.max(0, raw.indent ?? 0));
      (raw.elements ?? []).forEach((item, i) => lines.push(`${indent}${ordered ? `${(raw.offset ?? 0) + i + 1}.` : "-"} ${richInline(item.elements)}`));
    } else if (raw.type === "rich_text_preformatted") {
      lines.push("```", richInline(raw.elements).replace(/\\([*_~`|\\])/g, "$1"), "```");
    } else {
      lines.push(richInline(raw.elements));
    }
  }
  return lines.join("\n");
}

function contextText(block: Block): string {
  const parts = ((block.elements ?? []) as Array<{ type?: string; text?: string }>)
    .map((el) => (el.type === "mrkdwn" ? mrkdwnToDiscord(el.text ?? "") : escapeLiteral(el.text ?? "")))
    .filter(Boolean);
  return parts.length ? parts.join(" ").split("\n").map((l) => `-# ${l}`).join("\n") : "";
}

function buttonsRow(block: Block, extraLines: string[]): DiscordActionRow {
  const elements = (block.elements ?? []) as Array<{ action_id?: string; style?: string; text?: { text?: string } }>;
  if (elements.length > MAX_BUTTONS) throw new DiscordRenderError(`a question has ${elements.length} options; Discord shows at most ${MAX_BUTTONS} buttons in a row`);
  let clipped = false;
  const components = elements.map((el) => {
    const custom_id = `${block.block_id ?? ""}|${el.action_id ?? ""}`;
    if (custom_id.length > CUSTOM_ID_CAP) throw new DiscordRenderError(`button id ${custom_id.length} characters (Discord allows ${CUSTOM_ID_CAP})`);
    const raw = unescape(el.text?.text ?? "");
    const recommended = el.style === "primary";
    const room = BUTTON_LABEL_CAP - (recommended ? RECOMMENDED.length : 0);
    const label = raw.length > room ? (clipped = true, `${raw.slice(0, room - 1)}…`) : raw;
    return { type: 2 as const, style: recommended ? DISCORD_BUTTON_STYLE.success : DISCORD_BUTTON_STYLE.secondary, label: `${label}${recommended ? RECOMMENDED : ""}`, custom_id };
  });
  // A clipped label still reads in full above its buttons.
  if (clipped) extraLines.push(...elements.map((el) => `- ${escapeLiteral(unescape(el.text?.text ?? ""))}${el.style === "primary" ? RECOMMENDED : ""}`));
  return { type: 1, components };
}

function isQuestionActions(block: Block | undefined): boolean {
  return block?.type === "actions" && (block.block_id ?? "").startsWith(QUESTION_BLOCK_PREFIX);
}
function isHint(block: Block): boolean {
  const els = (block.elements ?? []) as Array<{ text?: string }>;
  return block.type === "context" && els.length === 1 && HINTS.has(els[0]?.text ?? "");
}

/** Split text into pieces of at most `cap` characters, preferring a blank line, then a line end, then a space. A code
 *  fence open at a cut is closed and reopened, so each piece renders on its own. */
export function splitContent(text: string, cap = DISCORD_CONTENT_CAP): string[] {
  const pieces: string[] = [];
  let rest = text.trim();
  let reopen = "";
  while (rest) {
    rest = reopen + rest;
    reopen = "";
    if (rest.length <= cap) { pieces.push(rest); break; }
    const room = rest.slice(0, cap - 4); // room for a closing fence
    const cut = [room.lastIndexOf("\n\n"), room.lastIndexOf("\n"), room.lastIndexOf(" ")].find((at) => at > room.length / 2) ?? room.length;
    let piece = rest.slice(0, cut).trimEnd();
    if ((piece.match(/```/g) ?? []).length % 2 === 1) { piece += "\n```"; reopen = "```\n"; }
    pieces.push(piece);
    rest = rest.slice(cut).trimStart();
  }
  return pieces;
}

function threadTitle(headline: string): string {
  const plain = headline.replace(/<@\d+>/g, "").replace(/🚨/g, "").replace(/[*_~`\\]/g, "").replace(/\s+/g, " ").trim();
  return (plain.length > 100 ? `${plain.slice(0, 99)}…` : plain) || "OpenRig";
}

/** Render one Slack post (the `chat.postMessage` / `chat.update` body) as the Discord messages that carry it. */
export function renderSlackPost(post: { text: string; blocks?: unknown[] }): RenderedPost {
  const blocks = (Array.isArray(post.blocks) ? post.blocks : []) as Block[];
  const marker = MARKER.exec(post.text ?? "")?.[0];
  const mentions = [...new Set([...JSON.stringify(blocks.length ? blocks : post.text).matchAll(/<@(\d{15,21})>/g)].map((m) => m[1]!))];
  const allowRoot = { parse: [] as string[], users: mentions };
  const allowRest = { parse: [] as string[], users: [] as string[] };

  if (!blocks.length) {
    const pieces = splitContent([mrkdwnToDiscord(post.text ?? ""), marker && !(post.text ?? "").includes(marker) ? `-# ${marker}` : ""].filter(Boolean).join("\n"));
    return {
      messages: pieces.map((content, i) => ({ content, allowed_mentions: i === 0 ? allowRoot : allowRest })),
      opensThread: pieces.length > 1,
      ask: false,
      threadName: threadTitle(pieces[0] ?? ""),
    };
  }

  const ask = blocks.some((b) => isQuestionActions(b) || isHint(b));
  const head: string[] = [];
  const rest: string[] = [];
  const rows: DiscordActionRow[] = [];
  const embeds: NonNullable<DiscordMessageBody["embeds"]> = [];
  let headline = "";
  let seenHeadline = false;
  let pastHeader = false;
  blocks.forEach((block, i) => {
    const next = blocks[i + 1];
    let line = "";
    if (block.type === "section") line = mrkdwnToDiscord(block.text?.text ?? "");
    else if (block.type === "context") line = contextText(block);
    else if (block.type === "rich_text") line = richText(block);
    else if (block.type === "image") {
      if (block.image_url) embeds.push({ image: { url: block.image_url }, ...(block.alt_text ? { description: unescape(block.alt_text).slice(0, 4096) } : {}) });
      return;
    } else if (block.type === "actions") {
      if (!isQuestionActions(block)) return;
      const extra: string[] = [];
      rows.push(buttonsRow(block, extra));
      if (extra.length) head.push(...extra);
      return;
    } else if (block.type === "divider") line = "";
    else return;
    if (!line) return;
    // Who an ask is from, its headline and the notes right after it, its questions and its hint stay in the root.
    const isHeader = !pastHeader && (!seenHeadline || block.type === "context");
    if (block.type === "section" && !seenHeadline) { seenHeadline = true; headline = line; }
    else if (seenHeadline && block.type !== "context") pastHeader = true;
    const inRoot = !ask || isHeader || isQuestionActions(next) || isHint(block);
    (inRoot ? head : rest).push(line);
  });
  if (rows.length > MAX_ROWS) throw new DiscordRenderError(`${rows.length} questions; Discord shows at most ${MAX_ROWS} button rows on a message`);
  if (embeds.length > MAX_EMBEDS) throw new DiscordRenderError(`${embeds.length} images; Discord shows at most ${MAX_EMBEDS} on a message`);
  const restPieces = splitContent(rest.join("\n"));
  const headText = head.join("\n");
  let headMessages: DiscordMessageBody[];
  if (ask && headText.length + (marker ? marker.length + 4 : 0) > DISCORD_CONTENT_CAP) {
    // An ask's questions and buttons stay on its root, whatever their length: the root's text rides in an embed (4096
    // characters), and the content keeps the mention, which only content pings, and the reconcile marker.
    if (headText.length > EMBED_DESCRIPTION_CAP) {
      throw new DiscordRenderError(`the ask's headline and questions are ${headText.length} characters; Discord shows at most ${EMBED_DESCRIPTION_CAP} on one message`);
    }
    const content = [mentions.map((id) => `<@${id}>`).join(" "), marker ? `-# ${marker}` : ""].filter(Boolean).join("\n") || "​";
    headMessages = [{ content, embeds: [{ description: headText }], allowed_mentions: allowRoot, ...(rows.length ? { components: rows } : {}) }];
  } else {
    // Only a non-ask's text is split across messages; an ask's root fits here, buttons and all.
    const headPieces = splitContent([headText, marker ? `-# ${marker}` : ""].filter(Boolean).join("\n"));
    headMessages = headPieces.map((content, i) => ({
      content,
      allowed_mentions: i === 0 ? allowRoot : allowRest,
      ...(rows.length && i === 0 ? { components: rows } : {}),
    }));
  }
  const messages: DiscordMessageBody[] = [...headMessages, ...restPieces.map((content) => ({ content, allowed_mentions: allowRest }))];
  if (!messages.length) messages.push({ content: "​", allowed_mentions: allowRoot, ...(rows.length ? { components: rows } : {}) });
  if (embeds.length) {
    const last = messages[messages.length - 1]!;
    messages[messages.length - 1] = { ...last, embeds: [...(last.embeds ?? []), ...embeds] };
  }
  return { messages, opensThread: ask || messages.length > 1, ask, threadName: threadTitle(headline || headText) };
}
