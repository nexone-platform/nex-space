/**
 * Putting a file in the chat, and drawing one that arrives.
 *
 * The upload is a plain POST of the file itself — no multipart envelope, since
 * there is only ever one part and the name fits in a header. What comes back is
 * an id plus a signed link; the id is what the message carries, and the link is
 * what the browser draws. The link expires, which is why nothing stores it: it
 * is minted again every time the history is read.
 */
import { t } from "../i18n";

/** what the API says about one file, once it has taken it */
export type Attach = {
  id: string;
  name: string;
  mime: string;
  bytes: number;
  image?: boolean;
  width?: number;
  height?: number;
  url: string;
};

/** the same list the API enforces, so the file picker offers what will be taken */
export const ACCEPT = [
  "image/png", "image/jpeg", "image/gif", "image/webp",
  "application/pdf", "text/plain", "text/csv", "application/zip", "application/json",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
].join(",");

/** 10 MB, matching the server. Checked here only to fail before the upload. */
export const MAX_BYTES = 10_000_000;

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * How big the picture is, before it has been sent.
 *
 * Only so the space can be reserved in the log while it loads — a thumbnail
 * that appears at zero height and then shoves the conversation down is the
 * reason people lose their place while reading. Failure here is fine: the
 * layout is a little worse and nothing else changes.
 */
async function measure(file: File): Promise<{ width?: number; height?: number }> {
  if (!file.type.startsWith("image/")) return {};
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    const done = new Promise<void>((ok, no) => { img.onload = () => ok(); img.onerror = () => no(); });
    img.src = url;
    await done;
    return { width: img.naturalWidth, height: img.naturalHeight };
  } catch {
    return {};
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Send the bytes up and get back something a message can point at.
 *
 * Throws with a sentence worth showing. Every refusal the server can give has
 * one here, because "upload failed" tells somebody nothing about whether to try
 * a smaller file, a different file, or again in a minute.
 */
export async function upload(
  file: File,
  opts: { api: string; workspace: string; token?: string; guest?: string },
): Promise<Attach> {
  if (file.size > MAX_BYTES) {
    throw new Error(t("ไฟล์ใหญ่เกินไป — สูงสุด {n}").replace("{n}", humanSize(MAX_BYTES)));
  }
  const { width, height } = await measure(file);
  const qs = opts.guest ? `?guest=${encodeURIComponent(opts.guest)}` : "";
  const r = await fetch(`${opts.api}/workspaces/${encodeURIComponent(opts.workspace)}/uploads${qs}`, {
    method: "POST",
    headers: {
      // The type is the whole of what the server will serve it back as, so an
      // empty one is refused here rather than guessed at.
      "content-type": file.type || "application/octet-stream",
      "x-filename": encodeURIComponent(file.name || "file"),
      ...(width ? { "x-width": String(width) } : {}),
      ...(height ? { "x-height": String(height) } : {}),
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: file,
  });
  if (r.status === 413) throw new Error(t("ไฟล์ใหญ่เกินไป — สูงสุด {n}").replace("{n}", humanSize(MAX_BYTES)));
  if (r.status === 415) throw new Error(t("ส่งไฟล์ชนิดนี้ไม่ได้"));
  if (r.status === 401) throw new Error(t("ไม่มีสิทธิ์ส่งไฟล์ในพื้นที่นี้"));
  if (!r.ok) throw new Error(t("ส่งไฟล์ไม่สำเร็จ — ลองอีกครั้ง"));
  const d = (await r.json()) as { attachment?: Attach };
  if (!d.attachment?.id) throw new Error(t("ส่งไฟล์ไม่สำเร็จ — ลองอีกครั้ง"));
  return d.attachment;
}

/**
 * The file, as it appears in the log.
 *
 * An image is shown, because the point of sending a screenshot is that people
 * see it without deciding to. Anything else is a card with its name and size:
 * a filename is what somebody needs to decide whether to open it, and a
 * mystery-download row is what makes people not.
 */
export function attachNode(a: Attach, api: string): HTMLElement {
  const href = api + a.url;

  if (a.image) {
    const link = document.createElement("a");
    link.className = "att att-img";
    link.href = href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    const img = document.createElement("img");
    img.src = href;
    img.alt = a.name;
    img.loading = "lazy";
    // Hold the shape before it loads so the conversation does not jump. Only
    // the ratio is used: the width comes from the panel, which is narrow and
    // changes size.
    if (a.width && a.height) img.style.aspectRatio = `${a.width} / ${a.height}`;
    link.appendChild(img);
    return link;
  }

  const card = document.createElement("a");
  card.className = "att att-file";
  card.href = href + "&dl=1";
  card.download = a.name;
  card.rel = "noopener noreferrer";
  card.title = t("ดาวน์โหลด {name}").replace("{name}", a.name);

  const icon = document.createElement("span");
  icon.className = "att-ico";
  icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"'
    + ' stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/>'
    + '<path d="M14 3v5h5"/></svg>';

  const meta = document.createElement("span");
  meta.className = "att-meta";
  const name = document.createElement("b");
  name.textContent = a.name;
  const size = document.createElement("small");
  size.textContent = humanSize(a.bytes);
  meta.append(name, size);

  card.append(icon, meta);
  return card;
}
