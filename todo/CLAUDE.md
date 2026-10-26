# Todo app

A simple todo app. Ticket #3 (issue #4) built the basics: create a task, mark it
done, delete it. Ticket #4 (issue #5) added status filters, due dates and tags.
Ticket #5 (issue #6) added recurring tasks.
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
| `tests/recurring.test.js` | Recurrence date maths, next occurrences, no duplicates, stopping |
| `tests/ui.test.js` | The real page in jsdom: clicks, filters, tags, recurrence, reloads, XSS safety, no-IndexedDB error |
| `tests/mutation.js` | Not a test: plants ten bugs in `db.js` one at a time and checks the suite catches each |

Tests use Node's built-in runner, `fake-indexeddb` for an in-memory IndexedDB,
and `jsdom` for a simulated browser, so no real browser is needed.

Two more checks say whether the tests are any good, not just green:

```bash
npm run test:coverage   # line, branch and function coverage of app.js and db.js
npm run test:mutation   # every planted bug must fail at least one test; exits 1 otherwise
```

The UI tests compile `db.js` and `app.js` with `vm.Script` and their real
filenames, so coverage counts them. Add a mutant to `tests/mutation.js` when
you add a behaviour worth protecting.

## Features

- **Status filter:** All, Incomplete or Completed.
- **Due dates:** optional, stored as `YYYY-MM-DD`. Unfinished tasks past their
  date show as overdue. A task due today is not overdue.
- **Tags:** comma-separated on entry, stored lowercase and unique, spaces become `-`.
  Filter with the Tag dropdown or by clicking a tag on a task. Status and tag
  filters combine.
- **Recurring tasks:** Repeat is None, Daily, Weekly or Monthly. Ticking a
  recurring task keeps it done and adds the next occurrence, with the same title,
  tags and schedule. The next date counts from the due date and skips ahead to
  today or later, so there's never a backlog. Monthly keeps its day and clamps to
  short months (31 Jan, 28 Feb, 31 Mar). No due date means due today.
  "Stop repeating" ends a series. `nextCreated` makes each occurrence spawn
  its next copy only once, even if unticked and re-ticked.

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
- `createTodoDB(idb, name, { now })` takes a clock; tests pass a fixed date.
- Screenshots from browser checks live in `docs/screenshots/issue-<n>/`.
- Add a test for any behaviour change: logic in `filters.test.js` or
  `db.test.js`, and user-visible behaviour in `ui.test.js`.
