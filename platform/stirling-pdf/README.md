# Stirling PDF

Stirling PDF `3.2.2` (`stirlingtools/stirling-pdf:3.2.2`, pinned in `config/versions.env`) runs in namespace `pdf` as Deployment and Service `stirling-pdf`, port 8080. `make up` deploys it from `stirling-pdf.yaml`.

- **Browser:** `https://pdf.${DOMAIN}/` behind `auth-sso-chain@kubernetescrd`. Members of `users` open it. Stirling's own login is off (`SECURITY_ENABLELOGIN=false`), so Authelia is the only gate.
- **In-cluster:** `http://stirling-pdf.pdf.svc.cluster.local:8080`, no authentication. The NetworkPolicy accepts port 8080 from four sources only: Traefik pods, pods in namespace `storage` with `app.kubernetes.io/name: storage`, and the monitoring pods `app.kubernetes.io/name: prometheus` and `prometheus-blackbox-exporter`. Every other pod times out. This was tested with an unlabelled pod in `storage` and a pod in another namespace.
- **Uploads:** Traefik has no body limit. Spring multipart allows 2000 MB per file and per request, and Tomcat swallows oversized bodies without a limit. A 629 MB upload through the ingress reached the API, which processed it and returned its own error: Ghostscript rejected the random bytes. Nothing returned 413.
- **Resources:** requests 250m CPU / 1 GiB, limits 4 CPU / 4 GiB. The JVM uses at most 60 % of the limit (`-XX:MaxRAMPercentage=60`). `/tmp` (8 GiB) and `/configs` are emptyDirs, so nothing persists.
- **Start-up:** a cold start takes about 10–60 s (Java, then LibreOffice on the first conversion). The startup probe on `/api/v1/info/status` allows 5 minutes. The first Office conversion after a start takes about 7.5 s. Later ones take about 0.1 s.
- **Pod Security:** namespace `pdf` enforces `baseline` and warns on `restricted`. The image's entrypoint must start as root: it drops to `stirlingpdfuser` with `setpriv` and runs LibreOffice as a separate sandboxed user (`stirlingofficeuser`, Landlock + seccomp). As non-root, the entrypoint exits: `ln: failed to create symbolic link '/usr/local/bin/diagnostics': Permission denied`. The container drops every capability except `CHOWN`, `SETUID`, `SETGID`, `FOWNER` and `DAC_OVERRIDE`, and sets `allowPrivilegeEscalation: false`.

## Metrics

Stirling PDF exposes no Prometheus metrics in the free edition. Micrometer's Prometheus registry is in the image, and with `MANAGEMENT_ENDPOINTS_WEB_EXPOSURE_INCLUDE=health,prometheus` the actuator lists `/actuator/prometheus`. A request to that path still returns `404`; it is gated behind the paid tier. Monitor Stirling through these instead:

- Traefik's per-service metrics: `traefik_service_requests_total{exported_service=~"pdf-stirling-pdf-.*"}` and `traefik_service_request_duration_seconds_bucket`. The ServiceMonitor doesn't honour labels, so Traefik's `service` label arrives as `exported_service`.
- A blackbox probe of `GET /api/v1/info/status`, which returns `{"version":"3.2.2","status":"UP"}`.
- Its logs.

## API calls

All endpoints take `multipart/form-data` and return the result file as the body. The full OpenAPI document is at `GET /v1/api-docs`. Every command below was run against the live cluster on 2026-11-05, and the output shown is what they printed.

### Office document to PDF (in-cluster, from the storage app)

Used by Storage's Office preview: docx, xlsx, pptx, odt, ods and odp all go to the same endpoint. LibreOffice does the conversion.

```sh
curl -sS -o sample.pdf -F fileInput=@sample.docx \
  -w 'status=%{http_code} type=%{content_type} bytes=%{size_download} time=%{time_total}s\n' \
  http://stirling-pdf.pdf.svc.cluster.local:8080/api/v1/convert/file/pdf
# status=200 type=application/pdf bytes=13062 time=7.591034s   (first conversion after start)
# status=200 ... time=0.104091s                                  (warm)
```

