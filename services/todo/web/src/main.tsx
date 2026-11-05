import "../../../../packages/ui/tokens.css";
import "../../../../packages/ui/base.css";
import "./app.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ApiError } from "./api/client";
import { App } from "./app/App";
import { applyTheme, getTheme, ToastProvider } from "./components/ui";

applyTheme(getTheme());
if (location.pathname === "/" || location.pathname === "/index.html") history.replaceState(null, "", "/today" + location.search);

const client = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (n, err) => n < 2 && !(err instanceof ApiError && err.status >= 400 && err.status < 500),
      refetchOnWindowFocus: true,
      staleTime: 10_000,
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <ToastProvider>
        <App />
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
