// Per-member permissions. Mounted twice: in the dashboard's workspace settings
// dialog, and in the settings panel of the in-room sidebar.
//
// The server is the authority on who may act on whom — every row arrives with
// canManage/canPromote and this only draws the entries those allow. Nothing here
// is offered that a write would refuse.
import { API, authHeaders, authToken } from "./api";

export interface PanelMember {
  id: string; name: string; email: string; photoUrl?: string; role: string; isMe: boolean;
  joinedAt?: string; lastSeenAt?: string | null;
  canManage?: boolean;
  canPromote?: boolean;
}

export const roleLabel = (r: string) =>
  r === "owner" ? "เจ้าของ" : r === "admin" ? "ผู้ดูแล" : r === "guest" ? "ผู้เยี่ยมชม" : "สมาชิก";

const initial = (s: string) => (s.trim()[0] ?? "?").toUpperCase();

/** coarse on purpose — "5 นาทีที่แล้ว" reads better than a timestamp */
export const sinceLabel = (iso?: string | null) => {
  if (!iso) return "ยังไม่เคยเข้า";
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 6) return "กำลังใช้งาน";
  if (mins < 60) return `${mins} นาทีที่แล้ว`;
  if (mins < 1440) return `${Math.floor(mins / 60)} ชม.ที่แล้ว`;
  const days = Math.floor(mins / 1440);
  return days < 30 ? `${days} วันที่แล้ว` : new Date(iso).toLocaleDateString("th-TH");
};

export interface MemberPanelOptions {
  /** the panel builds its own markup inside this element */
  host: HTMLElement;
  slug: string;
  /** stacked rows for a narrow container such as the 250px sidebar */
  compact?: boolean;
  onCount?(n: number): void;
  /** fires whenever the roster confirms this user's own role */
  onMyRole?(role: string): void;
  /** they removed themselves — the host decides where to send them */
  onSelfRemoved?(): void;
}

export interface MemberPanel { reload(): Promise<void>; }

// one open menu at a time, across every mounted panel
const closeMenus = () => document.querySelectorAll(".mp-menu").forEach((el) => el.remove());
document.addEventListener("click", closeMenus);