The response carries `Content-Disposition: form-data; name="attachment"; filename="sample_convertedToPDF.pdf"`. The bytes are a real PDF: `pdftotext` returns the document's text.

Notes for the storage app:

- Send the original file name, extension included (`-F "fileInput=@file;filename=report.docx"`). LibreOffice picks the import filter from the extension.
- A failed conversion returns 4xx/5xx with `Content-Type: application/problem+json` and a body like `{"detail": "...", "status": 500, "title": "...", "type": "/errors/..."}`. Treat any non-200 response, or a non-`application/pdf` content type, as "offer a download instead".
- Stirling runs one LibreOffice session (`libreOfficeSessionLimit: 1` in its generated `settings.yml`), so Office conversions are serialised and later ones queue. Keep the client's concurrency limit small (2–4) and use a timeout of at least 120 s. If previews queue up, raise the limit with env `PROCESS_EXECUTOR_SESSION_LIMIT_LIBRE_OFFICE_SESSION_LIMIT` in `stirling-pdf.yaml` (about 50 MB of idle RAM per extra session).

### Through the ingress with an SSO cookie

Sign in once through Authelia's API, then reuse the cookie on `pdf.${DOMAIN}`:

```sh
CA=.local/ca.crt
curl -sS -o /dev/null -c jar --cacert $CA -H 'Content-Type: application/json' \
  -d "{\"username\":\"alice\",\"password\":\"$(cat .local/passwords/alice)\"}" \
  https://auth.lab.localhost/api/firstfactor
```

Merge PDFs. Repeat `fileInput` for each file, in order:

```sh
curl -sS -b jar --cacert $CA -o merged.pdf \
  -F fileInput=@sample.pdf -F fileInput=@sample.pdf \
  -F sortType=orderProvided -F removeCertSign=true \
  https://pdf.lab.localhost/api/v1/general/merge-pdfs
# merge: 200 application/pdf 15615B 0.256223s     (pdfinfo: Pages: 2)
```

Compress. `optimizeLevel` is 1–9; the other four fields are required:

```sh
curl -sS -b jar --cacert $CA -o compressed.pdf \
  -F fileInput=@merged.pdf -F optimizeLevel=3 -F expectedOutputSize=25KB \
  -F linearize=false -F normalize=false -F grayscale=false \
  https://pdf.lab.localhost/api/v1/misc/compress-pdf
# compress: 200 application/pdf 14891B 0.026747s
```

PDF to images. `singleOrMultiple=multiple` returns a zip with one image per page. `single` with one page returns that image directly:

```sh
curl -sS -b jar --cacert $CA -o pages.zip \
  -F fileInput=@merged.pdf -F imageFormat=png -F singleOrMultiple=multiple \
  -F colorType=color -F dpi=72 -F pageNumbers=all \
  https://pdf.lab.localhost/api/v1/convert/pdf/img
# pdf-to-img: 200 application/octet-stream 8078B   (zip: merged_1.png, merged_2.png)

curl -sS -b jar --cacert $CA -o page.png \
  -F fileInput=@sample.pdf -F imageFormat=png -F singleOrMultiple=single \
  -F colorType=color -F dpi=72 -F pageNumbers=1 \
  https://pdf.lab.localhost/api/v1/convert/pdf/img
# 200 image/png 7335B   (PNG 612 x 792)
```

Without a session, Authelia answers before Stirling sees the request: `GET` gets a 302 and `POST` gets a 303 to `https://auth.lab.localhost/?rd=...&rm=POST`.

### Health

```sh
curl -s http://stirling-pdf.pdf.svc.cluster.local:8080/api/v1/info/status
# {"version":"3.2.2","status":"UP"}
```

### For load tests

Use `loadgen`'s SSO cookie on `pdf.${DOMAIN}`. A cheap call is `compress-pdf` with `optimizeLevel=1` on a small PDF (about 30 ms). An expensive one is `convert/file/pdf` with a docx, which is LibreOffice-bound. Keep the expensive call to a few virtual users so other users can still convert.
