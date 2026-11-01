import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ChangeEvent, type FormEvent } from "react";
import { ApiError, guest, postDownload, previewKindAt, type Entry, type GuestApi, type LinkFacts } from "../api";
import { formatBytes, plural, untilPhrase } from "../format";
import { baseName, crumbs, displayOrder, join, shareHref } from "../paths";
import { Preview, type PreviewItem } from "../preview/Preview";
import { useNow, useTitle } from "../ui/hooks";
import { entryIcon, FolderIcon, Icon, Mark } from "../ui/icons";
import { followLink, navigate, useLocationKey } from "../ui/router";
import { pickedFromInput, readDrop } from "../uploads/dropped";
import { UploadEngine } from "../uploads/engine";
import { summarize, type UploadItem } from "../uploads/machine";
import "./guest.css";

const host = location.hostname;

function Header() {
  return (
    <p className="host">
      <Mark size={20} />
      {host}
    </p>
  );
}

function Broken({ token }: { token: string }) {
  useTitle("Link not working");
  return (
    <main className="guest">
      <Header />
      <div className="broken">
        <div className="glyph">
          <Icon name="unlink" size={40} />
        </div>
        <h1>This link no longer works</h1>
        <p>It may have expired, reached its download limit, or been turned off by its owner. Ask the person who sent it for a new link.</p>
        <p className="tiny">
          Link <span className="code">/s/{token}</span>
        </p>
      </div>
    </main>
  );
}

function PasswordPage({ name, api, onOpen }: { name: string; api: GuestApi; onOpen: () => void }) {
  useTitle(name);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    api.open(password).then(onOpen, (err: unknown) => {
      if (err instanceof ApiError && err.code === "bad_credentials") setError("That password is not right");
      else if (err instanceof ApiError && err.code === "rate_limited") setError(`Too many tries. Try again in ${err.retryAfter ?? 30} seconds.`);
      else setError("The link could not be opened");
    });
  };
  return (
    <main className="guest pw">
      <div className="pw-sheet">
        <Header />
        <h1>{name}</h1>
        <p className="meta">This link needs a password. Ask the person who sent it.</p>
        <form onSubmit={submit}>
          <div className="field">
            <Icon name="lock" />
            <input type="password" aria-label="Password" placeholder="Password" autoComplete="off" autoFocus required value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          {error !== null && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button className="btn primary" type="submit">
            Open
          </button>
        </form>
      </div>
    </main>
  );
}

function stopsLine(facts: LinkFacts, now: Date): string {
  return facts.expiresAt === null ? "" : ` This link stops working ${untilPhrase(facts.expiresAt, now)}.`;
}

function Row({ entry, path, api, onOpen, thumb }: { entry: Entry; path: string; api: GuestApi; onOpen: () => void; thumb: boolean }) {
  const [broken, setBroken] = useState(false);
  const openable = entry.kind === "dir" || entry.kind === "file";
  return (
    <div className="row" data-path={path}>
      <div className="sel">
        {entry.kind === "dir" ? <FolderIcon /> : thumb && !broken ? <img className="thumb" src={api.source.thumbUrl(path, 256)} alt="" loading="lazy" onError={() => setBroken(true)} /> : <Icon name={entryIcon(entry)} />}
      </div>
      <div className="name">
        <div className="txt">
          {openable ? (
            <button className="t" type="button" onClick={onOpen}>
              {entry.name}
            </button>
          ) : (
            <span className="t">{entry.name}</span>
          )}
          <span className="sub">{entry.kind === "dir" ? "Folder" : formatBytes(entry.size)}</span>
        </div>
      </div>
      <div className="cell right">{entry.kind === "dir" ? "Folder" : entry.kind === "file" ? formatBytes(entry.size) : ""}</div>
      <div className="sel-end">
        {entry.kind === "file" && (
          <a className="btn quiet icon" href={api.source.downloadUrl(path)} download={entry.name} aria-label={`Download ${entry.name}`}>
            <Icon name="download" />
          </a>
        )}
        {entry.kind === "dir" && (
          <button className="btn quiet icon" type="button" aria-label={`Download ${entry.name} as zip`} onClick={() => postDownload(api.zipUrl, [path])}>
            <Icon name="download" />
          </button>
        )}
      </div>
    </div>
  );
}

