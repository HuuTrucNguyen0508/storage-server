# Storage metrics

Prometheus text (OpenMetrics, so exemplars are included) at `GET /metrics` on port 9464, Service port `metrics`, scraped by the `ServiceMonitor` `storage/storage` every 30 s. The app port (8080) never serves metrics.

## HTTP (same names in every app)

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `http_server_request_duration_seconds` | histogram | `method`, `route`, `status_code` | Request time. `route` is the route template (`/api/nodes/{id}/content`, `/api/public/{token}/nodes/{id}/raw`), `unmatched` when nothing matched. Buckets 0.005 … 60 s. Each observation of a traced request carries an exemplar `trace_id`. Streams (downloads, ZIPs) are observed when they finish. |
| `http_server_active_requests` | gauge | | Requests in flight. |

## Storage

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `storage_upload_bytes_total` | counter | | Bytes received in upload chunks (including chunks of uploads later cancelled). |
| `storage_download_bytes_total` | counter | `kind` = `download` \| `preview` \| `public` | File bytes sent: signed-in downloads and ZIPs; viewer bytes (`/raw`, thumbnails, Office previews); anything through a public link. |
| `storage_uploads_total` | counter | `result` = `ok` \| `error` \| `quota` \| `too_large` | Finished uploads and refused ones (`quota` includes "volume nearly full"). |
| `storage_files` | gauge | | Files stored, all users, trash included. Updated every 30 s. |
| `storage_used_bytes` | gauge | | Logical bytes stored (copies count fully), trash included. Every 30 s. |
| `storage_shares_active` | gauge | `type` = `user` \| `link` | Shares with people on live items; links that still work. Every 30 s. |
| `storage_volume_free_bytes` | gauge | | Free bytes on the storage-data volume (statfs, available to the app). Every 30 s. |
| `storage_volume_size_bytes` | gauge | | Size of the storage-data volume. |
| `storage_preview_requests_total` | counter | `kind` = `image` \| `video` \| `audio` \| `pdf` \| `text` \| `markdown` \| `office` \| `other` | Viewer content requests (`/raw`, Office previews, ZIP listings as `other`). `text` covers text, code, JSON and CSV. Range requests of one video count each. |
| `storage_thumbnail_duration_seconds` | histogram | | Time to generate a thumbnail (cache misses only). Buckets 0.01 … 10 s. |
| `storage_office_conversions_total` | counter | `result` = `ok` \| `error` \| `timeout` \| `cached` \| `busy` | Office-to-PDF requests to Stirling PDF, and cache hits. |
| `storage_office_conversion_duration_seconds` | histogram | | Stirling PDF conversion time. Buckets 0.5 … 120 s. |
| `storage_link_unlock_attempts_total` | counter | `result` = `ok` \| `wrong` \| `limited` | Public link password attempts. A rise in `wrong` or `limited` means guessing. |
| `storage_forgery_refused_total` | counter | `reason` = `header` \| `origin` \| `content_type` | Mutating requests refused by the request-forgery rules. |
| `storage_purged_total` | counter | `kind` = `trash` \| `upload` \| `blob` | Background cleanup: trash older than 30 days, abandoned upload sessions, blob files deleted after their quarantine retention (not when they enter quarantine). |

## Runtime

The Go collector (`go_*`: goroutines, GC, memory, `go_sched_*`) and the process collector (`process_*`: CPU, RSS, open file descriptors) with their default names.

## Database

The PostgreSQL instance `storage-db` is scraped by the observability stack's `cnpg-clusters` PodMonitor (`cnpg_*` metrics, port 9187); the storage NetworkPolicy allows it.

## Useful queries

```promql
# p95 latency per route
histogram_quantile(0.95, sum by (le, route) (rate(http_server_request_duration_seconds_bucket{namespace="storage"}[5m])))
# error ratio
sum(rate(http_server_request_duration_seconds_count{namespace="storage",status_code=~"5.."}[5m])) / sum(rate(http_server_request_duration_seconds_count{namespace="storage"}[5m]))
# upload throughput
rate(storage_upload_bytes_total[5m])
# volume will be under 5 % free
storage_volume_free_bytes / storage_volume_size_bytes < 0.05
# password guessing
increase(storage_link_unlock_attempts_total{result=~"wrong|limited"}[15m]) > 20
```
