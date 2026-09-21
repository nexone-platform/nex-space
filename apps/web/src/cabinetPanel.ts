// The filing cabinet: what is inside, and who may open it.
//
// Opened by walking up to the cabinet in the room and pressing E, so the panel
// is built around a place rather than an id — the browser knows where the
// furniture stands and nothing else, and an id in a URL is an id somebody can
// try changing.
//
// Nothing here decides access. Every list the panel draws is the list the
// server sent, already filtered; the level and the reason come back with each
// row. A browser that filtered for itself would be a second copy of the rule,
// and the day the two disagreed it would be the wrong one that people saw.
import { API, authHeaders } from "./api";
import { t } from "./i18n";

interface Doc {
  id: string;
  title: string;
  provider: string;
  url: string;
  mime: string | null;
  openTo: string | null;
  addedAt: string;
  addedBy: string | null;
  level: "none" | "read" | "file";
  why: string;
  mayManage: boolean;
}

interface Cab {
  id: string;
  label: string;
  openTo: string;
  at: { map: string; x: number; y: number };
  level: "none" | "read" | "file";
  mayManage: boolean;
}

interface Member { id: string; name: string; email: string; role: string }

/** why somebody can see a row, in words rather than a rule */
const WHY: Record<string, string> = {
  "runs-the-space": "คุณดูแล Space นี้",
  "named-on-document": "คุณถูกระบุชื่อบนเอกสารนี้",
  "document-open": "เอกสารนี้เปิดให้ทุกคนในทีม",
  "named-on-cabinet": "คุณถูกระบุชื่อบนตู้นี้",
  "cabinet-open": "ตู้นี้เปิดให้ทุกคนในทีม",
};

const PROVIDER: Record<string, string> = {
  google: "Google Drive", microsoft: "OneDrive", link: "ลิงก์",
};

export interface CabinetPanel {
  open(map: string, x: number, y: number): void;
  close(): void;
}

