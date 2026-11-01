import { useMemo, useState } from "react";
import { owner, type Share } from "../api";
import { formatDay, plural, untilPhrase } from "../format";
import { baseName } from "../paths";
import { useLoad, useNow, useTitle } from "../ui/hooks";
import { FolderIcon, Icon } from "../ui/icons";
import { ConfirmSheet } from "../ui/Sheet";
import { followLink } from "../ui/router";
import { useToast } from "../ui/Toast";
import { useCopyLink } from "./ShareSheet";
import { useShell } from "./Shell";
import { errorText } from "./words";

type Filter = "all" | "live" | "drop" | "ended";

const FILTERS: { id: Filter; label: string; test: (s: Share) => boolean }[] = [
  { id: "all", label: "All", test: () => true },
  { id: "live", label: "Live", test: (s) => s.state === "active" },
  { id: "drop", label: "Drop", test: (s) => s.kind === "drop" },
  { id: "ended", label: "Ended", test: (s) => s.state !== "active" },
];

function shareName(share: Share): string {
  return share.path === "" ? "All files" : baseName(share.path);
}

const SOON_MS = 2 * 86_400_000;

export function describeShare(share: Share, now: Date): { lead: string; tone: "ok" | "warn" | "muted"; rest: string } {
  const uses = share.kind === "drop" ? `used ${plural(share.uses, "time")}` : plural(share.uses, "download");
  switch (share.state) {
    case "suspended":
      return { lead: "In trash, link paused", tone: "muted", rest: `, ${uses}` };
    case "missing":
      return { lead: "Target is gone from the disk", tone: "muted", rest: `, ${uses}` };
    case "expired":
      return { lead: `Expired ${share.expiresAt === null ? "" : formatDay(share.expiresAt, now)}`.trim(), tone: "muted", rest: `, ${uses}` };
    case "exhausted":
      return { lead: "Download limit reached", tone: "muted", rest: `, ${uses}` };
    case "active": {
      const facts: string[] = [];
      if (share.kind === "drop") facts.push("uploads only");
      if (share.hasPassword) facts.push("password");
      if (share.maxUses !== null && share.kind === "link") {
        const nearly = share.maxUses - share.uses <= 1;
        if (nearly) return { lead: `Live, ${share.uses} of ${share.maxUses} downloads used`, tone: "warn", rest: "" };
        facts.push(`${share.uses} of ${share.maxUses} downloads used`);
      }
      if (share.expiresAt === null) facts.push("no expiry");
      else {
        const phrase = `expires ${untilPhrase(share.expiresAt, now)}`;
        if (share.expiresAt.getTime() - now.getTime() < SOON_MS) return { lead: `Live, ${phrase}`, tone: "warn", rest: `, ${uses}` };
        facts.push(phrase);
      }
      return { lead: `Live, ${facts.join(", ")}`, tone: "ok", rest: share.maxUses !== null && share.kind === "link" ? "" : `, ${uses}` };
    }
  }
}

function LinkRow({ share, now, onRevoke }: { share: Share; now: Date; onRevoke: (s: Share) => void }) {
  const copy = useCopyLink();
  const said = describeShare(share, now);
  const name = shareName(share);
  return (
    <div className="row linkrow" data-link={share.path}>
      <div className="sel">{share.kind === "drop" ? <Icon name="inbox" /> : <FolderOrFile share={share} />}</div>
      <div className="name">
        <div className="txt">
          <span className="t">{name}</span>
          <span className="sub">
            <span className={said.tone}>{said.lead}</span>
            {said.rest}
          </span>
        </div>
      </div>
      <button className="btn quiet icon" type="button" aria-label={`Copy link for ${name}`} onClick={() => void copy(share.url)}>
        <Icon name="copy" />
      </button>
      <button className="btn quiet icon danger" type="button" aria-label={`Revoke link for ${name}`} onClick={() => onRevoke(share)}>
        <Icon name="unlink" />
      </button>
    </div>
  );
}

function FolderOrFile({ share }: { share: Share }) {
  return share.path === "" || !/\.[^./]+$/.test(baseName(share.path)) ? <FolderIcon /> : <Icon name="file" />;
}

export function LinksPage() {
  useTitle("Links");
  const { refreshCounts } = useShell();
  const toast = useToast();
  const now = useNow();
  const { state, reload } = useLoad("links", () => owner.shares());
  const [filter, setFilter] = useState<Filter>("all");
  const [revoking, setRevoking] = useState<Share | null>(null);
  const shares = useMemo(() => (state.tag === "ready" ? state.value : []), [state]);
  const live = shares.filter((s) => s.state === "active").length;
  const shown = shares.filter(FILTERS.find((f) => f.id === filter)?.test ?? (() => true));

  return (
    <>
      <div className="place">
        <h1>Links</h1>
        <p className="meta">
          {plural(shares.length, "link")}, {live} live
        </p>
      </div>
      {state.tag === "failed" ? (
        <div className="list">
          <div className="empty">
            <h2>Links can't be loaded</h2>
            <p>{errorText(state.error)}.</p>
          </div>
        </div>
      ) : shares.length === 0 && state.tag === "ready" ? (
        <div className="list">
          <div className="empty">
            <div className="glyph">
              <Icon name="link" size={40} />
            </div>
            <h2>No links yet</h2>
            <p>Open the menu on a file or folder and choose Share. Each link you make shows up here, with how often it was used.</p>
            <div className="cta">
              <a className="btn" href="/files/" onClick={(e) => followLink(e, "/files/")}>
                <Icon name="chevronLeft" />
                Back to files
              </a>
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="filters" role="group" aria-label="Filter links">
            {FILTERS.map((f) => (
              <button key={f.id} className="btn" type="button" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
                {f.label} {shares.filter(f.test).length}
              </button>
            ))}
          </div>
          <div className="list">
            {state.tag === "loading" && <p className="loading-line">Loading</p>}
            {shown.map((share) => (
              <LinkRow key={share.id} share={share} now={now} onRevoke={setRevoking} />
            ))}
            {state.tag === "ready" && shown.length === 0 && <p className="loading-line">No links here.</p>}
          </div>
        </>
      )}
      {revoking !== null && (
        <ConfirmSheet
          title="Revoke this link?"
          body={`${shareName(revoking)} stops working at once, for everyone who has the link. This can't be undone.`}
          action="Revoke link"
          onClose={() => setRevoking(null)}
          onConfirm={() => {
            owner.revokeShare(revoking.id).then(
              () => {
                toast({ text: "Link revoked" });
                void reload();
                refreshCounts();
              },
              (err: unknown) => toast({ text: errorText(err) }),
            );
          }}
        />
      )}
    </>
  );
}
