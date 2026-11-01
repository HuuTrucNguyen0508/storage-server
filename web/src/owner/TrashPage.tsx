import { useState } from "react";
import { owner, type TrashItem } from "../api";
import { formatDay, plural, untilPhrase } from "../format";
import { filesHref, parent } from "../paths";
import { useLoad, useNow, useTitle } from "../ui/hooks";
import { entryIcon, FolderIcon, Icon } from "../ui/icons";
import { followLink, navigate } from "../ui/router";
import { ConfirmSheet } from "../ui/Sheet";
import { useToast } from "../ui/Toast";
import { useShell } from "./Shell";
import { errorText } from "./words";

type Confirm = { tag: "none" } | { tag: "one"; item: TrashItem } | { tag: "all" };

export function TrashPage() {
  useTitle("Trash");
  const { refreshCounts } = useShell();
  const toast = useToast();
  const now = useNow();
  const { state, reload } = useLoad("trash", () => owner.listTrash());
  const [confirm, setConfirm] = useState<Confirm>({ tag: "none" });
  const items = state.tag === "ready" ? state.value : [];

  const after = (done: Promise<unknown>, text: (value: unknown) => { text: string; action?: { label: string; run: () => void } }) => {
    done.then(
      (value) => {
        toast(text(value));
        void reload();
        refreshCounts();
      },
      (err: unknown) => toast({ text: errorText(err) }),
    );
  };

  return (
    <>
      <div className="place">
        <div className="place-row">
          <div>
            <h1>Trash</h1>
            <p className="meta">Items stay for 30 days, then they are gone</p>
          </div>
          {items.length > 0 && (
            <div className="actions">
              <button className="btn danger" type="button" onClick={() => setConfirm({ tag: "all" })}>
                Empty trash
              </button>
            </div>
          )}
        </div>
      </div>
      {state.tag === "failed" ? (
        <div className="list">
          <div className="empty">
            <h2>Trash can't be loaded</h2>
            <p>{errorText(state.error)}.</p>
          </div>
        </div>
      ) : state.tag === "ready" && items.length === 0 ? (
        <div className="list">
          <div className="empty">
            <div className="glyph">
              <Icon name="trash" size={40} />
            </div>
            <h2>Trash is empty</h2>
            <p>Anything you trash lands here for 30 days. Restoring a file also turns its share links back on.</p>
            <div className="cta">
              <a className="btn" href="/files/" onClick={(e) => followLink(e, "/files/")}>
                <Icon name="chevronLeft" />
                Back to files
              </a>
            </div>
          </div>
        </div>
      ) : (
        <div className="list">
          {state.tag === "loading" && <p className="loading-line">Loading</p>}
          {items.map((item) => (
            <div className="row trashrow" key={item.id} data-trash={item.name}>
              <div className="sel">{item.kind === "dir" ? <FolderIcon /> : <Icon name={entryIcon(item)} />}</div>
              <div className="name">
                <div className="txt">
                  <span className="t">{item.name}</span>
                  <span className="sub">
                    {parent(item.originalPath) === "" ? "Files" : parent(item.originalPath)}, trashed {formatDay(item.deletedAt, now)}, gone {untilPhrase(item.purgeAt, now)}
                  </span>
                </div>
              </div>
              <button
                className="btn"
                type="button"
                aria-label={`Restore ${item.name}`}
                onClick={() =>
                  after(owner.restore(item.id), (path) => ({
                    text: `Restored ${item.name}`,
                    action: { label: "Show", run: () => navigate(filesHref(parent(String(path)))) },
                  }))
                }
              >
                Restore
              </button>
              <button className="btn quiet icon danger" type="button" aria-label={`Delete ${item.name} forever`} onClick={() => setConfirm({ tag: "one", item })}>
                <Icon name="close" />
              </button>
            </div>
          ))}
        </div>
      )}
      {confirm.tag === "one" && (
        <ConfirmSheet
          title="Delete forever?"
          body={`${confirm.item.name} is removed from the disk now, and any link to it stops for good. This can't be undone.`}
          action="Delete forever"
          onClose={() => setConfirm({ tag: "none" })}
          onConfirm={() => after(owner.purge(confirm.item.id), () => ({ text: `Deleted ${confirm.item.name}` }))}
        />
      )}
      {confirm.tag === "all" && (
        <ConfirmSheet
          title="Empty the trash?"
          body={`${plural(items.length, "item")} are removed from the disk now, and links to them stop for good. This can't be undone.`}
          action="Delete forever"
          onClose={() => setConfirm({ tag: "none" })}
          onConfirm={() => after(owner.emptyTrash(), () => ({ text: "Trash emptied" }))}
        />
      )}
    </>
  );
}
