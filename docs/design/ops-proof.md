# Operations proof

Local Docker Engine 29.9.2 and Compose 5.6.1, 2026-11-01. All browser runs used headless Chromium. Test projects used dedicated names and directories under the user's disk cache.

## Image and profiles

`docker build -t storage-server-ops:unit2 .` built Node 26, pnpm 12.16.1, Go 1.27, and a scratch runtime. The runtime served the asset-bearing index and passed `/storage-server healthcheck` with a non-root user, read-only root, no capabilities, and no-new-privileges.

Compose project `ssopsprofiles` ran the app, monitoring, and PDF profiles. Headless Chromium completed setup, uploaded `compose-proof.txt`, and fetched identical bytes. Prometheus `/api/v1/targets` reported `app:9090` up. Grafana provisioned seven panels and its datasource proxy returned `storage_disk_free_bytes` data. Stirling `/pdf/` returned HTTP 200 and 212479 bytes containing its real page.

## Isolated tailnet

Headscale 0.27.1 ran as `ssops-headscale` on private Docker network `ssops-headscale-private`. The official Tailscale 1.90.6 sidecar joined with `--login-server=http://ssops-headscale:8080`. A second userspace client joined that same server. Its SOCKS5 proxy carried real tailnet requests to the sidecar.

Headscale did not offer certificate issuance. Containerboot reported that the node could not issue TLS certificates. A temporary test-only Serve configuration replaced HTTPS with HTTP, kept the same upstreams, and used ports 8080, 8443, and 8444. The client reached the owner session endpoint, real guest file facts, and Stirling's page. Owner routes and `/metrics` returned 404 through the guest port. The owner port's `/metrics` returned the SPA shell, not metrics.

The tracked Funnel configuration has exactly one public port, 8443, with only `http://app:8081` as its upstream. Ports 443 and 8444 stay tailnet-only. No ops port is configured. No host Tailscale command or owner auth key was used.

Unproven here: production Tailscale certificate issuance, HTTPS transport, and public Funnel reachability. These need a real tailnet with HTTPS and Funnel enabled. HTTP routing through two Headscale clients proves the proxy paths, not those external services.

## Clean-clone README check

A local clean clone of `rewrite` ran every README shell command with fresh storage and `.env`. Port 8080 was occupied by an unrelated service, so the proof selected free host ports in `.env`, as the README now documents. No unrelated listener was stopped. Headless Chromium completed first-run setup, uploaded a file, and downloaded identical bytes from the real image. The recovery commands reset the owner and produced a new setup code.

The Tailscale startup command used an intentionally unreachable test login-server and no auth key. That command verifies container creation only; the authenticated routing proof is the separate Headscale run above.

The clean-clone run found a folder-drop test race. It waited for one uploaded file, then read a separately uploaded file without waiting. The corrected test waits for both sets of bytes and passed ten repeated headless Chromium runs.

Local CI checks passed Go vet, race tests, the fast harness, typecheck, and all 79 Vitest tests. Actionlint accepted the pinned workflow. `playwright install --with-deps chromium` could not install OS packages on CachyOS because sudo required a terminal. Chromium installation and browser tests ran with the existing system dependencies. The workflow uses Ubuntu for the dependency-install step. GitHub-hosted execution is unproven until the branch is pushed.

Final clean-clone verification passed 96 Playwright tests with 10 existing skips. The env-gated real-image Compose test also passed after the README commands. The ten-repeat folder-drop check passed all ten runs. All test containers, networks, volumes, and the disk-backed clone were removed afterward. Pulled and built images remain cached.