function FolderPage({ facts, token, api }: { facts: LinkFacts; token: string; api: GuestApi }) {
  useLocationKey();
  const path = new URLSearchParams(location.search).get("path") ?? "";
  const title = path === "" ? facts.name || host : baseName(path);
  useTitle(title);
  const now = useNow();
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [failed, setFailed] = useState<unknown>(null);
  const [previewing, setPreviewing] = useState<number | null>(null);

  useEffect(() => {
    let live = true;
    setEntries(null);
    setFailed(null);
    api.list(path).then(
      (l) => {
        if (live) setEntries(displayOrder(l.entries));
      },
      (err: unknown) => {
        if (live) setFailed(err);
      },
    );
    return () => {
      live = false;
    };
  }, [api, path]);

  const previewable = useMemo(
    () => (entries ?? []).flatMap((e): PreviewItem[] => (e.preview === null || e.kind !== "file" ? [] : [{ path: join(path, e.name), name: e.name, size: e.size, kind: e.preview }])),
    [entries, path],
  );
  if (failed instanceof ApiError && (failed.status === 410 || failed.code === "not_found") && path === "") return <Broken token={token} />;

  const size = path === "" ? facts.size : null;
  const sizePart = size === null ? "" : `, ${formatBytes(size)}`;
  const meta = entries === null ? "" : `${plural(entries.length, "item")}${sizePart}. Shared with you.${stopsLine(facts, now)}`;

  return (
    <main className="guest">
      <Header />
      <nav className="crumbs guest-crumbs" aria-label="Path">
        {path !== "" && (
          <>
            <a href={shareHref(token, "")} onClick={(e) => followLink(e, shareHref(token, ""))}>
              {facts.name || host}
            </a>
            {crumbs(path).slice(0, -1).map((c) => (
              <span key={c.path}>
                <Icon name="chevronRight" size={16} />
                <a href={shareHref(token, c.path)} onClick={(e) => followLink(e, shareHref(token, c.path))}>
                  {c.name}
                </a>
              </span>
            ))}
            <Icon name="chevronRight" size={16} />
          </>
        )}
      </nav>
      <h1>{title}</h1>
      <p className="meta">{meta}</p>
      <div className="cta">
        <button className="btn primary" type="button" disabled={entries === null || entries.length === 0} onClick={() => postDownload(api.zipUrl, path === "" ? [] : [path])}>
          <Icon name="download" />
          Download all as zip{sizePart}
        </button>
      </div>
      {failed !== null ? (
        <div className="list">
          <p className="loading-line">This folder can't be opened.</p>
        </div>
      ) : (
        <div className="list">
          {entries === null && <p className="loading-line">Loading</p>}
          {entries?.length === 0 && <p className="loading-line">This folder is empty.</p>}
          {entries?.map((entry) => {
            const entryPath = join(path, entry.name);
            return (
              <Row
                key={entry.name}
                entry={entry}
                path={entryPath}
                api={api}
                thumb={entry.preview === "image"}
                onOpen={() => {
                  if (entry.kind === "dir") {
                    navigate(shareHref(token, entryPath));
                    return;
                  }
                  const index = previewable.findIndex((p) => p.path === entryPath);
                  if (index >= 0) setPreviewing(index);
                  else location.href = api.source.downloadUrl(entryPath);
                }}
              />
            );
          })}
        </div>
      )}
      <p className="foot">Choose a photo, video or document to preview it here. Nothing you do is visible to anyone else who has this link.</p>
      {previewing !== null && <Preview items={previewable} index={previewing} source={api.source} onIndex={setPreviewing} onClose={() => setPreviewing(null)} />}
    </main>
  );
}

