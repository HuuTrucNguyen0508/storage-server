// Settings: timezone, theme, notifications, labels, import and export.

import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { errorText, patch, post } from "../api/client";
import type { Me } from "../api/types";
import { useApp } from "../app/context";
import { keys } from "../data/queries";
import { cssColor } from "../lib/colors";
import { allTimezones, browserTimezone, timeOf } from "../lib/dates";
import { applyTheme, getTheme, Icon, type Theme, useToast } from "./ui";

export function Settings() {
  const app = useApp();
  const qc = useQueryClient();
  const toast = useToast();
  const zones = useMemo(() => allTimezones(), []);
  const [tz, setTz] = useState(app.me.timezone);
  const [theme, setTheme] = useState<Theme>(getTheme());
  const [perm, setPerm] = useState(typeof Notification !== "undefined" ? Notification.permission : "denied");
  const [importing, setImporting] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const browser = browserTimezone();

  const saveTz = async (zone: string) => {
    setTz(zone);
    try {
      const me = await patch<Me>("/api/me", { timezone: zone });
      qc.setQueryData<Me>(keys.me, (m) => (m ? { ...m, ...me } : m));
      void qc.invalidateQueries({ queryKey: ["tasks"] });
      toast({ text: `Times now show in ${zone.replace(/_/g, " ")}.`, tone: "ok" });
    } catch (e) {
      setTz(app.me.timezone);
      toast({ text: `Couldn't change your timezone. ${errorText(e)}`, tone: "danger" });
    }
  };

  const doImport = async (f: File) => {
    setImporting(true);
    try {
      if (f.size > 2 * 1024 * 1024) throw new Error("That file is over 2 MB, the import limit. Export smaller sets and import them one by one");
      let body: unknown;
      try {
        body = JSON.parse(await f.text());
      } catch {
        throw new Error("That file isn't JSON. Pick a file you exported from Todo");
      }
      const r = await post<{ projects: number; tasks: number }>("/api/import", body);
      await qc.invalidateQueries();
      toast({ text: `Imported ${r.projects} project${r.projects === 1 ? "" : "s"} and ${r.tasks} task${r.tasks === 1 ? "" : "s"}.`, tone: "ok" });
    } catch (e) {
      toast({ text: `Couldn't import ${f.name}. ${errorText(e)}`, tone: "danger", timeout: 12_000 });
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="settings">
      <div className="page-head list-head">
        <h1>Settings</h1>
      </div>

      <section className="settings__section" aria-labelledby="set-time">
        <h2 id="set-time">Time</h2>
        <label className="field settings__field">
          <span className="field__label">Your timezone</span>
          <span className="select">
            <select value={tz} onChange={(e) => void saveTz(e.target.value)}>
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z.replace(/_/g, " ")}
                </option>
              ))}
            </select>
          </span>
          <span className="field__help">
            Today, overdue and repeats follow this zone. It's {timeOf(new Date().toISOString(), tz)} there now.
          </span>
        </label>
        {browser !== tz && (
          <div className="notice settings__notice">
            <Icon name="i-info" />
            <div className="grow">This browser is set to {browser.replace(/_/g, " ")}.</div>
            <button className="btn btn--sm" onClick={() => void saveTz(browser)}>
              Use {browser.replace(/_/g, " ")}
            </button>
          </div>
        )}
      </section>

      <section className="settings__section" aria-labelledby="set-look">
        <h2 id="set-look">Appearance</h2>
        <div className="seg" role="radiogroup" aria-labelledby="set-look">
          {(["system", "light", "dark"] as Theme[]).map((t) => (
            <label className="seg__opt" key={t}>
              <input
                className="sr-only"
                type="radio"
                name="theme"
                checked={theme === t}
                onChange={() => {
                  applyTheme(t);
                  setTheme(t);
                }}
              />
              <span>{t === "system" ? "Match the system" : t === "light" ? "Light" : "Dark"}</span>
            </label>
          ))}
        </div>
      </section>

      <section className="settings__section" aria-labelledby="set-notify">
        <h2 id="set-notify">Reminders</h2>
        <p className="text-2 muted settings__text">
          Reminders show here while Todo is open. Allow notifications to see them when this tab is in the background too. Nothing is sent by email or push.
        </p>
        {typeof Notification === "undefined" ? (
          <p className="text-2">This browser doesn't support notifications.</p>
        ) : perm === "granted" ? (
          <p className="text-2 settings__ok">
            <Icon name="i-check-circle" />
            Notifications are on for this browser.
          </p>
        ) : perm === "denied" ? (
          <p className="text-2">Notifications are blocked for this site. Allow them in the browser's site settings, then reload.</p>
        ) : (
          <button className="btn" onClick={async () => setPerm(await Notification.requestPermission())}>
            <Icon name="i-bell" />
            Allow notifications
          </button>
        )}
      </section>

      <section className="settings__section" aria-labelledby="set-labels">
        <div className="row row--between">
          <h2 id="set-labels">Labels</h2>
          <button className="btn btn--sm" onClick={() => app.openLabelDialog(null)}>
            <Icon name="i-plus" />
            New label
          </button>
        </div>
        {app.labels.length === 0 ? (
          <p className="text-2 muted settings__text">No labels yet. Type @ and a name in quick add, or create one here.</p>
        ) : (
          <ul className="list list--boxed">
            {[...app.labels]
              .sort((a, b) => a.data.name.localeCompare(b.data.name))
              .map((l) => (
                <li className="list__item" key={l.id}>
                  <span className="label" style={{ "--dot": cssColor(l.data.color, l.data.name) } as React.CSSProperties}>
                    {l.data.name}
                  </span>
                  <span className="grow" />
                  <button className="btn btn--sm btn--quiet" onClick={() => app.openLabelDialog(l)}>
                    Edit
                  </button>
                </li>
              ))}
          </ul>
        )}
      </section>

      <section className="settings__section" aria-labelledby="set-data">
        <h2 id="set-data">Your data</h2>
        <p className="text-2 muted settings__text">
          Exports hold the projects you own, with their sections, tasks, comments and members, plus your labels. Shared projects someone else owns aren't included.
        </p>
        <div className="row settings__buttons">
          <a className="btn" href="/api/export?format=json" download="todo.json">
            <Icon name="i-download" />
            Export JSON
          </a>
          <a className="btn" href="/api/export?format=csv" download="todo.csv">
            <Icon name="i-download" />
            Export CSV
          </a>
          <button className={`btn${importing ? " is-loading" : ""}`} onClick={() => file.current?.click()} disabled={importing}>
            <Icon name="i-upload" />
            {importing ? "Importing" : "Import JSON"}
          </button>
          <input
            ref={file}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void doImport(f);
            }}
          />
        </div>
        <p className="text-1 faint settings__text">Importing adds copies next to what you have; importing the same file twice makes two copies. Your Inbox merges.</p>
      </section>
    </div>
  );
}
