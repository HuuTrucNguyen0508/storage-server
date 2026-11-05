// Keeps the caches in step with GET /api/events: other people's changes show
// up without a reload, reconnects resume from the last event ID, and every
// (re)connect starts with a resync that refetches the lists.

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { LiveEvent, Project, Task } from "../api/types";
import { openStream, type SseMessage, type StreamState } from "../lib/sse";
import { type Effect, findTask, reduceEvents } from "./model";
import { getCaches, keys, rememberLive, setCaches } from "./queries";

function store() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Turns SSE messages into typed events; malformed ones are skipped. */
export function parseMessages(msgs: SseMessage[]): LiveEvent[] {
  const out: LiveEvent[] = [];
  for (const m of msgs) {
    try {
      const d = JSON.parse(m.data) as Partial<LiveEvent>;
      out.push({
        kind: m.event,
        id: String(d.id ?? m.id ?? ""),
        projectId: d.projectId ?? null,
        actor: String(d.actor ?? ""),
        data: (d.data && typeof d.data === "object" ? d.data : {}) as Record<string, unknown>,
        time: String(d.time ?? ""),
      });
    } catch {
      /* not JSON: ignore */
    }
  }
  return out;
}

export interface ReminderHit {
  task: Task | undefined;
  taskId: string;
  reminderAt: string;
}

/** Only reminders that are fresh and not seen before reach the user (replays are deduplicated by event ID). */
export function freshReminder(eventId: string, time: string, seen: Set<string>, now = Date.now()): boolean {
  if (seen.has(eventId)) return false;
  const t = Date.parse(time);
  return Number.isFinite(t) ? now - t < 10 * 60_000 : true;
}

export function useLive(opts: { me: string; onReminder: (r: ReminderHit) => void; onRemovedFrom: (projectId: string) => void }): StreamState {
  const qc = useQueryClient();
  const [state, setState] = useState<StreamState>("connecting");
  const cb = useRef(opts);
  useEffect(() => {
    cb.current = opts;
  });

  useEffect(() => {
    const ls = store();
    const lastKey = `todo.lastEvent.${opts.me}`;
    const seenKey = `todo.seenReminders.${opts.me}`;
    let last: string | null = ls?.getItem(lastKey) ?? null;
    const seen = new Set<string>(JSON.parse(ls?.getItem(seenKey) ?? "[]") as string[]);

    const runEffect = (e: Effect) => {
      switch (e.type) {
        case "invalidate":
          void qc.invalidateQueries({ queryKey: e.key });
          break;
        case "resync":
          void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== "me" });
          break;
        case "project":
          qc.setQueryData<Project[]>(keys.projects, (list) => {
            if (!list) return list;
            const i = list.findIndex((p) => p.id === e.project.id);
            return i < 0 ? list : list.map((p) => (p.id === e.project.id ? { ...p, ...e.project } : p));
          });
          void qc.invalidateQueries({ queryKey: keys.projects });
          break;
        case "removed-from":
          cb.current.onRemovedFrom(e.projectId);
          break;
        case "reminder":
          if (!freshReminder(e.eventId, e.time, seen)) break;
          seen.add(e.eventId);
          ls?.setItem(seenKey, JSON.stringify([...seen].slice(-200)));
          cb.current.onReminder({ task: findTask(getCaches(qc), e.taskId), taskId: e.taskId, reminderAt: e.reminderAt });
          break;
      }
    };

    const stop = openStream({
      url: "/api/events",
      lastEventId: () => last,
      onState: setState,
      onSignedOut: () => window.location.reload(),
      onMessages: (msgs) => {
        const events = parseMessages(msgs);
        const projects = qc.getQueryData<Project[]>(keys.projects) ?? [];
        const { caches, effects } = reduceEvents(getCaches(qc), events, { me: opts.me, projectIds: new Set(projects.map((p) => p.id)) });
        setCaches(qc, caches);
        for (const e of events) {
          const t = e.data.task as Task | undefined;
          if (t && typeof t.id === "string") {
            rememberLive(t);
            if (qc.getQueryData(keys.task(t.id))) qc.setQueryData(keys.task(t.id), t);
          }
          if (/^\d+$/.test(e.id) && (!last || Number(e.id) > Number(last))) last = e.id;
        }
        if (last) ls?.setItem(lastKey, last);
        // One resync per batch is enough.
        let resynced = false;
        for (const e of effects) {
          if (e.type === "resync") {
            if (resynced) continue;
            resynced = true;
          }
          runEffect(e);
        }
      },
    });
    return stop;
  }, [qc, opts.me]);

  return state;
}