function FilePage({ facts, api }: { facts: LinkFacts; api: GuestApi }) {
  useTitle(facts.name);
  const now = useNow();
  const kind = facts.preview;
  const [previewing, setPreviewing] = useState(false);
  const size = facts.size ?? 0;
  return (
    <main className="guest">
      <Header />
      <h1>{facts.name}</h1>
      <p className="meta">
        {formatBytes(size)}. Shared with you.{stopsLine(facts, now)}
      </p>
      <div className="cta">
        <a className="btn primary" href={api.source.downloadUrl("")} download={facts.name}>
          <Icon name="download" />
          Download, {formatBytes(size)}
        </a>
        {kind !== null && (
          <button className="btn" type="button" onClick={() => setPreviewing(true)}>
            <Icon name="open" />
            Preview
          </button>
        )}
      </div>
      {previewing && kind !== null && (
        <Preview items={[{ path: "", name: facts.name, size, kind }]} index={0} source={api.source} onIndex={() => {}} onClose={() => setPreviewing(false)} />
      )}
    </main>
  );
}

function sentWords(item: UploadItem): { text: string; good: boolean } {
  const { state, size } = item;
  switch (state.tag) {
    case "queued":
      return { text: "Waiting", good: false };
    case "sending":
      return { text: `${size === 0 ? 100 : Math.floor((state.sent / size) * 100)}%`, good: false };
    case "paused":
      return { text: "Paused", good: false };
    case "reconnecting":
      return { text: "Reconnecting", good: false };
    case "needs-file":
      return { text: state.stored > 0 ? `Pick again, ${formatBytes(state.stored)} kept` : "Pick again", good: false };
    case "done":
      return { text: "Sent", good: true };
    case "failed":
      return { text: state.reason, good: false };
  }
}

function SentRow({ item, engine }: { item: UploadItem; engine: UploadEngine }) {
  const { text, good } = sentWords(item);
  const { state, size } = item;
  const stored = state.tag === "done" ? size : state.stored;
  const sent = state.tag === "sending" ? state.sent : stored;
  const pct = (n: number) => `${size === 0 ? 100 : (n / size) * 100}%`;
  return (
    <div className="row" data-upload={item.path} data-state={state.tag}>
      <div className={good ? "sel done" : "sel"}>{good ? <Icon name="check" /> : <Icon name={entryIcon({ name: item.name, kind: "file" })} />}</div>
      <div className="name">
        <div className="txt">
          <span className="t">{item.name}</span>
          <span className="sub">{text}</span>
        </div>
      </div>
      <div className={good ? "cell right good" : "cell right"}>{text}</div>
      <div className="sel-end">
        {state.tag === "needs-file" && (
          <label className="btn small">
            Pick
            <input
              className="sr"
              type="file"
              aria-label={`Pick the file for ${item.name}`}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file !== undefined) void engine.pick(item.id, file);
              }}
            />
          </label>
        )}
        {state.tag === "failed" && (
          <button className="btn quiet icon" type="button" aria-label={`Retry ${item.name}`} onClick={() => engine.resume(item.id)}>
            <Icon name="play" />
          </button>
        )}
        {state.tag !== "done" && state.tag !== "needs-file" && state.tag !== "failed" && (
          <button className="btn quiet icon" type="button" aria-label={`Cancel ${item.name}`} onClick={() => void engine.cancel(item.id)}>
            <Icon name="close" />
          </button>
        )}
      </div>
      {state.tag !== "done" && (
        <div className={state.tag === "sending" ? "bar" : "bar paused"}>
          <div className="stored" style={{ width: pct(stored) }} />
          {sent > stored && <div className="flight" style={{ width: pct(sent - stored) }} />}
        </div>
      )}
    </div>
  );
}

