// Numbers and dates written for people (see docs/design/direction.md, "Writing").

const UNITS = ["bytes", "KB", "MB", "GB", "TB"];

/** 1.8 MB, 212 KB, 3 bytes. Decimal units, like the operating systems people use. */
export function bytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1000) return n === 1 ? "1 byte" : `${n} bytes`;
  let i = 0;
  let v = n;
  while (v >= 1000 && i < UNITS.length - 1) {
    v /= 1000;
    i++;
  }
  const digits = v < 10 ? 1 : 0;
  return `${v.toFixed(digits).replace(/\.0$/, "")} ${UNITS[i]}`;
}

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** "Today, 09:14", "Yesterday", "3 Nov", "3 Nov 2024". */
export function when(iso: string | Date, now = new Date()): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return "";
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  if (sameDay(d, now)) return `Today, ${time}`;
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  if (sameDay(d, y)) return "Yesterday";
  const opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" };
  if (d.getFullYear() !== now.getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString("en-GB", opts);
}

/** "29 days left", "1 day left", "less than an hour left", "expired". */
export function timeLeft(iso: string, now = new Date()): string {
  const ms = new Date(iso).getTime() - now.getTime();
  if (ms <= 0) return "expired";
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return days === 1 ? "1 day left" : `${days} days left`;
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 1) return hours === 1 ? "1 hour left" : `${hours} hours left`;
  return "less than an hour left";
}

/** "about 4 min", "about 20 s". */
export function duration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  if (seconds < 60) return `about ${Math.max(1, Math.round(seconds))} s`;
  if (seconds < 3600) return `about ${Math.round(seconds / 60)} min`;
  return `about ${(seconds / 3600).toFixed(1).replace(/\.0$/, "")} h`;
}

export function plural(n: number, one: string, many = one + "s"): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Short extension label for the file icon: PDF, DOC, MP4. */
export function extLabel(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "";
  const ext = name.slice(dot + 1).toUpperCase();
  const map: Record<string, string> = { DOCX: "DOC", XLSX: "XLS", PPTX: "PPT", JPEG: "JPG", MARKDOWN: "MD", TIFF: "TIF", JSON: "{ }", HTML: "HTM", WEBP: "WEB", WEBM: "WEB", FLAC: "FLA" };
  // The icon has room for three characters.
  return (map[ext] ?? ext).slice(0, 3);
}

/** Icon color class for a file, from docs/design/direction.md ("Iconography"). */
export function iconClass(kind: string, name: string): string {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  if (kind === "folder") return "ficon--folder";
  if (kind === "image") return "ficon--image";
  if (kind === "video") return "ficon--video";
  if (kind === "pdf") return "ficon--pdf";
  if (["xlsx", "xls", "ods", "csv", "tsv"].includes(ext)) return "ficon--sheet";
  if (kind === "office") return "ficon--doc";
  if (["code", "markdown", "json", "text"].includes(kind)) return "ficon--code";
  return "";
}

/** The "Shared" column: "Only you", "Bob can edit", "Bob and 2 others", "Link, 12 days left". */
export function sharingText(sh: { people: { username: string; permission: string }[]; links: number; linkExpiresAt: string | null } | undefined, now = new Date()): string {
  if (!sh || (sh.people.length === 0 && sh.links === 0)) return "Only you";
  const parts: string[] = [];
  const [first, ...rest] = sh.people;
  if (first) {
    const name = first.username[0]!.toUpperCase() + first.username.slice(1);
    parts.push(rest.length ? `${name} and ${rest.length === 1 ? "1 other" : `${rest.length} others`}` : `${name} can ${first.permission === "edit" ? "edit" : "view"}`);
  }
  if (sh.links) {
    const link = sh.links === 1 ? "Link" : `${sh.links} links`;
    parts.push(sh.linkExpiresAt ? `${parts.length ? link.toLowerCase() : link}, ${timeLeft(sh.linkExpiresAt, now)}` : parts.length ? link.toLowerCase() : link);
  }
  return parts.join(" and ");
}
