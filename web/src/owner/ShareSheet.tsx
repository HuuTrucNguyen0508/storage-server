import { useState, type FormEvent } from "react";
import { owner, type Share } from "../api";
import { Icon, FolderIcon } from "../ui/icons";
import { Sheet } from "../ui/Sheet";
import { useToast } from "../ui/Toast";
import { copyText } from "../ui/clipboard";
import { errorText } from "./words";

const DAY = 86_400_000;
const EXPIRY = [
  { id: "1", label: "1 day", days: 1 },
  { id: "7", label: "7 days", days: 7 },
  { id: "30", label: "30 days", days: 30 },
  { id: "never", label: "Never", days: null },
] as const;

export interface ShareTarget {
  path: string;
  name: string;
  isFolder: boolean;
}

function dateOf(choice: string, picked: string): Date | undefined {
  if (choice === "date") return picked === "" ? undefined : new Date(`${picked}T23:59:59`);
  const days = EXPIRY.find((e) => e.id === choice)?.days ?? null;
  return days === null ? undefined : new Date(Date.now() + days * DAY);
}

export function useCopyLink(): (url: string) => Promise<void> {
  const toast = useToast();
  return async (url) => {
    const copied = await copyText(url);
    toast(
      copied
        ? { text: "Link copied", action: { label: "Open", run: () => window.open(url, "_blank", "noopener") } }
        : { text: "Could not reach the clipboard. Copy the link by hand." },
    );
  };
}

function Created({ share, onClose }: { share: Share; onClose: () => void }) {
  const copy = useCopyLink();
  return (
    <>
      <p className="sheet-text">Anyone with this link can {share.kind === "drop" ? "send files to this folder" : "open it"}.</p>
      <div className="urlbox">
        <span className="code url" title={share.url} data-testid="share-url">
          {share.url}
        </span>
        <button className="btn" type="button" onClick={() => void copy(share.url)}>
          <Icon name="copy" />
          Copy
        </button>
      </div>
      <div className="sheet-actions">
        <button className="btn primary" type="button" onClick={onClose}>
          Done
        </button>
      </div>
    </>
  );
}

export function ShareSheet({ target, onClose, onCreated }: { target: ShareTarget; onClose: () => void; onCreated: () => void }) {
  const [password, setPassword] = useState("");
  const [expiry, setExpiry] = useState("7");
  const [date, setDate] = useState("");
  const [limit, setLimit] = useState("");
  const [drop, setDrop] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [share, setShare] = useState<Share | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const when = dateOf(expiry, date);
    if (when !== undefined && when.getTime() <= Date.now()) {
      setError("Pick a date in the future");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await owner.createShare({
        path: target.path,
        kind: drop ? "drop" : "link",
        ...(password === "" ? {} : { password }),
        ...(when === undefined ? {} : { expiresAt: when }),
        ...(limit === "" || drop ? {} : { maxUses: Number(limit) }),
      });
      setShare(created);
      onCreated();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet title="New link" onClose={onClose}>
      <h2>New link</h2>
      <p className="target">
        {target.isFolder ? <FolderIcon /> : <Icon name="file" />}
        <span>{target.name}</span>
      </p>
      {share !== null ? (
        <Created share={share} onClose={onClose} />
      ) : (
        <form onSubmit={(e) => void submit(e)}>
          <div className="opt">
            <div>
              <label className="what" htmlFor="share-password">
                Password
              </label>
              <p className="why">Guests type it once per device</p>
            </div>
            <div className="field">
              <input id="share-password" type="text" autoComplete="off" value={password} placeholder="None" onChange={(e) => setPassword(e.target.value)} />
            </div>
          </div>
          <div className="opt stacked">
            <div>
              <p className="what">Expires</p>
              <p className="why">The link stops working after this</p>
            </div>
            <div className="seg" role="group" aria-label="Expires">
              {EXPIRY.map((e) => (
                <button key={e.id} type="button" aria-pressed={expiry === e.id} onClick={() => setExpiry(e.id)}>
                  {e.label}
                </button>
              ))}
              <button type="button" aria-pressed={expiry === "date"} onClick={() => setExpiry("date")}>
                Date
              </button>
            </div>
          </div>
          {expiry === "date" && (
            <div className="opt">
              <label className="what" htmlFor="share-date">
                Last day
              </label>
              <div className="field">
                <input id="share-date" type="date" value={date} required onChange={(e) => setDate(e.target.value)} />
              </div>
            </div>
          )}
          {!drop && (
            <div className="opt">
              <div>
                <label className="what" htmlFor="share-limit">
                  Limit to N downloads
                </label>
                <p className="why">Counts each file or zip download</p>
              </div>
              <div className="field">
                <input id="share-limit" type="number" min={1} step={1} inputMode="numeric" value={limit} placeholder="No limit" onChange={(e) => setLimit(e.target.value)} />
              </div>
            </div>
          )}
          {target.isFolder && (
            <div className="opt">
              <div>
                <p className="what" id="share-drop-label">
                  Let guests upload into this folder
                </p>
                <p className="why">A drop link. Guests cannot see what is inside</p>
              </div>
              <label className="switch">
                <input type="checkbox" aria-labelledby="share-drop-label" checked={drop} onChange={(e) => setDrop(e.target.checked)} />
                <span className="track" />
              </label>
            </div>
          )}
          {error !== null && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <div className="sheet-actions">
            <button className="btn" type="button" onClick={onClose}>
              Cancel
            </button>
            <button className="btn primary" type="submit" disabled={busy}>
              Create link
            </button>
          </div>
        </form>
      )}
    </Sheet>
  );
}
