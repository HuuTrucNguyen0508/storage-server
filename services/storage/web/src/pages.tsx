// Trash, Links and Admin pages.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { type AdminUser, del, get, type Link, patch, post, type TrashItem } from "./api";
import { bytes, timeLeft, when } from "./format";
import { linkStatus } from "./ShareDialog";
import { A, ConfirmDialog, Dialog, errorText, FileIcon, Icon, useToast } from "./ui";

function PageHead({ title, sub, children }: { title: string; sub?: string; children?: React.ReactNode }) {
  return (
    <div className="browser-head page-headrow">
      <div>
        <h1 className="crumbs__here">{title}</h1>
        {sub && <p className="muted text-2 page-sub">{sub}</p>}
      </div>
      <span className="toolbar__spacer" />
      {children}
    </div>
  );
}

export function TrashPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ["trash"], queryFn: () => get<{ items: TrashItem[]; retentionDays: number }>("/api/trash") });
  const [confirm, setConfirm] = useState<null | { kind: "empty" } | { kind: "one"; item: TrashItem }>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["trash"] });
    void qc.invalidateQueries({ queryKey: ["folder"] });
    void qc.invalidateQueries({ queryKey: ["me"] });
  };
  const restore = useMutation({
    mutationFn: (it: TrashItem) => post<{ node: { name: string; parentId: string } }>(`/api/trash/${it.id}/restore`),
    onSuccess: (r) => {
      refresh();
      toast({ text: `Restored ${r.node.name}.`, tone: "ok", action: { label: "Show", run: () => (window.location.href = `/f/${r.node.parentId}`) } });
    },
    onError: (e) => toast({ text: errorText(e), tone: "danger" }),
  });
  document.title = "Trash – Storage";
  const items = q.data?.items ?? [];
  return (
    <>
      <PageHead title="Trash" sub={`Items stay here for ${q.data?.retentionDays ?? 30} days, then they are deleted for good. They still count toward your space.`}>
        {items.length > 0 && (
          <button className="btn btn--danger" onClick={() => setConfirm({ kind: "empty" })}>
            <Icon name="i-trash" />
            Empty trash
          </button>
        )}
      </PageHead>
      <div className="browser-body">
        {q.isPending ? null : items.length === 0 ? (
          <div className="empty">
            <Icon name="i-trash" size="lg" className="empty__icon" />
            <p className="empty__title">Trash is empty</p>
            <p className="empty__text">Things you delete land here first, so you can bring them back.</p>
          </div>
        ) : (
          <table className="table" aria-label="Trash">
            <thead>
              <tr>
                <th>Name</th>
                <th className="hide-sm">Was in</th>
                <th className="hide-sm">Deleted</th>
                <th className="hide-sm">Deleted for good</th>
                <th className="col-num">Size</th>
                <th className="col-actions">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.id}>
                  <td>
                    <div className="name-cell">
                      <FileIcon kind={it.kind} name={it.name} />
                      <span className="truncate">{it.name}</span>
                    </div>
                  </td>
                  <td className="hide-sm muted">{it.fromFolder || "Files"}</td>
                  <td className="hide-sm num">{when(it.trashedAt)}</td>
                  <td className="hide-sm num muted">{timeLeft(it.purgeAt).replace(" left", "")}</td>
                  <td className="col-num">{it.isDir ? <span className="muted">Folder</span> : bytes(it.size)}</td>
                  <td className="col-actions col-actions--show">
                    <span className="row trash-actions">
                      <button className="btn btn--sm" onClick={() => restore.mutate(it)}>
                        <Icon name="i-restore" />
                        Restore
                      </button>
                      <button className="btn btn--sm btn--quiet btn--icon" aria-label={`Delete ${it.name} for good`} onClick={() => setConfirm({ kind: "one", item: it })}>
                        <Icon name="i-x" />
                      </button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {confirm?.kind === "empty" && (
        <ConfirmDialog
          title="Empty trash?"
          action="Delete everything"
          danger
          onClose={() => setConfirm(null)}
          onConfirm={async () => {
            const r = await del<{ deleted: number }>("/api/trash");
            refresh();
            toast({ text: `Deleted ${r.deleted} item${r.deleted === 1 ? "" : "s"} for good.` });
          }}
        >
          <p>The {items.length} item{items.length === 1 ? "" : "s"} in trash will be deleted for good. This can't be undone.</p>
        </ConfirmDialog>
      )}
      {confirm?.kind === "one" && (
        <ConfirmDialog
          title={`Delete ${confirm.item.name} for good?`}
          action="Delete for good"
          danger
          onClose={() => setConfirm(null)}
          onConfirm={async () => {
            await del(`/api/trash/${confirm.item.id}`);
            refresh();
            toast({ text: `Deleted ${confirm.item.name} for good.` });
          }}
        >
          <p>{confirm.item.isDir ? "The folder and everything in it" : "The file"} will be deleted for good. This can't be undone.</p>
        </ConfirmDialog>
      )}
    </>
  );
}

