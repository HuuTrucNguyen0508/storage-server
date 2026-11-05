# Load generator notes

- The load generator signs in once per virtual user and reuses the session cookie.
- Every request is tagged with the app and a route template, never a raw identifier.
- This page exists only to give the PDF tools something small and valid to work on.
- Merging, compressing and rasterising it should finish in well under a second.

| Profile | Purpose |
|---|---|
| smoke | one pass per app |
| load | 20 virtual users for ten minutes |

```js
console.log("hello from the viewer");
```
