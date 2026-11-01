import { useEffect, useState } from "react";
import { owner, type Entry } from "../api";
import { plural } from "../format";
import { baseName, join, parent } from "../paths";
import { FolderIcon, Icon } from "../ui/icons";
import { Sheet } from "../ui/Sheet";
import { errorText } from "./words";

export function MoveSheet({ paths, from, onMove, onClose }: { paths: string[]; from: string; onMove: (to: string) => void; onClose: () => void }) {
  const [dir, setDir] = useState(from);
  const [folders, setFolders] = useState<Entry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setFolders(null);
    setError(null);
    owner.list(dir).then(
      (listing) => {
        if (live) setFolders(listing.entries.filter((e) => e.kind === "dir"));
      },
      (err: unknown) => {
        if (live) setError(errorText(err));
      },
    );
    return () => {
      live = false;
    };
  }, [dir]);

  const moving = new Set(paths);
  return (
    <Sheet title="Move" onClose={onClose}>
      <h2>Move {paths.length === 1 ? baseName(paths[0] ?? "") : plural(paths.length, "item")}</h2>
      <div className="move-at">
        <button className="btn quiet icon" type="button" aria-label="Up one folder" disabled={dir === ""} onClick={() => setDir(parent(dir))}>
          <Icon name="chevronLeft" />
        </button>
        <span>{dir === "" ? "Files" : dir}</span>
      </div>
      <ul className="move-list">
        {folders?.map((f) => {
          const path = join(dir, f.name);
          return (
            <li key={f.name}>
              <button type="button" disabled={moving.has(path)} onClick={() => setDir(path)}>
                <FolderIcon />
                {f.name}
              </button>
            </li>
          );
        })}
        {folders?.length === 0 && <li className="muted move-none">No folders here</li>}
      </ul>
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="sheet-actions">
        <button className="btn" type="button" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn primary"
          type="button"
          onClick={() => {
            onMove(dir);
            onClose();
          }}
        >
          Move here
        </button>
      </div>
    </Sheet>
  );
}
