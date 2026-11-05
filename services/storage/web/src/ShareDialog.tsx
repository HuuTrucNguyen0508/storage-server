// Share a file or folder with people and with public links.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { del, get, type Link, type Node, post, type Share } from "./api";
import { timeLeft, when } from "./format";
import { Dialog, errorText, FileIcon, Icon, useToast } from "./ui";

const EXPIRY: { label: string; days: number | null }[] = [
  { label: "Never", days: null },
  { label: "In 1 day", days: 1 },
  { label: "In 7 days", days: 7 },
  { label: "In 30 days", days: 30 },
];

export function linkStatus(l: Link): string {
  switch (l.status) {
    case "revoked":
      return "Turned off";
    case "expired":
      return "Expired";
    case "exhausted":
      return "Download limit reached";
  }
  const parts: string[] = [];
  if (l.kind === "drop") parts.push("Upload only");
  if (l.hasPassword) parts.push("password");
  if (l.expiresAt) parts.push(timeLeft(l.expiresAt));
  if (l.maxDownloads) parts.push(`${l.maxDownloads - l.downloadCount} of ${l.maxDownloads} downloads left`);
  else if (l.kind === "view") parts.push(l.downloadCount === 1 ? "downloaded once" : `downloaded ${l.downloadCount} times`);
  const s = parts.join(", ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function ShareDialog({ node, me, onClose }: { node: Node; me: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const shares = useQuery({ queryKey: ["shares", node.id], queryFn: () => get<{ items: Share[] }>(`/api/nodes/${node.id}/shares`) });
  const links = useQuery({ queryKey: ["links", node.id], queryFn: () => get<{ items: Link[] }>(`/api/nodes/${node.id}/links`) });
  const [username, setUsername] = useState("");
  const [perm, setPerm] = useState<"read" | "edit">("read");
  const [shareError, setShareError] = useState("");
  const suggestions = useQuery({
    queryKey: ["users", username],
    queryFn: () => get<{ users: string[] }>(`/api/users?q=${encodeURIComponent(username)}`),
    enabled: username.length > 0,
    staleTime: 30_000,
  });
  const listId = useId();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["shares", node.id] });
    void qc.invalidateQueries({ queryKey: ["folder"] });
  };
  const add = useMutation({
    mutationFn: (v: { username: string; permission: string }) => post<{ share: Share }>(`/api/nodes/${node.id}/shares`, v),
    onSuccess: (r) => {
      setUsername("");
      setShareError("");
      refresh();
      toast({ text: `Shared with ${r.share.username}.`, tone: "ok" });
    },
    onError: (e) => setShareError(errorText(e)),
  });
  const remove = useMutation({
    mutationFn: (s: Share) => del(`/api/shares/${s.id}`),
    onSuccess: (_r, s) => {
      refresh();
      toast({ text: `Stopped sharing with ${s.username}.` });
    },
  });

  // New link form
  const [kind, setKind] = useState<"view" | "drop">("view");
  const [password, setPassword] = useState("");
  const [expiry, setExpiry] = useState(0);
  const [limit, setLimit] = useState("");
  const [created, setCreated] = useState<string | null>(null);
  const [linkError, setLinkError] = useState("");
  const create = useMutation({
    mutationFn: () => {
      const days = EXPIRY[expiry]?.days;
      return post<{ url: string; link: Link }>(`/api/nodes/${node.id}/links`, {
        kind,
        password: password || undefined,
        expiresAt: days ? new Date(Date.now() + days * 86_400_000).toISOString() : undefined,
        maxDownloads: limit ? Number(limit) : undefined,
      });
    },
    onSuccess: (r) => {
      setCreated(r.url);
      setPassword("");
      setLimit("");
      setLinkError("");
      void qc.invalidateQueries({ queryKey: ["links"] });
      void navigator.clipboard?.writeText(r.url).then(
        () => toast({ text: "Link created and copied.", tone: "ok" }),
        () => toast({ text: "Link created.", tone: "ok" }),
      );
    },
    onError: (e) => setLinkError(errorText(e)),
  });
  const revoke = useMutation({
    mutationFn: (l: Link) => del(`/api/links/${l.id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["links"] });
      toast({ text: "Link turned off." });
    },
  });

  const activeLinks = (links.data?.items ?? []).filter((l) => l.status === "active");
  const errId = useId();
  return (
    <Dialog
      title={`Share ${node.name}`}
      icon={<FileIcon kind={node.kind} name={node.name} />}
      onClose={onClose}
      footer={
        <button className="btn btn--primary" onClick={onClose}>
          Done
        </button>
      }
    >
      <div className="stack stack--sm">
        <form
          className="form-row share-add"
          onSubmit={(e) => {
            e.preventDefault();
            if (username.trim()) add.mutate({ username: username.trim(), permission: perm });
          }}
        >
          <label className="field grow">
            <span className="field__label">Share with a person</span>
            <input
              className="input"
              data-autofocus
              placeholder="Username, for example bob"
              value={username}
              list={listId}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              aria-invalid={shareError ? true : undefined}
              aria-describedby={shareError ? errId : undefined}
              onChange={(e) => {
                setUsername(e.target.value);
                setShareError("");
              }}
            />
            <datalist id={listId}>
              {suggestions.data?.users.map((u) => <option key={u} value={u} />)}
            </datalist>
          </label>
          <div className="seg" role="radiogroup" aria-label="Access">
            <label className="seg__opt">
              <input className="sr-only" type="radio" name="acc" checked={perm === "read"} onChange={() => setPerm("read")} />
              <span>Can view</span>
            </label>
            <label className="seg__opt">
              <input className="sr-only" type="radio" name="acc" checked={perm === "edit"} onChange={() => setPerm("edit")} />
              <span>Can edit</span>
            </label>
          </div>
          <button className="btn" type="submit" disabled={add.isPending}>
            Add
          </button>
        </form>
        {shareError && (
          <span className="field__error" id={errId}>
            {shareError}
          </span>
        )}
        <p className="text-2 muted">
          {node.isDir ? "People who can edit can upload, rename and delete inside this folder." : "People who can edit can rename or delete this file."} Their uploads
          count toward your space. Someone who hasn't signed in yet sees it the first time they do.
        </p>
        <ul className="list" aria-label="People with access">
          <li className="list__item">
            <span className="avatar">{me[0]?.toUpperCase()}</span>
            <div className="list__body">
              <div className="list__title">{me} (you)</div>
              <div className="list__meta">Owner</div>
            </div>
          </li>
          {shares.data?.items.map((s) => (
            <li className="list__item" key={s.id}>
              <span className="avatar">{s.username[0]?.toUpperCase()}</span>
              <div className="list__body">
                <div className="list__title">{s.username}</div>
                <div className="list__meta">Added {when(s.createdAt).toLowerCase()}</div>
              </div>
              <div className="list__end">
                <label className="select select--quiet select--sm">
                  <select
                    aria-label={`${s.username}'s access`}
                    value={s.permission}
                    onChange={(e) => add.mutate({ username: s.username, permission: e.target.value })}
                  >
                    <option value="read">Can view</option>
                    <option value="edit">Can edit</option>
                  </select>
                </label>
                <button className="btn btn--sm btn--quiet btn--icon" aria-label={`Remove ${s.username}`} onClick={() => remove.mutate(s)}>
                  <Icon name="i-x" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div className="dialog__section">
        <span className="dialog__section-title">Public links</span>
        <p className="muted text-2">
          {kind === "drop"
            ? "Anyone with the link can upload into this folder without seeing what's in it. No sign-in needed."
            : "Anyone with the link can view and download. No sign-in needed."}
        </p>
        {created && (
          <div className="notice notice--ok">
            <Icon name="i-check-circle" />
            <div className="stack stack--sm grow">
              <span>Copy this link now. For safety, the full link is shown only once.</span>
              <div className="form-row">
                <input className="input mono text-2" readOnly value={created} aria-label="New link" onFocus={(e) => e.currentTarget.select()} />
                <button
                  className="btn"
                  type="button"
                  onClick={() => navigator.clipboard?.writeText(created).then(() => toast({ text: "Link copied.", tone: "ok" }))}
                >
                  <Icon name="i-copy" />
                  Copy link
                </button>
              </div>
            </div>
          </div>
        )}
        {activeLinks.length > 0 && (
          <ul className="list" aria-label="Links">
            {activeLinks.map((l) => (
              <li className="list__item" key={l.id}>
                <Icon name={l.hasPassword ? "i-lock" : "i-link"} className="faint" />
                <div className="list__body">
                  <div className="list__title">{l.kind === "drop" ? "Upload link" : "View link"}, created {when(l.createdAt).toLowerCase()}</div>
                  <div className="list__meta">{linkStatus(l)}</div>
                </div>
                <div className="list__end">
                  <button className="btn btn--sm btn--quiet btn--danger" onClick={() => revoke.mutate(l)}>
                    Turn off
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <form
          className="stack stack--sm"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <div className="form-grid share-link-grid">
            {node.isDir && (
              <label className="field">
                <span className="field__label">Guests can</span>
                <span className="select">
                  <select value={kind} onChange={(e) => setKind(e.target.value as "view" | "drop")}>
                    <option value="view">View and download</option>
                    <option value="drop">Only upload</option>
                  </select>
                </span>
              </label>
            )}
            <label className="field">
              <span className="field__label">Password</span>
              <input className="input" type="password" autoComplete="new-password" value={password} placeholder="Optional" onChange={(e) => setPassword(e.target.value)} />
            </label>
            <label className="field">
              <span className="field__label">Expires</span>
              <span className="select">
                <select value={expiry} onChange={(e) => setExpiry(Number(e.target.value))}>
                  {EXPIRY.map((x, i) => (
                    <option key={x.label} value={i}>
                      {x.label}
                    </option>
                  ))}
                </select>
              </span>
            </label>
            {kind === "view" && (
              <label className="field">
                <span className="field__label">Download limit</span>
                <input className="input" type="number" min={1} inputMode="numeric" placeholder="No limit" value={limit} onChange={(e) => setLimit(e.target.value)} />
              </label>
            )}
          </div>
          {linkError && <span className="field__error">{linkError}</span>}
          <div>
            <button className="btn" type="submit" disabled={create.isPending}>
              <Icon name="i-link" />
              Create link
            </button>
          </div>
        </form>
      </div>
    </Dialog>
  );
}
