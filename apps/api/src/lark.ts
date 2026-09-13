import { createHmac } from "crypto";

/**
 * Posting a meeting summary into a Lark group chat.
 *
 * A custom-bot webhook rather than a Lark app: a webhook is a URL somebody
 * pastes into .env after adding a bot to the group, and it needs no app
 * registration, no review, no tenant token and no scopes. The cost is that it
 * can only post into the one chat the bot was added to, which is exactly what
 * is wanted here — one group, one daily summary.
 *
 * The URL carries the domain, so the same code posts to Lark (open.larksuite.com)
 * or Feishu (open.feishu.cn) without knowing which.
 */

const HOOK = (process.env.LARK_WEBHOOK || "").trim();
/** optional. Lark calls it "signature verification" and it is off by default */
const SECRET = (process.env.LARK_SECRET || "").trim();
const TIMEOUT_MS = Number(process.env.LARK_TIMEOUT_MS || 15_000);

export const larkReady = !!HOOK;
export const larkWhere = HOOK ? HOOK.replace(/\/hook\/.*$/, "/hook/…") : "";

/**
 * The signature, which is not a signature over the message.
 *
 * Lark builds an HMAC key out of `${timestamp}\n${secret}` and signs the empty
 * string with it. It looks like a mistake and it is not — it is what the server
 * checks, so anything else is refused with a 19021.
 */
export function larkSign(timestamp: number, secret: string): string {
  return createHmac("sha256", `${timestamp}\n${secret}`).update("").digest("base64");
}

type Card = { msg_type: "interactive"; card: unknown };
type Text = { msg_type: "text"; content: { text: string } };

/**
 * Send, and believe the body rather than the status.
 *
 * A webhook that is disabled, revoked, or signed wrong answers HTTP 200 with a
 * non-zero `code` in the body. Reading only the status would report every one
 * of those as delivered.
 */
export async function sendToLark(message: Card | Text): Promise<{ ok: boolean; detail: string }> {
  if (!larkReady) return { ok: false, detail: "no Lark webhook is configured (set LARK_WEBHOOK)" };

  const body: Record<string, unknown> = { ...message };
  if (SECRET) {
    const ts = Math.floor(Date.now() / 1000);
    body.timestamp = String(ts);
    body.sign = larkSign(ts, SECRET);
  }

  let r: Response;
  try {
    r = await fetch(HOOK, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    return { ok: false, detail: `could not reach Lark: ${(e as Error).message}` };
  }

  const said = await r.text().catch(() => "");
  if (!r.ok) return { ok: false, detail: `Lark answered HTTP ${r.status}: ${said.slice(0, 200)}` };
  let parsed: { code?: number; msg?: string; StatusCode?: number } = {};
  try { parsed = JSON.parse(said); } catch { /* not JSON, which is itself the answer */ }
  const code = parsed.code ?? parsed.StatusCode ?? 0;
  if (code !== 0) return { ok: false, detail: `Lark refused it (code ${code}): ${parsed.msg ?? said.slice(0, 200)}` };
  return { ok: true, detail: "posted to the group" };
}

/** configured, and does the webhook exist? — without posting into the chat */
export async function larkCheck(): Promise<{ ok: boolean; detail: string }> {
  if (!larkReady) return { ok: false, detail: "no Lark webhook is configured" };
  // There is no read endpoint on a bot webhook, so this sends a body the server
  // parses and then refuses: a valid POST with no msg_type. A live webhook says
  // "missing msg_type", a dead one says the bot is gone — and neither puts a
  // message in the group, which a real send test would.
  try {
    const r = await fetch(HOOK, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const said = await r.text().catch(() => "");
    let parsed: { code?: number; msg?: string } = {};
    try { parsed = JSON.parse(said); } catch { /* leave it */ }
    // 9499 and 19001-ish are "your body was wrong", which means the hook lives.
    const alive = r.ok && typeof parsed.code === "number" && parsed.code !== 0
      && !/not exist|disabled|revoked|invalid/i.test(parsed.msg ?? "");
    return alive
      ? { ok: true, detail: `webhook is live (${larkWhere})` }
      : { ok: false, detail: `Lark said: ${parsed.msg ?? (said.slice(0, 200) || `HTTP ${r.status}`)}` };
  } catch (e) {
    return { ok: false, detail: `could not reach Lark: ${(e as Error).message}` };
  }
}

// ---- what a meeting looks like in a group chat --------------------------------

export type ShareEvent = {
  room: string;
  startedAt: Date;
  endedAt: Date | null;
  summary: string | null;
  people: { name: string; digest: string | null; recorded: boolean }[];
  url?: string;
};

const day = (d: Date) =>
  new Intl.DateTimeFormat("th-TH", {
    dateStyle: "full", timeZone: process.env.BOOKING_TZ || "Asia/Bangkok",
  }).format(d);
const clock = (d: Date) =>
  new Intl.DateTimeFormat("th-TH", {
    timeStyle: "short", timeZone: process.env.BOOKING_TZ || "Asia/Bangkok",
  }).format(d);

/**
 * A card, not a wall of text.
 *
 * The whole meeting first, then a line per person — which is the shape the
 * summary already has, and the shape somebody scrolling a group chat on a phone
 * can read. Nobody's transcript goes in: the chat is the wrong place for a
 * verbatim record of what a colleague said, and the person it belongs to can
 * read their own in the app.
 */
export function meetingCard(e: ShareEvent): Card {
  const spoke = e.people.filter((p) => p.recorded);
  const missing = e.people.filter((p) => !p.recorded).map((p) => p.name);

  const elements: unknown[] = [
    {
      tag: "div",
      text: {
        tag: "lark_md",
        content: `**${e.room}** · ${day(e.startedAt)}\n${clock(e.startedAt)}${e.endedAt ? `–${clock(e.endedAt)}` : ""} · ${spoke.length} คน`,
      },
    },
    { tag: "hr" },
    {
      tag: "div",
      text: { tag: "lark_md", content: e.summary?.trim() || "ไม่มีสรุปของการประชุมนี้" },
    },
  ];

  const byPerson = spoke.filter((p) => p.digest?.trim());
  if (byPerson.length) {
    elements.push({ tag: "hr" });
    elements.push({ tag: "div", text: { tag: "lark_md", content: "**แยกตามคน**" } });
    for (const p of byPerson) {
      elements.push({
        tag: "div",
        text: { tag: "lark_md", content: `**${p.name}**\n${p.digest!.trim()}` },
      });
    }
  }

  // Said out loud, because a summary drawn from three voices out of five is a
  // different document from one drawn from all five.
  if (missing.length) {
    elements.push({
      tag: "note",
      elements: [{ tag: "plain_text", content: `ไม่มีเสียงของ ${missing.join(", ")} ในบันทึกนี้` }],
    });
  }
  if (e.url) {
    elements.push({
      tag: "action",
      actions: [{
        tag: "button",
        text: { tag: "plain_text", content: "เปิดใน NexSpace" },
        url: e.url,
        type: "default",
      }],
    });
  }

  return {
    msg_type: "interactive",
    card: {
      config: { wide_screen_mode: true },
      header: {
        template: "turquoise",
        title: { tag: "plain_text", content: `สรุปการประชุม — ${e.room}` },
      },
      elements,
    },
  };
}
