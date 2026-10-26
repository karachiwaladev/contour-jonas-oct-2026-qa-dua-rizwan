# Todo app

A simple todo app from Ticket #3 (issue #4). You can create a task, mark it done
and delete it. Tasks are stored in **IndexedDB**, the browser's built-in
client-side database, so they survive page reloads with no server.

## Run

Open `index.html` in a browser. There is no build step and no server.
It uses plain `<script>` tags rather than ES modules so it works from `file://`.

## Test

```bash
cd todo
npm install
npm test
```

Tests use Node's built-in test runner with `fake-indexeddb`, an in-memory
IndexedDB, so they run without a browser.

## Files

| File | What it is |
|---|---|
| `index.html` | Page markup |
| `styles.css` | Styles, light and dark |
| `db.js` | All storage: `addTask`, `listTasks`, `setDone`, `deleteTask` |
| `app.js` | UI: renders tasks and wires up the buttons |
| `tests/db.test.js` | Storage tests |

## Conventions

- Keep all IndexedDB code in `db.js`. `app.js` only talks to its four functions.
  That split is what makes the storage testable in Node.
- `db.js` must work both as a browser script and as a Node module. Keep the
  wrapper at the bottom of the file.
- Render task titles with `textContent`, never `innerHTML`. Titles are user input.
- Add a test in `tests/db.test.js` for any storage change.
