import {
  Registry,
  collectDefaultMetrics,
  Histogram,
  Gauge,
  Counter,
} from "prom-client";
export function metrics() {
  const registry = new Registry<typeof Registry.OPENMETRICS_CONTENT_TYPE>();
  registry.setContentType(Registry.OPENMETRICS_CONTENT_TYPE);
  collectDefaultMetrics({ register: registry });
  const registers = [registry];
  return {
    registry,
    duration: new Histogram<string>({
      name: "http_server_request_duration_seconds",
      help: "HTTP duration",
      labelNames: ["method", "route", "status_code"],
      buckets: [
        0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60,
      ],
      enableExemplars: true,
      registers,
    }),
    active: new Gauge({
      name: "http_server_active_requests",
      help: "Active HTTP requests",
      registers,
    }),
    created: new Counter({
      name: "todo_tasks_created_total",
      help: "Tasks created in this process",
      registers,
    }),
    completed: new Counter({
      name: "todo_tasks_completed_total",
      help: "Tasks completed in this process",
      registers,
    }),
    open: new Gauge({
      name: "todo_tasks_open",
      help: "Open tasks in the database",
      registers,
    }),
    projects: new Gauge({
      name: "todo_projects",
      help: "Projects in the database",
      registers,
    }),
    live: new Gauge({
      name: "todo_live_connections",
      help: "SSE connections to this process",
      registers,
    }),
  };
}