export function setupCabinetPanel(slug: string): CabinetPanel {
  const modal = document.getElementById("cab-modal");
  if (!modal) return { open() {}, close() {} };

  const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
    document.getElementById(id) as T | null;

  let cab: Cab | null = null;
  let docs: Doc[] = [];
  let members: Member[] = [];
  let where = { map: "", x: 0, y: 0 };

  const say = (text: string, bad = false) => {
    const el = $("cab-msg");
    if (!el) return;
    el.textContent = text;
    el.classList.toggle("err", bad);
  };

  const close = () => { modal.style.display = "none"; };

  const ask = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(API + path, {
      method, headers: authHeaders(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    return { status: r.status, ...data };
  };

  // ---- the cabinet itself ----------------------------------------------------------

  const load = async () => {
    say(t("กำลังเปิด…"));
    const got = await ask("GET", `/workspaces/${slug}/cabinets/at/${encodeURIComponent(where.map)}/${where.x}/${where.y}`);
    if (got.status === 404) {
      // The refusal a shut cabinet gives. Said the same way here as the server
      // says it, because "you may not" and "there is nothing here" are the same
      // sentence to somebody who was never meant to know which.
      cab = null; docs = [];
      draw();
      say(t("ตู้นี้ไม่ได้เปิดให้คุณ"), true);
      return;
    }
    if (got.status !== 200) { say(t("เปิดตู้ไม่สำเร็จ"), true); return; }
    cab = got.cabinet; docs = got.docs ?? [];
    say("");
    draw();
    if (cab?.mayManage) void loadMembers();
  };

  const loadMembers = async () => {
    if (members.length) return;
    const got = await ask("GET", `/workspaces/${slug}/members`);
    members = (got.members ?? [])
      .map((m: { id: string; name?: string; email: string; role: string }) => ({
        id: m.id, name: m.name || m.email, email: m.email, role: m.role,
      }))
      .filter((m: Member) => m.role !== "guest");
  };

  // ---- drawing ---------------------------------------------------------------------

  const draw = () => {
    const title = $("cab-title");
    if (title) title.textContent = cab ? t(cab.label) : t("ตู้เก็บเอกสาร");

    const tools = $("cab-tools");
    if (tools) {
      tools.innerHTML = "";
      tools.hidden = !cab?.mayManage;
      if (cab?.mayManage) tools.append(renameBox(), openToBox(), grantsButton());
    }

    const list = $("cab-list");
    if (!list) return;
    list.innerHTML = "";
    if (!cab) return;

    if (!docs.length) {
      const none = document.createElement("p");
      none.className = "cab-none";
      none.textContent = cab.mayManage
        ? t("ยังไม่มีเอกสารในตู้นี้")
        : t("ยังไม่มีเอกสารที่คุณเปิดได้ในตู้นี้");
      list.appendChild(none);
    }
    for (const d of docs) list.appendChild(docRow(d));

    const adder = $("cab-add");
    if (adder) adder.hidden = cab.level !== "file";
  };

  const docRow = (d: Doc) => {
    const row = document.createElement("div");
    row.className = "cab-doc";

    const a = document.createElement("a");
    a.className = "cab-doc-name";
    a.href = d.url;
    a.target = "_blank";
    // A link to somewhere else in a list anybody can add to: no referrer, and
    // no handle on this window from the page that opens.
    a.rel = "noopener noreferrer";
    a.textContent = d.title;

    const meta = document.createElement("small");
    meta.className = "cab-doc-meta";
    const bits = [t(PROVIDER[d.provider] ?? d.provider)];
    if (d.addedBy) bits.push(t("โดย {name}").replace("{name}", d.addedBy));
    if (WHY[d.why]) bits.push(t(WHY[d.why]));
    meta.textContent = bits.join(" · ");

    const left = document.createElement("div");
    left.className = "cab-doc-t";
    left.append(a, meta);
    row.appendChild(left);

    if (d.openTo === "listed") {
      const shut = document.createElement("i");
      shut.className = "cab-tag";
      shut.textContent = t("เฉพาะที่ระบุชื่อ");
      row.appendChild(shut);
    }

    if (cab?.mayManage) {
      const who = document.createElement("button");
      who.className = "cab-mini";
      who.textContent = t("สิทธิ์เข้าถึง");
      who.onclick = () => openGrants(d);
      row.appendChild(who);
    }
    if (d.mayManage) {
      const out = document.createElement("button");
      out.className = "cab-mini danger";
      out.textContent = t("นำออก");
      out.onclick = async () => {
        const said = await ask("DELETE", `/workspaces/${slug}/cabinets/${cab!.id}/docs/${d.id}`);
        if (said.status !== 200) { say(t("นำออกไม่สำเร็จ"), true); return; }
        docs = docs.filter((x) => x.id !== d.id);
        draw();
      };
      row.appendChild(out);
    }
    return row;
  };

  const renameBox = () => {
    const wrap = document.createElement("label");
    wrap.className = "cab-field";
    const b = document.createElement("b");
    b.textContent = t("ชื่อตู้");
    const input = document.createElement("input");
    input.type = "text";
    input.value = cab!.label;
    input.maxLength = 60;
    input.onchange = async () => {
      const said = await ask("PATCH", `/workspaces/${slug}/cabinets/${cab!.id}`,
        { label: input.value });
      if (said.status !== 200) { say(t("เปลี่ยนชื่อไม่สำเร็จ"), true); return; }
      cab!.label = said.cabinet.label;
      draw();
      say(t("บันทึกแล้ว"));
    };
    wrap.append(b, input);
    return wrap;
  };

  const openToBox = () => {
    const wrap = document.createElement("label");
    wrap.className = "cab-field";
    const b = document.createElement("b");
    b.textContent = t("ใครเปิดตู้นี้ได้");
    const sel = document.createElement("select");
    for (const [value, label] of [
      ["members", t("ทุกคนในทีม")],
      ["listed", t("เฉพาะคนที่ระบุชื่อ")],
    ] as const) {
      const o = document.createElement("option");
      o.value = value; o.textContent = label;
      sel.appendChild(o);
    }
    sel.value = cab!.openTo;
    sel.onchange = async () => {
      const said = await ask("PATCH", `/workspaces/${slug}/cabinets/${cab!.id}`,
        { openTo: sel.value });
      if (said.status !== 200) { say(t("เปลี่ยนไม่สำเร็จ"), true); return; }
      cab!.openTo = said.cabinet.openTo;
      say(t("บันทึกแล้ว"));
      void load();
    };
    wrap.append(b, sel);
    return wrap;
  };

  const grantsButton = () => {
    const b = document.createElement("button");
    b.className = "cab-mini";
    b.textContent = t("รายชื่อที่เปิดตู้ได้");
    b.onclick = () => openGrants(null);
    return b;
  };

  // ---- the access list -------------------------------------------------------------

  /**
   * One editor for both, because they are the same question asked about
   * different things — and a second screen that looked almost the same would be
   * the one where the rule quietly differed.
   *
   * `doc` null means the cabinet.
   */
  const openGrants = async (doc: Doc | null) => {
    await loadMembers();
    const box = $("cab-grants");
    const body = $("cab-grants-body");
    const head = $("cab-grants-title");
    if (!box || !body || !head) return;

    head.textContent = doc
      ? t("ใครเปิดเอกสารนี้ได้ — {name}").replace("{name}", doc.title)
      : t("ใครเปิดตู้นี้ได้");

    const path = doc
      ? `/workspaces/${slug}/cabinets/${cab!.id}/docs/${doc.id}/grants`
      : `/workspaces/${slug}/cabinets/${cab!.id}/grants`;

    const current = new Map<string, string>();
    if (!doc) {
      const got = await ask("GET", path);
      for (const g of got.grants ?? []) current.set(g.userId, g.level);
    }

    body.innerHTML = "";

    if (doc) {
      const wrap = document.createElement("label");
      wrap.className = "cab-field";
      const b = document.createElement("b");
      b.textContent = t("เอกสารนี้");
      const sel = document.createElement("select");
      for (const [value, label] of [
        ["", t("ตามการตั้งค่าของตู้")],
        ["members", t("เปิดให้ทุกคนในทีม")],
        ["listed", t("เฉพาะคนที่ระบุชื่อ")],
      ] as const) {
        const o = document.createElement("option");
        o.value = value; o.textContent = label;
        sel.appendChild(o);
      }
      sel.value = doc.openTo ?? "";
      sel.onchange = async () => {
        const said = await ask("PATCH", `/workspaces/${slug}/cabinets/${cab!.id}/docs/${doc.id}`,
          { openTo: sel.value === "" ? null : sel.value });
        if (said.status !== 200) { say(t("เปลี่ยนไม่สำเร็จ"), true); return; }
        void load();
      };
      wrap.append(b, sel);
      body.appendChild(wrap);
    }

    /**
     * Everybody in the space, each with a level — rather than a search box that
     * adds one name at a time. A list of who has access is the thing being
     * decided, and it should be readable in one look; "who else can see this"
     * is not a question anybody should have to assemble from a search.
     */
    for (const m of members) {
      const row = document.createElement("div");
      row.className = "cab-grant";
      const who = document.createElement("span");
      who.textContent = m.name;
      const sel = document.createElement("select");
      for (const [value, label] of [
        ["", t("ตามค่าเริ่มต้น")],
        ["read", t("เปิดอ่านได้")],
        ["file", t("อ่านและเพิ่มเอกสารได้")],
        ["none", t("ไม่ให้เข้าถึง")],
      ] as const) {
        const o = document.createElement("option");
        o.value = value; o.textContent = label;
        sel.appendChild(o);
      }
      sel.value = current.get(m.id) ?? "";
      sel.dataset.user = m.id;
      if (m.role === "owner" || m.role === "admin") {
        // Saying so beats letting somebody set a level that will be ignored.
        sel.disabled = true;
        const note = document.createElement("i");
        note.className = "cab-tag";
        note.textContent = t("ดูแล Space — เห็นทุกอย่างเสมอ");
        row.append(who, note);
        body.appendChild(row);
        continue;
      }
      row.append(who, sel);
      body.appendChild(row);
    }

    const save = $("cab-grants-save");
    if (save) {
      save.onclick = async () => {
        const grants: { userId: string; level: string }[] = [];
        body.querySelectorAll<HTMLSelectElement>("select[data-user]").forEach((s) => {
          if (s.value) grants.push({ userId: s.dataset.user!, level: s.value });
        });
        const said = await ask("PUT", path, { grants });
        if (said.status !== 200) {
          say(said.error ? String(said.error) : t("บันทึกสิทธิ์ไม่สำเร็จ"), true);
          return;
        }
        box.style.display = "none";
        say(t("บันทึกแล้ว"));
        void load();
      };
    }
    box.style.display = "grid";
  };

  // ---- putting one in --------------------------------------------------------------

  const wireAdder = () => {
    const form = $<HTMLFormElement>("cab-add");
    if (!form) return;
    form.onsubmit = async (e) => {
      e.preventDefault();
      const title = $<HTMLInputElement>("cab-add-title")!.value.trim();
      const url = $<HTMLInputElement>("cab-add-url")!.value.trim();
      if (!title || !url) { say(t("ใส่ชื่อและลิงก์ของเอกสาร"), true); return; }
      const said = await ask("POST", `/workspaces/${slug}/cabinets/${cab!.id}/docs`,
        { title, url, provider: guessProvider(url) });
      if (said.status !== 201) {
        say(said.error ? String(said.error) : t("เพิ่มเอกสารไม่สำเร็จ"), true);
        return;
      }
      $<HTMLInputElement>("cab-add-title")!.value = "";
      $<HTMLInputElement>("cab-add-url")!.value = "";
      docs.unshift(said.doc);
      draw();
      say(t("เพิ่มแล้ว"));
    };
  };

  /**
   * Which service a pasted link belongs to, from the link itself.
   *
   * A label, not a permission: it decides the word shown beside the row and
   * nothing else. Getting it wrong shows "ลิงก์" next to a Drive file, which is
   * a cosmetic mistake — so this stays a guess and never a claim about access.
   */
  const guessProvider = (url: string) => {
    let host = "";
    try { host = new URL(url).hostname.toLowerCase(); } catch { return "link"; }
    if (host.endsWith("google.com") || host.endsWith("googleusercontent.com")) return "google";
    if (host.endsWith("sharepoint.com") || host.endsWith("onedrive.live.com")
      || host.endsWith("live.com") || host.endsWith("office.com")) return "microsoft";
    return "link";
  };

  // ---- wiring ----------------------------------------------------------------------

  $("cab-close")?.addEventListener("click", close);
  $("cab-grants-close")?.addEventListener("click", () => {
    const box = $("cab-grants");
    if (box) box.style.display = "none";
  });
  modal.addEventListener("click", (e) => { if (e.target === modal) close(); });
  wireAdder();

  return {
    open(map, x, y) {
      where = { map, x, y };
      cab = null; docs = [];
      draw();
      modal.style.display = "grid";
      void load();
    },
    close,
  };
}
