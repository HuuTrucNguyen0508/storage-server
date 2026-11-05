import "../../../../packages/ui/tokens.css";
import "../../../../packages/ui/base.css";
import "./app.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { PublicPage } from "./Public";
import { applyTheme, getTheme, ToastProvider, useLocation } from "./ui";

applyTheme(getTheme());

const client = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (n, err) => n < 2 && !((err as { status?: number }).status! >= 400 && (err as { status?: number }).status! < 500),
      refetchOnWindowFocus: true,
      staleTime: 5_000,
    },
  },
});

function Root() {
  const { path } = useLocation();
  const m = path.match(/^\/s\/([A-Za-z0-9_-]+)/);
  return m ? <PublicPage token={m[1]!} /> : <App />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <ToastProvider>
        <Root />
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