function DropPage({ facts, token, api }: { facts: LinkFacts; token: string; api: GuestApi }) {
  const title = facts.name || host;
  useTitle(title);
  const engine = useMemo(() => new UploadEngine({ kind: "drop", token, endpoint: api.uploadEndpoint, destination: baseName }), [api, token]);
  const items = useSyncExternalStore(engine.subscribe, engine.snapshot);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const onDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      setOver(false);
      if (e.dataTransfer === null) return;
      void readDrop(e.dataTransfer).then((d) => engine.add(d.files));
    },
    [engine],
  );

  useEffect(() => {
    const over_ = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
      setOver(true);
    };
    const leave = (e: DragEvent) => {
      if (e.relatedTarget === null) setOver(false);
    };
    document.addEventListener("dragover", over_);
    document.addEventListener("dragleave", leave);
    document.addEventListener("drop", onDrop);
    return () => {
      document.removeEventListener("dragover", over_);
      document.removeEventListener("dragleave", leave);
      document.removeEventListener("drop", onDrop);
    };
  }, [onDrop]);

  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    engine.add(pickedFromInput(e.target));
    e.target.value = "";
  };

  const started = items.length > 0;
  const summary = summarize(items);
  const lead = !started
    ? "Send files to this folder. Only the owner can see them."
    : summary.settled
      ? `${plural(summary.total, "file")} sent. You can close this tab.`
      : `Sending ${plural(summary.total, "file")}. Keep this tab open until they finish.`;

  return (
    <main className="guest">
      <Header />
      <h1>{title}</h1>
      <p className="meta">{lead}</p>
      <input ref={input} className="sr" type="file" multiple tabIndex={-1} aria-label="Files to send" onChange={onPick} />
      {started ? (
        <div className={over ? "dz small over" : "dz small"}>
          <button className="btn" type="button" onClick={() => input.current?.click()}>
            <Icon name="plus" />
            Add more files
          </button>
        </div>
      ) : (
        <div className={over ? "dz over" : "dz"}>
          <Icon name="upload" />
          <div>
            <strong>Drop files here</strong>
            <p>or</p>
          </div>
          <button className="btn primary" type="button" onClick={() => input.current?.click()}>
            Choose files
          </button>
        </div>
      )}
      {started && (
        <div className="list sent">
          {items.map((item) => (
            <SentRow key={item.id} item={item} engine={engine} />
          ))}
        </div>
      )}
      {!started && <p className="foot">If the connection drops, keep this tab open. Uploads continue from where they stopped. Folders arrive as plain files.</p>}
    </main>
  );
}

type Stage =
  | { tag: "checking" }
  | { tag: "broken" }
  | { tag: "password"; facts: LinkFacts }
  | { tag: "open"; facts: LinkFacts };

export function GuestApp({ token }: { token: string }) {
  const api = useMemo(() => guest(token), [token]);
  const [stage, setStage] = useState<Stage>({ tag: "checking" });

  useEffect(() => {
    let live = true;
    const settle = (next: Stage) => {
      if (live) setStage(next);
    };
    void (async () => {
      try {
        const facts = await api.facts();
        if (facts.passwordRequired) {
          const held = facts.kind === "link" && (await holdsGrant(api, facts));
          settle(held ? { tag: "open", facts } : { tag: "password", facts });
          return;
        }
        await api.open();
        settle({ tag: "open", facts });
      } catch {
        settle({ tag: "broken" });
      }
    })();
    return () => {
      live = false;
    };
  }, [api]);

  switch (stage.tag) {
    case "checking":
      return null;
    case "broken":
      return <Broken token={token} />;
    case "password":
      return <PasswordPage name={stage.facts.name || host} api={api} onOpen={() => setStage({ tag: "open", facts: stage.facts })} />;
    case "open":
      if (stage.facts.kind === "drop") return <DropPage facts={stage.facts} token={token} api={api} />;
      if (stage.facts.isFolder) return <FolderPage facts={stage.facts} token={token} api={api} />;
      return <FilePage facts={stage.facts} api={api} />;
  }
}

async function holdsGrant(api: GuestApi, facts: LinkFacts): Promise<boolean> {
  try {
    if (facts.isFolder) await api.list("");
    else await previewKindAt(api.source.contentUrl(""));
    return true;
  } catch (err) {
    // The file link probes with HEAD, which has no body to carry a code.
    if (err instanceof ApiError && err.status === 401) return false;
    throw err;
  }
}