export function mountMemberPanel(o: MemberPanelOptions): MemberPanel {
  o.host.innerHTML = "";
  o.host.classList.add("mp");
  if (o.compact) o.host.classList.add("mp-compact");

  const tools = document.createElement("div");
  tools.className = "mp-tools";
  const search = document.createElement("input");
  search.type = "text";
  search.placeholder = "ค้นหาชื่อหรืออีเมล…";
  search.autocomplete = "off";
  const filter = document.createElement("select");
  for (const [v, label] of [["", "ทุกสิทธิ์"], ["owner", "เจ้าของ"], ["admin", "ผู้ดูแล"],
                            ["member", "สมาชิก"], ["guest", "ผู้เยี่ยมชม"]]) {
    const opt = document.createElement("option");
    opt.value = v; opt.textContent = label;
    filter.appendChild(opt);
  }
  tools.append(search, filter);

  const msg = document.createElement("div");
  msg.className = "mp-msg";
  const list = document.createElement("div");
  list.className = "mp-list";
  o.host.append(tools, msg, list);

  let members: PanelMember[] = [];
  let myRole = "member";

  const say = (text: string, kind: "ok" | "err" = "ok") => {
    msg.textContent = text;
    msg.classList.toggle("err", kind === "err");
  };

  const write = async (method: "PATCH" | "DELETE", id: string, body?: unknown) => {
    const r = await fetch(`${API}/workspaces/${encodeURIComponent(o.slug)}/members/${id}`, {
      method, headers: authHeaders(), body: body === undefined ? undefined : JSON.stringify(body),
    });
    const d = await r.json().catch(() => ({} as any));
    if (r.ok) return d;
    throw new Error(
      d.error === "forbidden" ? "คุณไม่มีสิทธิ์ทำรายการนี้"
      : d.error === "cannot change the owner" ? "เปลี่ยนสิทธิ์เจ้าของไม่ได้"
      : d.error === "cannot change your own role" ? "เปลี่ยนสิทธิ์ของตัวเองไม่ได้"
      : d.error === "the owner cannot be removed" ? "นำเจ้าของออกไม่ได้"
      : d.error === "not a member" ? "คนนี้ไม่ได้อยู่ใน workspace แล้ว"
      : d.error || "ทำรายการไม่สำเร็จ");
  };

  const setRole = async (m: PanelMember, role: string) => {
    try {
      await write("PATCH", m.id, { role });
      say(`${m.name} เป็น${roleLabel(role)}แล้ว`);
      await reload();
    } catch (e) { say((e as Error).message, "err"); }
  };

  const remove = async (m: PanelMember) => {
    if (!confirm(m.isMe ? "ออกจาก workspace นี้?" : `นำ ${m.name} ออกจาก workspace?`)) return;
    try {
      await write("DELETE", m.id);
      if (m.isMe) return o.onSelfRemoved?.();
      say(`นำ ${m.name} ออกแล้ว`);
      await reload();
    } catch (e) { say((e as Error).message, "err"); }
  };

  type MenuItem = { label: string; icon: string; run(): void; danger?: boolean };

  /**
   * One entry per destination role, so an admin row cannot show both
   * "ตั้งเป็นสมาชิก" and "ถอดสิทธิ์ผู้ดูแล" for the very same change. The owner
   * gets no leave entry either — a workspace cannot be left ownerless.
   */
  const menuItems = (m: PanelMember): MenuItem[] => {
    const items: MenuItem[] = [];
    const rank: Record<string, number> = { admin: 2, member: 1, guest: 0 };
    const to = (role: string, label: string, allowed?: boolean) => {
      if (!allowed || m.role === role) return;
      items.push({ label, icon: rank[role] > (rank[m.role] ?? 1) ? "↑" : "↓", run: () => void setRole(m, role) });
    };

    to("admin", "ตั้งเป็นผู้ดูแล", m.canPromote);
    to("member", m.role === "admin" ? "ถอดสิทธิ์ผู้ดูแล" : "ตั้งเป็นสมาชิก", m.canManage);
    to("guest", "ลดเป็นผู้เยี่ยมชม", m.canManage);

    if (m.role !== "owner" && (m.canManage || m.isMe)) {
      items.push({
        label: m.isMe ? "ออกจาก Workspace" : "นำออกจาก Workspace",
        icon: "⊘", danger: true, run: () => void remove(m),
      });
    }
    return items;
  };

  /**
   * Open upward when there is no room below. The sidebar's settings view is a
   * scroll container, so a menu hanging past its bottom edge is clipped away
   * rather than merely hidden — the lower rows would have had no usable menu.
   */
  const flipIfClipped = (menu: HTMLElement, anchor: HTMLElement) => {
    let limit = window.innerHeight;
    for (let el = anchor.parentElement; el; el = el.parentElement) {
      const oy = getComputedStyle(el).overflowY;
      if (oy === "auto" || oy === "scroll") { limit = el.getBoundingClientRect().bottom; break; }
    }
    if (menu.getBoundingClientRect().bottom > limit) menu.classList.add("up");
  };

  const buildMenu = (items: MenuItem[]) => {
    const menu = document.createElement("div");
    menu.className = "mp-menu";
    menu.onclick = (e) => e.stopPropagation();
    items.forEach((it, i) => {
      if (it.danger && i > 0) menu.appendChild(document.createElement("hr"));
      const b = document.createElement("button");
      if (it.danger) b.className = "danger";
      b.textContent = `${it.icon}  ${it.label}`;
      b.onclick = () => { closeMenus(); it.run(); };
      menu.appendChild(b);
    });
    return menu;
  };

  const render = () => {
    list.innerHTML = "";
    const q = search.value.trim().toLowerCase();
    const only = filter.value;
    const shown = members.filter((m) =>
      (!only || m.role === only)
      && (!q || m.name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q)));

    if (!shown.length) {
      const empty = document.createElement("div");
      empty.className = "mp-empty";
      empty.textContent = members.length ? "ไม่พบสมาชิกที่ตรงกับการค้นหา" : "ยังไม่มีสมาชิก";
      list.appendChild(empty);
      return;
    }

    for (const m of shown) {
      const row = document.createElement("div");
      row.className = "mp-row";

      const ava = document.createElement("span");
      ava.className = "mp-ava";
      if (m.photoUrl) {
        const img = document.createElement("img");
        img.src = m.photoUrl; img.alt = "";
        ava.appendChild(img);
      } else ava.textContent = initial(m.name);

      const info = document.createElement("span");
      info.className = "mp-info";
      const name = document.createElement("b");
      name.textContent = m.name + (m.isMe ? " (คุณ)" : "");
      const mail = document.createElement("small");
      mail.textContent = m.email;
      info.append(name, mail);

      // sibling of the name block, not a child: wide containers keep it on the
      // same line, compact ones wrap it onto its own
      const meta = document.createElement("span");
      meta.className = "mp-meta";
      const chip = document.createElement("i");
      chip.className = `mp-role ${m.role}`;
      chip.textContent = roleLabel(m.role);
      const seen = document.createElement("i");
      seen.className = "mp-seen";
      seen.textContent = sinceLabel(m.lastSeenAt);
      if (m.joinedAt) seen.title = `เข้าร่วมเมื่อ ${new Date(m.joinedAt).toLocaleDateString("th-TH")}`;
      meta.append(chip, seen);

      row.append(ava, info, meta);

      const items = menuItems(m);
      if (items.length) {
        const wrap = document.createElement("span");
        wrap.className = "mp-kebab";
        const btn = document.createElement("button");
        btn.textContent = "⋮";
        btn.title = "ตัวเลือก";
        btn.onclick = (e) => {
          e.stopPropagation();
          const open = wrap.querySelector(".mp-menu");
          closeMenus();
          if (open) return;
          const menu = buildMenu(items);
          wrap.appendChild(menu);
          flipIfClipped(menu, wrap);
        };
        wrap.appendChild(btn);
        row.appendChild(wrap);
      }
      list.appendChild(row);
    }
  };

  const reload = async () => {
    if (!authToken()) {
      members = [];
      list.innerHTML = "";
      const note = document.createElement("div");
      note.className = "mp-empty";
      note.textContent = "เข้าสู่ระบบเพื่อดูและจัดการสมาชิก";
      list.appendChild(note);
      tools.style.display = "none";
      o.onCount?.(0);
      return;
    }
    tools.style.display = "";
    try {
      const r = await fetch(`${API}/workspaces/${encodeURIComponent(o.slug)}/members`, { headers: authHeaders() });
      const d = await r.json().catch(() => ({} as any));
      if (!r.ok) {
        members = [];
        render();
        return say(d.error === "forbidden" ? "คุณไม่ได้เป็นสมาชิกของ workspace นี้"
          : d.error === "not found" ? "ไม่พบ workspace นี้"
          : d.error || "โหลดสมาชิกไม่ได้", "err");
      }
      members = d.members ?? [];
      myRole = d.myRole ?? "member";
      o.onMyRole?.(myRole);
      o.onCount?.(members.length);
      render();
    } catch { say("เชื่อมต่อ API ไม่ได้", "err"); }
  };

  search.oninput = render;
  filter.onchange = render;
  void reload();

  return { reload };
}
