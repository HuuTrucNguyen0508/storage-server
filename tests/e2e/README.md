# End-to-end suite

Playwright (headless Chromium) journeys through the real ingress and real Authelia sign-in.
`make e2e` runs `tests/e2e/run.sh` against the live cluster (`make up` first).

| Spec | Journey |
|---|---|
| `01-portal` | `lab.localhost` leads to sign-in, then Home; admin sees admin links, alice does not; sign-out ends the session on every app |
| `02-storage` | alice uploads an image, a PDF and a Markdown file and opens each in the viewer; shares the folder with bob (read); bob sees it under "Shared with me" and cannot delete; a password public link works for an anonymous visitor and refuses a wrong password |
| `03-todo` | alice quick-adds a task with inline syntax, sees it in Today, completes a repeating task and sees the next one; shares the project with bob (editor); bob's open page follows her changes without a reload |
| `04-pdf` | Stirling PDF opens for alice; merge and compress through the ingress return PDFs; an anonymous caller never reaches it |
| `05-observability` | admin opens Grafana with no Grafana login form and "Lab overview" shows data; alice is refused |
| `06-security` | a forged `Remote-User: admin` header from alice's session is ignored by storage and todo; alice gets 403 on Prometheus, Alertmanager and Traefik |

How it works: `specs/auth.setup.ts` signs admin, alice and bob in once through the Authelia form
and saves their cookies in `.auth/` (git-ignored); every journey reuses them. Credentials and the
domain come from `.local/credentials.env` and `config/` (override with `DOMAIN`). TLS errors are
ignored because the platform CA is name-constrained and Chromium keeps its own trust store.
Specs create everything under a per-run id (`E2E<id>`) and delete it afterwards.

```sh
tests/e2e/run.sh                  # everything
tests/e2e/run.sh -g storage       # one journey
INSTALL_BROWSER=1 tests/e2e/run.sh   # also download Chromium (CI)
```

Node's API client needs the lab hostnames to resolve; `run.sh` says how to fix `/etc/hosts` if they don't.
A failed run leaves traces in `test-results/` (`pnpm exec playwright show-trace <trace.zip>`).
