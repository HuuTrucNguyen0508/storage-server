import { createRoot } from "react-dom/client";
import { StrictMode, type ReactNode } from "react";
import "./styles.css";

const root = createRoot(document.getElementById("root") as HTMLElement);

function render(app: ReactNode): void {
  root.render(<StrictMode>{app}</StrictMode>);
}

const share = /^\/s\/([^/]+)$/.exec(location.pathname);

// The guest listener answers 404 for every owner route, so the guest bundle must
// load without touching the owner's code or calling /api/session.
if (share?.[1] !== undefined) {
  const token = decodeURIComponent(share[1]);
  void import("./guest/GuestApp").then(({ GuestApp }) => render(<GuestApp token={token} />));
} else {
  void import("./owner/OwnerApp").then(({ OwnerApp }) => render(<OwnerApp />));
}
