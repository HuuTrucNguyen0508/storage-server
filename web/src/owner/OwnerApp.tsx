import { useCallback, useEffect, useState } from "react";
import { owner, setUnauthenticatedHandler } from "../api";
import { parseRoute } from "../paths";
import { navigate, useLocationKey } from "../ui/router";
import { useTitle } from "../ui/hooks";
import { ToastHost } from "../ui/Toast";
import { AccountPage } from "./AccountPage";
import { LoginPage, SetupPage } from "./AuthPages";
import { FilesPage } from "./FilesPage";
import { LinksPage } from "./LinksPage";
import { Shell } from "./Shell";
import { TrashPage } from "./TrashPage";
import "./owner.css";

type Session = "checking" | "setup" | "login" | "in" | "unreachable";

function NotFound() {
  useTitle("Not found");
  return (
    <div className="list">
      <div className="empty">
        <h2>That page does not exist</h2>
        <p>Use Files, Links or Trash to find your way back.</p>
      </div>
    </div>
  );
}

export function OwnerApp() {
  useLocationKey();
  const route = parseRoute(location.pathname, location.search);
  const [session, setSession] = useState<Session>("checking");

  const check = useCallback(() => {
    owner.session().then(
      (s) => setSession(s.setupRequired ? "setup" : s.authenticated ? "in" : "login"),
      () => setSession("unreachable"),
    );
  }, []);

  useEffect(() => {
    setUnauthenticatedHandler(() => setSession("login"));
    check();
  }, [check]);

  useEffect(() => {
    if (session === "setup" && route.name !== "setup") navigate("/setup", { replace: true });
    if (session === "login" && route.name !== "login") navigate("/login", { replace: true });
    if (session === "in" && (route.name === "home" || route.name === "login" || route.name === "setup")) navigate("/files/", { replace: true });
  }, [session, route.name]);

  if (session === "checking") return null;
  if (session === "unreachable") {
    return (
      <main className="gate">
        <div className="pw-card">
          <h1>The server can't be reached</h1>
          <p className="muted intro">Check the connection, then reload this page.</p>
        </div>
      </main>
    );
  }
  if (session === "setup") return <SetupPage onDone={() => setSession("in")} />;
  if (session === "login") return <LoginPage onDone={() => setSession("in")} />;

  return (
    <ToastHost>
      <Shell route={route}>
        {route.name === "files" && <FilesPage path={route.path} q={route.q} />}
        {route.name === "links" && <LinksPage />}
        {route.name === "trash" && <TrashPage />}
        {route.name === "account" && <AccountPage onSignedOut={() => setSession("login")} />}
        {route.name === "unknown" && <NotFound />}
      </Shell>
    </ToastHost>
  );
}
