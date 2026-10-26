# Todo app

A simple todo app. Ticket #3 (issue #4) built the basics: create a task, mark it
done, delete it. Ticket #4 (issue #5) added status filters, due dates and tags.
Tasks are stored in **IndexedDB**, the browser's built-in client-side database,
so they survive page reloads with no server.

## Run

Open `index.html` in a browser. There is no build step and no server.
It uses plain `<script>` tags rather than ES modules so it works from `file://`.

## Test

```bash
cd todo
npm install
npm test
```

| Test file | What it covers |
|---|---|
| `tests/db.test.js` | Storage: add, list, mark done, delete, persistence |
| `tests/filters.test.js` | Status and tag filters, tag parsing, due dates, overdue, old-task migration |
| `tests/ui.test.js` | The real page in jsdom: clicks, filters, tag chips, reloads, XSS safety |

Tests use Node's built-in runner, `fake-indexeddb` for an in-memory IndexedDB,
and `jsdom` for a simulated browser, so no real browser is needed.

## Features

- **Status filter:** All, Incomplete or Completed.
- **Due dates:** optional, stored as `YYYY-MM-DD`. Unfinished tasks past their
  date show as overdue. A task due today is not overdue.
- **Tags:** comma-separated on entry, stored lowercase and unique, spaces become `-`.
  Filter with the Tag dropdown or by clicking a tag on a task. Status and tag
  filters combine.

## Files

| File | What it is |
|---|---|
| `index.html` | Page markup |
| `styles.css` | Styles, light and dark |
| `db.js` | Storage (`createTodoDB`) and pure helpers (`TodoFilters`) |
| `app.js` | UI: renders tasks, filters and wires up the controls |

## Conventions

- Keep all IndexedDB code and filter logic in `db.js`. `app.js` only renders
  and calls it. That split is what makes the logic testable in Node.
- `db.js` must work both as a browser script and as a Node module. Keep the
  wrapper at the bottom of the file.
- Tasks saved by older versions lack `dueDate` and `tags`. `listTasks` fills them
  in, so never assume a stored record has every field.
- Render user text with `textContent`, never `innerHTML`.
- Add a test for any behaviour change: logic in `filters.test.js` or
  `db.test.js`, and user-visible behaviour in `ui.test.js`.
