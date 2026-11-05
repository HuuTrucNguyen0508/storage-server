import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import type { Project } from "../api/types";
import type { StreamOptions } from "../lib/sse";
import { keys, useAccess } from "./queries";
import { useLive } from "./live";

const stream = vi.hoisted(() => ({ options: null as StreamOptions | null }));
vi.mock("../lib/sse", () => ({ openStream: (options: StreamOptions) => { stream.options = options; return () => {}; } }));

it("has editor permissions and sharing count immediately without fetching members", () => {
  const p: Project = {id: "project", owner: "alice", inbox: false, role: "editor", memberCount: 2, data: {name: "Shared", color: "red", emoji: "", archived: false, order: 0}};
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  const {result} = renderHook(() => useAccess([p]));
  expect(result.current.get(p.id)?.role).toBe("editor");
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
});

it("persists an initial resync checkpoint and supplies it on reconnect", () => {
  localStorage.clear();
  const qc = new QueryClient();
  qc.setQueryData(keys.projects, []);
  const {unmount} = renderHook(() => useLive({me: "bob", onReminder: vi.fn(), onRemovedFrom: vi.fn()}), {wrapper: ({children}) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>});
  expect(stream.options?.lastEventId()).toBeNull();
  act(() => stream.options?.onMessages([{id: "123", event: "resync", data: "{}"}]));
  expect(stream.options?.lastEventId()).toBe("123");
  expect(localStorage.getItem("todo.lastEvent.bob")).toBe("123");
  unmount();
  qc.clear();
});
