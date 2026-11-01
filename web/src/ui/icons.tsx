import type { ReactNode } from "react";

const PATHS = {
  search: <><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2" /></>,
  account: <><circle cx="12" cy="8" r="3.6" /><path d="M5 20c.8-3.8 3.6-5.6 7-5.6s6.2 1.8 7 5.6" /></>,
  folderLine: <path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V7.5Z" />,
  link: <><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></>,
  unlink: <><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /><path d="m4 4 16 16" /></>,
  trash: <><path d="M4 6.5h16" /><path d="M9 6.5V4.5h6v2" /><path d="m6 6.5 1 13.5h10l1-13.5" /><path d="M10 10.5v6M14 10.5v6" /></>,
  upload: <><path d="M12 15.5V4.5" /><path d="m7.5 9 4.5-4.5L16.5 9" /><path d="M4 15v4.5h16V15" /></>,
  download: <><path d="M12 4.5v11" /><path d="m7.5 11 4.5 4.5 4.5-4.5" /><path d="M4 15v4.5h16V15" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  chevronRight: <path d="m9.5 6 6 6-6 6" />,
  chevronLeft: <path d="m14.5 6-6 6 6 6" />,
  more: <><circle cx="5.5" cy="12" r="1.2" fill="currentColor" /><circle cx="12" cy="12" r="1.2" fill="currentColor" /><circle cx="18.5" cy="12" r="1.2" fill="currentColor" /></>,
  move: <><path d="M4 12h15" /><path d="m13.5 6.5 5.5 5.5-5.5 5.5" /><path d="M4 5v14" /></>,
  copy: <><rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2" /><path d="M15.5 8.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h2.5" /></>,
  pause: <path d="M9 5.5v13M15 5.5v13" />,
  play: <path d="M8 5.5v13l10.5-6.5L8 5.5Z" />,
  file: <><path d="M6 3.5h8l4.5 4.5v12.5H6V3.5Z" /><path d="M14 3.5V8h4.5" /></>,
  text: <><path d="M6 3.5h8l4.5 4.5v12.5H6V3.5Z" /><path d="M14 3.5V8h4.5" /><path d="M9 12.5h6M9 16h6" /></>,
  pdf: <><path d="M6 3.5h8l4.5 4.5v12.5H6V3.5Z" /><path d="M14 3.5V8h4.5" /><path d="M9 17v-4.5h1.4a1.4 1.4 0 0 1 0 2.8H9M14 17v-4.5h1.8" /></>,
  image: <><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><circle cx="9" cy="10" r="1.6" /><path d="m4 17 5-4.5 3.5 3 3-2.5 5 4" /></>,
  video: <><rect x="3.5" y="5" width="17" height="14" rx="2" /><path d="m10 9 5.5 3-5.5 3V9Z" /></>,
  audio: <><path d="M9 17.5V6l10-2v11.5" /><circle cx="6.5" cy="17.5" r="2.5" /><circle cx="16.5" cy="15.5" r="2.5" /></>,
  archive: <><path d="M6 3.5h8l4.5 4.5v12.5H6V3.5Z" /><path d="M11 3.5v2.5M11 8.5v2.5" /><circle cx="11" cy="15" r="1.8" /></>,
  inbox: <><path d="M3.5 13.5 6 5.5h12l2.5 8v5h-17v-5Z" /><path d="M3.5 13.5h5l1.5 2.5h4l1.5-2.5h5" /></>,
  symlink: <><path d="M7 4.5h7l4.5 4.5v10.5H7" /><path d="M3.5 15.5h7" /><path d="m7.5 12 3.5 3.5L7.5 19" /></>,
  lock: <><rect x="5" y="10.5" width="14" height="10" rx="2" /><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" /></>,
  rename: <><path d="M4 20h4L19 9l-4-4L4 16v4Z" /><path d="m13 7 4 4" /></>,
  open: <><path d="M8 5H5a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1h13a1 1 0 0 0 1-1v-3" /><path d="M13 4h7v7" /><path d="M20 4 10.5 13.5" /></>,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 20, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg className={className ? `ic ${className}` : "ic"} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}

export function FolderIcon({ size = 20 }: { size?: number }) {
  return (
    <svg className="ic ic-folder" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V7.5Z" fill="var(--folder)" stroke="var(--folder-edge)" strokeWidth={1.4} strokeLinejoin="round" />
    </svg>
  );
}

export function Mark({ size = 24 }: { size?: number }) {
  return (
    <svg className="ic mark" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" fill="var(--folder)" stroke="var(--folder-edge)" strokeWidth={1.4} />
      <path d="M3 10h18" stroke="var(--folder-edge)" strokeWidth={1.4} />
      <circle cx="12" cy="15" r="1" fill="var(--folder-edge)" />
    </svg>
  );
}

export function entryIcon(entry: { name: string; kind: string; preview?: string | null }): IconName {
  if (entry.kind === "symlink") return "symlink";
  switch (entry.preview) {
    case "image":
      return "image";
    case "video":
      return "video";
    case "audio":
      return "audio";
    case "pdf":
      return "pdf";
    case "text":
      return "text";
  }
  return /\.(zip|tar|gz|tgz|7z|rar|xz|zst)$/i.test(entry.name) ? "archive" : "file";
}
