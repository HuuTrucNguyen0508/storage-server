# Storage security notes

What the app defends against, how, and where the tests are. Tests named here live in `internal/server/*_test.go` unless stated.

| Threat | Defence | Proof |
|---|---|---|
| Another user reads, lists, previews, downloads, renames, moves, copies, shares or deletes my files | Every node access goes through `store.Authorize`; outsiders get `404` | `TestOtherUsersCannotReachMyFiles` (27 endpoints × 6 nodes), cluster test "bob sees the read-only share" |
| A `read` share is used to change things | `NeedEdit` on every mutation; the shared folder itself is never mutable by a grantee | `TestReadShareCannotModifyAndEditShareCan` |
| Forged `Remote-User` | Traefik's `strip-identity` on every route; public handlers never read identity; private handlers need it | `TestPublicLinkPasswordLimitAndRevoke`, `TestPublicLinkExpiryAndUnknownTokens`; in the cluster a forged header is replaced by Authelia's (`alice` stays `alice`) |
| A public path reaching a private handler | Two routers chosen by path prefix (same split as the IngressRoutes); `..` paths redirect instead of being served | `TestPublicLinkExpiryAndUnknownTokens`, `TestRedactPath` |
| Cross-site request forgery from a sibling subdomain (same site, shared cookie) | `X-Requested-With: fetch` required, exact `Origin`, JSON/multipart/octet-stream bodies only, no CORS headers, no state change on GET | `TestRequestForgeryRules` (`Origin: https://pdf.lab.localhost` refused); cluster curl check |
| Stored XSS through uploaded HTML/SVG/Markdown | Only allowlisted image/video/audio types inline; everything else `attachment`, `nosniff`, `CSP: sandbox; default-src 'none'`; the SPA renders text escaped and Markdown with HTML off plus DOMPurify; the SPA's own CSP has no inline script | `TestRangeRequestsAndContentHeaders`, `logic.test.ts` ("never lets markdown run script"), Playwright checks no `<script>` in rendered Markdown |
| Guessing link tokens | 256-bit random tokens; only SHA-256 stored; compared in constant time | `TestPublicLinkExpiryAndUnknownTokens` |
| Guessing link passwords | argon2id (19 MiB, t=2); 10 failures per link and 30 per client address per 15 min, then `429` | `TestLinkPasswordRateLimit`; in the cluster, forged `X-Real-Ip` values did not escape the per-client limit (Traefik overwrites the header) |
| Link outliving its purpose | Expiry, download limit (atomic counter), revocation checked on every request; the public preview endpoint refuses kinds the viewer can't show | `TestPublicLinkPasswordLimitAndRevoke`, `TestPublicRawOnlyServesViewableKinds` |
| Tokens and passwords in logs and traces | Access logs and span attributes use the route template and a path with the token replaced by `{token}`; no request headers are logged | `TestLogsAndMetricsNeverCarryTokens`; Loki query for 43-character tokens in the last hour returned 0 lines |
| Path traversal into the volume | Blob and quarantine paths are built from ids this app generated (`^[0-9a-f]{32}$`); names are only data | `blobs_test.go`, `names_test.go` |
| A database restore deleting file contents | Unreferenced and orphan blobs go to `quarantine/` for `BLOB_QUARANTINE_RETENTION` (8 days, longer than the 7 nightly dumps); cleanup moves back any the database references again | `TestOrphanBlobIsQuarantined`, `TestCollectedBlobIsQuarantinedAndRestoreRescuesIt`, `TestQuarantineRetention` |
| Filling the disk | Per-user quota (reservations for open uploads), refuse writes that leave < 5 % free, per-chunk and per-file size limits, abandoned sessions purged after 24 h | `TestQuotaAndCancelAndAbandonedUploads`, `TestVolumeFreeSpaceFloor` |
| Decompression bombs in thumbnails | Images over 80 megapixels are not decoded; 4 decodes at once | `internal/preview` |
| Office conversion hanging the viewer | At most 2 conversions, a timeout, failures cached for 10 min, `503` when busy | `TestOfficePreviewThroughStirling` |

## Known limits

- A download limit counts `/content` and ZIP downloads. A guest can still view (and so save) what the viewer previews without using up a download: the public `/raw` endpoint serves the whole file for images in the inline allowlist (not TIFF), video, audio, PDF, and text, code, Markdown, JSON and CSV files; Office documents can be viewed as their converted PDF and ZIPs as a listing. Every other kind answers `404` on `/raw` and is only a counted download. Viewing a 2 GB video through many Range requests would otherwise burn the limit.
- The per-link password limit means ten wrong guesses lock a link for 15 minutes for everyone, including the intended guest.
- Rate limiter, upload locks and the user cache are in memory: correct for the one replica the Deployment runs (`Recreate`), not for several.
- Link tokens are shown once, when the link is made; the owner can't copy an old link again (only its hash is stored). They can make a new one.
