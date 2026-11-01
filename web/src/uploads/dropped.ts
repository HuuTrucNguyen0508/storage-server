import type { PickedFile } from "./engine";

export interface Dropped {
  files: PickedFile[];
  emptyFolders: string[];
}

function fileOf(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

/** readEntries returns a batch at a time, so one call would stop at 100 files in Chrome. */
async function childrenOf(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = dir.createReader();
  const all: FileSystemEntry[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (batch.length === 0) return all;
    all.push(...batch);
  }
}

async function walk(entry: FileSystemEntry, prefix: string, out: Dropped): Promise<void> {
  const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
  if (entry.isFile) {
    out.files.push({ relativePath: path, file: await fileOf(entry as FileSystemFileEntry) });
    return;
  }
  const children = await childrenOf(entry as FileSystemDirectoryEntry);
  if (children.length === 0) out.emptyFolders.push(path);
  for (const child of children) await walk(child, path, out);
}

/** Must run inside the drop event: the DataTransfer list empties when the handler returns. */
export function readDrop(data: DataTransfer): Promise<Dropped> {
  const entries = [...data.items].flatMap((item) => {
    if (item.kind !== "file") return [];
    const entry = item.webkitGetAsEntry();
    return entry === null ? [] : [entry];
  });
  const loose = entries.length === 0 ? [...data.files] : [];
  return (async () => {
    const out: Dropped = { files: loose.map((file) => ({ relativePath: file.name, file })), emptyFolders: [] };
    for (const entry of entries) await walk(entry, "", out);
    return out;
  })();
}

export function pickedFromInput(input: HTMLInputElement): PickedFile[] {
  return [...(input.files ?? [])].map((file) => ({ relativePath: file.webkitRelativePath || file.name, file }));
}
