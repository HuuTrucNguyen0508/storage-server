import { useRef, useState, useSyncExternalStore, type ChangeEvent } from "react";
import { formatBytes, plural } from "../format";
import { Icon } from "../ui/icons";
import { Sheet } from "../ui/Sheet";
import type { UploadEngine } from "../uploads/engine";
import { bytesDone, summarize, type UploadItem } from "../uploads/machine";

export function useUploads(engine: UploadEngine): readonly UploadItem[] {
  return useSyncExternalStore(engine.subscribe, engine.snapshot);
}

export function statusText(item: UploadItem): string {
  const { state, size } = item;
  const of = (bytes: number) => `${formatBytes(bytes)} of ${formatBytes(size)}`;
  const lead = item.replaced ? "Different file, new upload. " : "";
  switch (state.tag) {
    case "queued":
      return `${lead}${state.stored > 0 ? `Waiting, ${formatBytes(state.stored)} stored` : "Waiting"}`;
    case "sending":
      return `${lead}${of(state.sent)}`;
    case "paused":
      return `Paused at ${of(state.stored)}`;
    case "reconnecting":
      return `Paused at ${of(state.stored)}, reconnecting`;
    case "needs-file":
      return state.stored > 0 ? `Pick the file again to continue from ${formatBytes(state.stored)}` : "Pick the file again to start";
    case "done":
      return "Sent";
    case "failed":
      return state.reason;
  }
}

export function UploadBar({ item }: { item: UploadItem }) {
  const { state, size } = item;
  const width = (bytes: number) => `${size === 0 ? 100 : (bytes / size) * 100}%`;
  const stored = bytesDone(item);
  const flight = state.tag === "sending" ? Math.max(state.sent - state.stored, 0) : 0;
  const quiet = state.tag !== "sending" && state.tag !== "done";
  return (
    <div className={quiet ? "bar paused" : "bar"} role="progressbar" aria-label={`${item.name} stored`} aria-valuemin={0} aria-valuemax={size} aria-valuenow={stored}>
      <div className="stored" style={{ width: width(stored) }} />
      {flight > 0 && <div className="flight" style={{ width: width(flight) }} />}
    </div>
  );
}

function PickButton({ item, engine }: { item: UploadItem; engine: UploadEngine }) {
  const onChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file !== undefined) void engine.pick(item.id, file);
    e.target.value = "";
  };
  return (
    <label className="btn small pick">
      Pick
      <input className="sr" type="file" aria-label={`Pick the file for ${item.name}`} onChange={onChange} />
    </label>
  );
}

function UploadAction({ item, engine }: { item: UploadItem; engine: UploadEngine }) {
  const { state } = item;
  switch (state.tag) {
    case "needs-file":
      return <PickButton item={item} engine={engine} />;
    case "sending":
    case "reconnecting":
    case "queued":
      return (
        <button className="btn quiet small icon" type="button" aria-label={`Pause ${item.name}`} onClick={() => engine.pause(item.id)}>
          <Icon name="pause" size={16} />
        </button>
      );
    case "paused":
    case "failed":
      return (
        <button className="btn quiet small icon" type="button" aria-label={`${state.tag === "failed" ? "Retry" : "Resume"} ${item.name}`} onClick={() => engine.resume(item.id)}>
          <Icon name="play" size={16} />
        </button>
      );
    case "done":
      return null;
  }
}

function TrayItem({ item, engine }: { item: UploadItem; engine: UploadEngine }) {
  const tone = item.state.tag === "paused" || item.state.tag === "reconnecting" ? " warn" : item.state.tag === "failed" ? " bad" : item.state.tag === "done" ? " good" : "";
  return (
    <li className={`up${tone}`} data-upload={item.path} data-state={item.state.tag}>
      <span className="n" title={item.path}>
        {item.name}
      </span>
      <span className="s">{statusText(item)}</span>
      <span className="act">
        <UploadAction item={item} engine={engine} />
        {item.state.tag !== "done" && (
          <button className="btn quiet small icon" type="button" aria-label={`Cancel ${item.name}`} onClick={() => void engine.cancel(item.id)}>
            <Icon name="close" size={16} />
          </button>
        )}
      </span>
      <UploadBar item={item} />
    </li>
  );
}

function Items({ engine, items }: { engine: UploadEngine; items: readonly UploadItem[] }) {
  return (
    <ul className="tray-items">
      {items.map((item) => (
        <TrayItem key={item.id} item={item} engine={engine} />
      ))}
    </ul>
  );
}

function headline(items: readonly UploadItem[]): string {
  const s = summarize(items);
  return s.settled ? `${plural(s.total, "file")} sent` : `${s.finished} of ${s.total}, ${s.percent}%`;
}

export function RailTray({ engine }: { engine: UploadEngine }) {
  const items = useUploads(engine);
  if (items.length === 0) return null;
  return (
    <section className="tray" aria-label="Uploads">
      <h2>
        Uploading <span>{headline(items)}</span>
      </h2>
      <Items engine={engine} items={items} />
      {summarize(items).settled && (
        <button className="btn quiet small" type="button" onClick={() => engine.clearFinished()}>
          Clear
        </button>
      )}
    </section>
  );
}

export function PhoneTray({ engine }: { engine: UploadEngine }) {
  const items = useUploads(engine);
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  if (items.length === 0) return null;
  const { percent } = summarize(items);
  return (
    <>
      <button ref={opener} className="uptray-phone" type="button" onClick={() => setOpen(true)}>
        <Icon name="upload" />
        <span className="bar">
          <span className="stored" style={{ width: `${percent}%` }} />
        </span>
        <span className="txt">{headline(items)}</span>
        <Icon name="chevronRight" />
      </button>
      {open && (
        <Sheet title="Uploads" onClose={() => setOpen(false)}>
          <h2>Uploads</h2>
          <div className="tray in-sheet">
            <Items engine={engine} items={items} />
          </div>
          <div className="sheet-actions">
            {summarize(items).settled && (
              <button className="btn" type="button" onClick={() => engine.clearFinished()}>
                Clear
              </button>
            )}
            <button className="btn primary" type="button" onClick={() => setOpen(false)}>
              Close
            </button>
          </div>
        </Sheet>
      )}
    </>
  );
}
