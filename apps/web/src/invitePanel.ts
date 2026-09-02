/**
 * Who has been asked to join, and who has not answered.
 *
 * The tab beside the member list. It exists because the space's invite code
 * answers a different question: that code is a door, and it cannot tell you
 * whether the person you meant to invite ever walked through it. This list can.
 *
 * A deployment with no SMTP still uses this. The invitation is made either way
 * and carries a link; the row says plainly that the email did not go, and
 * offers the link to pass on by hand. Half of a feature that says which half is
 * missing beats one that silently does nothing.
 */
import { t } from "./i18n";

export type Invite = {
  id: string;
  email: string;
  role: string;
  state: "pending" | "accepted" | "revoked" | "expired";
  invitedBy: string;
  createdAt: string;
  expiresAt: string;
  emailed: boolean;
  /** only present while it is still worth copying */
  link?: string;
};

export type InvitePanelOptions = {
  host: HTMLElement;
  api: string;
  workspace: string;
  token?: string;
  /** the owner may invite an admin; an admin may not */
  canInviteAdmin?: () => boolean;
  /** told the pending count, for the tab's own label */
  onCount?: (pending: number) => void;
};

const STATE_LABEL: Record<Invite["state"], string> = {
  pending: "รอตอบรับ",
  accepted: "เข้าร่วมแล้ว",
  revoked: "ยกเลิกแล้ว",
  expired: "หมดอายุ",
};

const when = (iso: string) =>
  new Date(iso).toLocaleDateString([], { day: "numeric", month: "short" });

export function mountInvitePanel(o: InvitePanelOptions) {
  const { host } = o;
  host.classList.add("iv");
  host.innerHTML = "";

  let all: Invite[] = [];

  const tools = document.createElement("form");
  tools.className = "iv-tools";
  const email = document.createElement("input");
  email.type = "email";
  email.placeholder = t("อีเมลของคนที่จะเชิญ");
  email.autocomplete = "off";
  const role = document.createElement("select");
  const send = document.createElement("button");
  send.type = "submit";
  send.className = "iv-send";
  send.textContent = t("ส่งคำเชิญ");
  tools.append(email, role, send);

  const msg = document.createElement("div");
  msg.className = "iv-msg";
  const list = document.createElement("div");
  list.className = "iv-list";
  host.append(tools, msg, list);

  const say = (text: string, bad = false) => {
    msg.textContent = text;
    msg.classList.toggle("err", bad);
    if (text) window.setTimeout(() => { if (msg.textContent === text) msg.textContent = ""; }, 6000);
  };

  const fillRoles = () => {
    const want = role.value;
    role.innerHTML = "";
    const opts: [string, string][] = [["member", t("สมาชิก")]];
    if (o.canInviteAdmin?.()) opts.push(["admin", t("ผู้ดูแล")]);
    for (const [v, label] of opts) {
      const opt = document.createElement("option");
      opt.value = v; opt.textContent = label;
      role.appendChild(opt);
    }
    if (want) role.value = want;
  };

  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`${o.api}/workspaces/${encodeURIComponent(o.workspace)}/invites${path}`, {
      method,
      headers: { "content-type": "application/json", ...(o.token ? { authorization: `Bearer ${o.token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const d = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, ...d } as Record<string, unknown> & { ok: boolean; status: number };
  };

  tools.addEventListener("submit", async (e) => {
    e.preventDefault();
    const addr = email.value.trim();
    if (!addr) { say(t("ใส่อีเมลก่อน"), true); email.focus(); return; }
    send.disabled = true;
    try {
      const r = await call("POST", "", { email: addr, role: role.value });
      if (r.status === 409) { say(t("คนนี้อยู่ในพื้นที่นี้แล้ว"), true); return; }
      if (!r.ok) { say(String(r.error || t("ส่งคำเชิญไม่สำเร็จ")), true); return; }
      email.value = "";
      // Whether the email went is the thing worth saying. An admin who thinks
      // it was sent will wait for a reply that was never asked for.
      say(r.emailed
        ? t("ส่งคำเชิญไปที่ {email} แล้ว", { email: addr })
        : t("สร้างคำเชิญแล้ว แต่ยังส่งอีเมลไม่ได้ — คัดลอกลิงก์ส่งให้เอง"), !r.emailed);
      await refresh();
    } finally {
      send.disabled = false;
    }
  });

  async function refresh() {
    const r = await call("GET", "");
    if (!r.ok) {
      list.innerHTML = "";
      const no = document.createElement("div");
      no.className = "iv-empty";
      no.textContent = t("เฉพาะเจ้าของและผู้ดูแลที่ดูคำเชิญได้");
      list.appendChild(no);
      o.onCount?.(0);
      return;
    }
    all = (r.invites as Invite[]) ?? [];
    o.onCount?.(all.filter((i) => i.state === "pending").length);
    render();
  }

  function render() {
    fillRoles();
    list.innerHTML = "";
    if (!all.length) {
      const no = document.createElement("div");
      no.className = "iv-empty";
      no.textContent = t("ยังไม่มีคำเชิญ — ใส่อีเมลด้านบนเพื่อเชิญคนเข้าทีม");
      list.appendChild(no);
      return;
    }
    // pending first: it is the only state anybody has to act on
    const order = { pending: 0, expired: 1, revoked: 2, accepted: 3 };
    for (const i of [...all].sort((a, b) => order[a.state] - order[b.state]
      || +new Date(b.createdAt) - +new Date(a.createdAt))) {
      list.appendChild(row(i));
    }
  }

  function row(i: Invite) {
    const el = document.createElement("div");
    el.className = "iv-row " + i.state;

    const body = document.createElement("div");
    body.className = "iv-body";
    const addr = document.createElement("b");
    addr.textContent = i.email;
    const sub = document.createElement("small");
    const bits = [
      t(STATE_LABEL[i.state]),
      i.role === "admin" ? t("ผู้ดูแล") : t("สมาชิก"),
      t("โดย {name}", { name: i.invitedBy }),
    ];
    if (i.state === "pending") bits.push(t("หมดอายุ {date}", { date: when(i.expiresAt) }));
    if (i.state === "pending" && !i.emailed) bits.push(t("อีเมลยังไม่ได้ส่ง"));
    sub.textContent = bits.join(" · ");
    body.append(addr, sub);

    const acts = document.createElement("div");
    acts.className = "iv-acts";
    if (i.state === "pending" && i.link) {
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "iv-copy";
      copy.textContent = t("คัดลอกลิงก์");
      copy.onclick = async () => {
        try { await navigator.clipboard.writeText(i.link!); copy.textContent = t("คัดลอกแล้ว ✓"); }
        catch { say(i.link!); }
        window.setTimeout(() => (copy.textContent = t("คัดลอกลิงก์")), 2000);
      };
      acts.appendChild(copy);
    }
    if (i.state === "pending") {
      const drop = document.createElement("button");
      drop.type = "button";
      drop.className = "iv-drop";
      drop.textContent = "✕";
      drop.title = t("ยกเลิกคำเชิญ");
      drop.onclick = async () => {
        if (!confirm(t("ยกเลิกคำเชิญที่ส่งไป {email}?", { email: i.email }))) return;
        const r = await call("DELETE", `/${encodeURIComponent(i.id)}`);
        if (r.ok) { say(t("ยกเลิกคำเชิญแล้ว")); await refresh(); }
        else say(t("ยกเลิกไม่สำเร็จ"), true);
      };
      acts.appendChild(drop);
    }

    el.append(body, acts);
    return el;
  }

  fillRoles();
  void refresh();
  return { refresh, invites: () => all };
}
