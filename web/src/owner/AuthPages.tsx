import { useState, type FormEvent } from "react";
import { owner } from "../api";
import { useTitle } from "../ui/hooks";
import { Icon, Mark } from "../ui/icons";
import { errorText } from "./words";

function Frame({ title, intro, children }: { title: string; intro: string; children: React.ReactNode }) {
  return (
    <main className="gate">
      <div className="pw-card">
        <p className="host">
          <Mark size={20} />
          {location.hostname}
        </p>
        <h1>{title}</h1>
        <p className="muted intro">{intro}</p>
        {children}
      </div>
    </main>
  );
}

export function LoginPage({ onDone }: { onDone: () => void }) {
  useTitle("Sign in");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    owner.login(password).then(onDone, (err: unknown) => setError(errorText(err)));
  };
  return (
    <Frame title="Sign in" intro="This is a private disk. Type the owner's password to open it.">
      <form className="stack" onSubmit={submit}>
        <div className="field">
          <Icon name="lock" />
          <input type="password" aria-label="Password" placeholder="Password" autoComplete="current-password" autoFocus required value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        {error !== null && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="btn primary" type="submit">
          Sign in
        </button>
      </form>
    </Frame>
  );
}

export function SetupPage({ onDone }: { onDone: () => void }) {
  useTitle("Set up");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    owner.setup(code.trim(), password).then(onDone, (err: unknown) => setError(errorText(err)));
  };
  return (
    <Frame title="Set up this server" intro="The server printed a one-time setup code in its log when it started. Type it here and choose the owner's password.">
      <form className="stack" onSubmit={submit}>
        <div>
          <label className="lbl" htmlFor="setup-code">
            Setup code
          </label>
          <div className="field">
            <input id="setup-code" className="code" autoComplete="off" spellCheck={false} autoFocus required value={code} onChange={(e) => setCode(e.target.value)} />
          </div>
        </div>
        <div>
          <label className="lbl" htmlFor="setup-password">
            Owner password
          </label>
          <div className="field">
            <input id="setup-password" type="password" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <p className="hint">At least 8 characters</p>
        </div>
        {error !== null && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="btn primary" type="submit">
          Finish setup
        </button>
      </form>
    </Frame>
  );
}