function LinksTable({ links, admin, onRevoke }: { links: Link[]; admin?: boolean; onRevoke: (l: Link) => void }) {
  return (
    <table className="table" aria-label="Links">
      <thead>
        <tr>
          <th>Shared item</th>
          {admin && <th>Owner</th>}
          <th className="hide-sm">Status</th>
          <th className="hide-sm">Created</th>
          <th className="col-num hide-sm">Downloads</th>
          <th className="col-actions">
            <span className="sr-only">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {links.map((l) => (
          <tr key={l.id} className={l.status !== "active" ? "is-inactive" : ""}>
            <td>
              <div className="name-cell">
                <Icon name={l.hasPassword ? "i-lock" : "i-link"} className="faint" />
                {admin ? <span className="truncate">{l.nodeName}</span> : <A href={l.nodeIsDir ? `/f/${l.nodeId}` : `/?view=${l.nodeId}`}>{l.nodeName}</A>}
                <span className="badge badge--outline">{l.kind === "drop" ? "Upload only" : "View"}</span>
              </div>
            </td>
            {admin && <td>{l.owner}</td>}
            <td className="hide-sm text-2">{linkStatus(l)}</td>
            <td className="hide-sm num">{when(l.createdAt)}</td>
            <td className="col-num hide-sm">{l.downloadCount}</td>
            <td className="col-actions col-actions--show">
              {l.status === "active" && (
                <button className="btn btn--sm btn--quiet btn--danger" onClick={() => onRevoke(l)}>
                  Turn off
                </button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function LinksPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ["links", "mine"], queryFn: () => get<{ items: Link[] }>("/api/links") });
  const revoke = useMutation({
    mutationFn: (l: Link) => del(`/api/links/${l.id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["links"] });
      toast({ text: "Link turned off. It stops working right away." });
    },
  });
  document.title = "Links – Storage";
  const items = q.data?.items ?? [];
  return (
    <>
      <PageHead title="Links" sub="Public links to your files. Turn one off and it stops working on the next click." />
      <div className="browser-body">
        {q.isPending ? null : items.length === 0 ? (
          <div className="empty">
            <Icon name="i-link" size="lg" className="empty__icon" />
            <p className="empty__title">No links yet</p>
            <p className="empty__text">Open a file's menu and choose Share to create a link for someone without an account.</p>
          </div>
        ) : (
          <LinksTable links={items} onRevoke={(l) => revoke.mutate(l)} />
        )}
      </div>
    </>
  );
}

const GB = 1_000_000_000;

export function AdminPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const users = useQuery({ queryKey: ["admin", "users"], queryFn: () => get<{ items: AdminUser[]; volume: { totalBytes: number; freeBytes: number } }>("/api/admin/users") });
  const links = useQuery({ queryKey: ["admin", "links"], queryFn: () => get<{ items: Link[] }>("/api/admin/links") });
  const [editing, setEditing] = useState<AdminUser | null>(null);
  const revoke = useMutation({
    mutationFn: (l: Link) => del(`/api/admin/links/${l.id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin", "links"] });
      toast({ text: "Link turned off." });
    },
  });
  document.title = "Admin – Storage";
  const vol = users.data?.volume;
  return (
    <>
      <PageHead
        title="Admin"
        sub={vol ? `The storage volume has ${bytes(vol.freeBytes)} free of ${bytes(vol.totalBytes)}. Uploads stop when less than 5 % would be left.` : undefined}
      />
      <div className="browser-body stack stack--lg admin-body">
        <section className="stack stack--sm">
          <h2 className="section-title">People</h2>
          <div className="table-wrap">
            <table className="table" aria-label="People">
              <thead>
                <tr>
                  <th>Name</th>
                  <th className="hide-sm">Last seen</th>
                  <th className="col-num hide-sm">Files</th>
                  <th className="col-num">Used</th>
                  <th className="admin-quota">Quota</th>
                  <th className="col-actions">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {users.data?.items.map((u) => {
                  const pct = u.quotaBytes ? Math.min(100, (u.usedBytes / u.quotaBytes) * 100) : 0;
                  return (
                    <tr key={u.id}>
                      <td>
                        <div className="name-cell">
                          <span className="avatar avatar--sm">{u.username[0]?.toUpperCase()}</span>
                          <span>
                            {u.username}
                            {u.isAdmin && <span className="badge badge--accent admin-badge">Admin</span>}
                            {u.placeholder && <span className="badge badge--outline admin-badge">Not signed in yet</span>}
                          </span>
                        </div>
                      </td>
                      <td className="hide-sm num">{u.lastSeenAt ? when(u.lastSeenAt) : "Never"}</td>
                      <td className="col-num hide-sm">{u.files.toLocaleString("en-GB")}</td>
                      <td className="col-num">{bytes(u.usedBytes)}</td>
                      <td className="admin-quota">
                        <div className="stack stack--sm">
                          <span className="text-2 num">{bytes(u.quotaBytes)}</span>
                          <div className={`progress progress--thin${pct >= 95 ? " progress--danger" : pct >= 80 ? " progress--warn" : ""}`}>
                            <div className="progress__bar" style={{ "--value": `${pct}%` } as React.CSSProperties} />
                          </div>
                        </div>
                      </td>
                      <td className="col-actions col-actions--show">
                        <button className="btn btn--sm" onClick={() => setEditing(u)}>
                          Change quota
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
        <section className="stack stack--sm">
          <h2 className="section-title">All public links</h2>
          {links.data && links.data.items.length === 0 ? (
            <p className="muted">Nobody has created a public link.</p>
          ) : (
            <div className="table-wrap">
              <LinksTable links={links.data?.items ?? []} admin onRevoke={(l) => revoke.mutate(l)} />
            </div>
          )}
        </section>
      </div>
      {editing && (
        <QuotaDialog
          user={editing}
          onClose={() => setEditing(null)}
          onSave={async (quotaBytes) => {
            await patch(`/api/admin/users/${editing.id}`, { quotaBytes });
            void qc.invalidateQueries({ queryKey: ["admin"] });
            void qc.invalidateQueries({ queryKey: ["me"] });
            toast({ text: `${editing.username} can now store ${bytes(quotaBytes)}.`, tone: "ok" });
          }}
        />
      )}
    </>
  );
}

function QuotaDialog({ user, onClose, onSave }: { user: AdminUser; onClose: () => void; onSave: (q: number) => Promise<void> }) {
  const [gb, setGb] = useState(String(Math.round((user.quotaBytes / GB) * 10) / 10));
  const [error, setError] = useState("");
  return (
    <Dialog
      title={`Quota for ${user.username}`}
      size="sm"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn--primary" type="submit" form="quota-form">
            Save quota
          </button>
        </>
      }
    >
      <form
        id="quota-form"
        onSubmit={async (e) => {
          e.preventDefault();
          const v = Number(gb);
          if (!Number.isFinite(v) || v < 0) {
            setError("Type a number of gigabytes, 0 or more.");
            return;
          }
          try {
            await onSave(Math.round(v * GB));
            onClose();
          } catch (err) {
            setError(errorText(err));
          }
        }}
      >
        <label className="field">
          <span className="field__label">Quota in GB</span>
          <input className="input" data-autofocus type="number" min={0} step="0.1" value={gb} onChange={(e) => setGb(e.target.value)} />
          <span className="field__help">Uses {bytes(user.usedBytes)} now. A lower quota stops new uploads; nothing is deleted.</span>
          {error && <span className="field__error">{error}</span>}
        </label>
      </form>
    </Dialog>
  );
}
