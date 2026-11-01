import { useState, type FormEvent } from "react";
import { owner, type LoginSession } from "../api";
import { formatWhen } from "../format";
import { useLoad, useNow, useTitle } from "../ui/hooks";
import { Icon } from "../ui/icons";
import { navigate } from "../ui/router";
import { ConfirmSheet } from "../ui/Sheet";
import { useToast } from "../ui/Toast";
import { errorText } from "./words";

type Theme = "system" | "light" | "dark";

function currentTheme(): Theme {
  const stored = document.documentElement.dataset.theme;
  return stored === "light" || stored === "dark" ? stored : "system";
}

function ThemeChoice() {
  const [theme, setTheme] = useState<Theme>(currentTheme);
  const choose = (next: Theme) => {
    setTheme(next);
    if (next === "system") {
      delete document.documentElement.dataset.theme;
      localStorage.removeItem("storage.theme");
    } else {
      document.documentElement.dataset.theme = next;
      localStorage.setItem("storage.theme", next);
    }
  };
  return (
    <section className="panel" aria-labelledby="theme-title">
      <h2 id="theme-title">Appearance</h2>
      <div className="seg" role="group" aria-labelledby="theme-title">
        {(["system", "light", "dark"] as const).map((t) => (
          <button key={t} type="button" aria-pressed={theme === t} onClick={() => choose(t)}>
            {t === "system" ? "Same as device" : t === "light" ? "Light" : "Dark"}
          </button>
        ))}
      </div>
    </section>
  );
}

function PasswordForm({ onChanged }: { onChanged: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    owner.changePassword(current, next).then(
      () => {
        setCurrent("");
        setNext("");
        toast({ text: "Password changed. Other devices are signed out." });
        onChanged();
      },
      (err: unknown) => setError(errorText(err)),
    );
  };
  return (
    <section className="panel" aria-labelledby="password-title">
      <h2 id="password-title">Password</h2>
      <p className="muted">Changing it signs out every other device.</p>
      <form className="stack" onSubmit={submit}>
        <div>
          <label className="lbl" htmlFor="current-password">
            Current password
          </label>
          <div className="field">
            <input id="current-password" type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
          </div>
        </div>
        <div>
          <label className="lbl" htmlFor="new-password">
            New password
          </label>
          <div className="field">
            <input id="new-password" type="password" autoComplete="new-password" required value={next} onChange={(e) => setNext(e.target.value)} />
          </div>
          <p className="hint">At least 8 characters</p>
        </div>
        {error !== null && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div>
          <button className="btn primary" type="submit">
            Change password
          </button>
        </div>
      </form>
    </section>
  );
}

function shortAgent(agent: string): string {
  const browser = /(Firefox|Edg|Chrome|Safari)\/[\d.]+/.exec(agent)?.[1];
  const system = ["Android", "iPhone", "iPad", "Windows", "Mac OS X", "Linux"].find((name) => agent.includes(name));
  if (browser === undefined) return agent === "" ? "Unknown device" : agent;
  const name = browser === "Edg" ? "Edge" : browser;
  return system === undefined ? name : `${name} on ${system === "Mac OS X" ? "macOS" : system}`;
}

export function AccountPage({ onSignedOut }: { onSignedOut: () => void }) {
  useTitle("Account");
  const now = useNow();
  const toast = useToast();
  const { state, reload } = useLoad("sessions", () => owner.sessions());
  const [revoking, setRevoking] = useState<LoginSession | null>(null);
  return (
    <>
      <div className="place">
        <div className="place-row">
          <div>
            <h1>Account</h1>
            <p className="meta">One owner, this server</p>
          </div>
          <div className="actions">
            <button
              className="btn"
              type="button"
              onClick={() => {
                owner.logout().then(
                  () => {
                    onSignedOut();
                    navigate("/login", { replace: true });
                  },
                  (err: unknown) => toast({ text: errorText(err) }),
                );
              }}
            >
              Sign out
            </button>
          </div>
        </div>
      </div>
      <div className="panels">
        <section className="panel" aria-labelledby="sessions-title">
          <h2 id="sessions-title">Devices signed in</h2>
          {state.tag === "failed" && <p className="error">{errorText(state.error)}</p>}
          <div className="list">
            {state.tag === "ready" &&
              state.value.map((s) => (
                <div className="row sessionrow" key={s.id} data-session={s.current ? "current" : "other"}>
                  <div className="sel">
                    <Icon name="account" />
                  </div>
                  <div className="name">
                    <div className="txt">
                      <span className="t">
                        {shortAgent(s.userAgent)}
                        {s.current ? ", this device" : ""}
                      </span>
                      <span className="sub">
                        {s.ip}, last seen {formatWhen(s.lastSeenAt, now)}
                      </span>
                    </div>
                  </div>
                  {!s.current && (
                    <button className="btn" type="button" aria-label={`Sign out ${shortAgent(s.userAgent)}`} onClick={() => setRevoking(s)}>
                      Sign out
                    </button>
                  )}
                </div>
              ))}
          </div>
        </section>
        <PasswordForm onChanged={() => void reload()} />
        <ThemeChoice />
      </div>
      {revoking !== null && (
        <ConfirmSheet
          title="Sign out this device?"
          body={`${shortAgent(revoking.userAgent)} at ${revoking.ip} will need the password to come back.`}
          action="Sign out device"
          danger={false}
          onClose={() => setRevoking(null)}
          onConfirm={() => {
            owner.revokeSession(revoking.id).then(
              () => void reload(),
              (err: unknown) => toast({ text: errorText(err) }),
            );
          }}
        />
      )}
    </>
  );
}
