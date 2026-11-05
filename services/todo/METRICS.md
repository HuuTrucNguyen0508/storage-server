# Todo metrics

Only `GET :9464/metrics` exposes metrics. Public port 8080 does not expose them. OpenMetrics includes exemplars when a request has an active OpenTelemetry span.

| Metric | Type | Labels / meaning |
|---|---|---|
| `http_server_request_duration_seconds` | histogram | `method`, `route` Fastify template, `status_code`; buckets 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60 seconds; exemplar `trace_id` |
| `http_server_active_requests` | gauge | in-flight requests on this replica |
| `todo_tasks_created_total` | counter | API-created tasks, duplicates and recurring successors on this replica |
| `todo_tasks_completed_total` | counter | successful completion operations on this replica |
| `todo_tasks_open` | gauge | database-wide tasks excluding completed/deleted, collected on scrape |
| `todo_projects` | gauge | database-wide project count including Inboxes |
| `todo_live_connections` | gauge | SSE streams on this replica |

Database-wide gauges repeat on replicas: use max, not sum. Counters reset on restart; use rate or increase. Bulk import does not increment created counters. Active HTTP excludes an SSE stream after handoff to its raw socket; use todo_live_connections for streams.

prom-client's default Node/process collectors are enabled: `process_cpu_user_seconds_total`, `process_cpu_system_seconds_total`, `process_cpu_seconds_total`, `process_start_time_seconds`, `process_resident_memory_bytes`, `process_virtual_memory_bytes`, `process_heap_bytes`, `process_open_fds`, `process_max_fds`, `nodejs_eventloop_lag_seconds`, `nodejs_eventloop_lag_min_seconds`, `nodejs_eventloop_lag_max_seconds`, `nodejs_eventloop_lag_mean_seconds`, `nodejs_eventloop_lag_stddev_seconds`, `nodejs_eventloop_lag_p50_seconds`, `nodejs_eventloop_lag_p90_seconds`, `nodejs_eventloop_lag_p99_seconds`, `nodejs_active_resources`, `nodejs_active_resources_total`, `nodejs_active_handles`, `nodejs_active_handles_total`, `nodejs_active_requests`, `nodejs_active_requests_total`, `nodejs_heap_size_total_bytes`, `nodejs_heap_size_used_bytes`, `nodejs_external_memory_bytes`, `nodejs_heap_space_size_total_bytes`, `nodejs_heap_space_size_used_bytes`, `nodejs_heap_space_size_available_bytes`, `nodejs_version_info`, `nodejs_gc_duration_seconds`. Availability of Linux process metrics depends on procfs; histogram collectors append `_bucket`, `_sum`, `_count`.
