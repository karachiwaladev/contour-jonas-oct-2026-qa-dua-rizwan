#!/usr/bin/env node
// Planted-bug mutation run: proves the tests bite, not just pass.
//
// Each mutant is one deliberate bug in db.js. The runner copies the project to
// a temp folder, applies the bug there, runs the full suite against the copy,
// and records how many tests fail. A mutant that fails no test is "survived":
// a behaviour the tests don't actually check.
//
// The repo is never modified, so the Stop hook's auto-commit can't snapshot a
// mutant, and Ctrl-C mid-run leaves nothing to clean up.
//
// Run with `npm run test:mutation`. Exits non-zero if any mutant survives.
// Not a *.test.js file on purpose, so `npm test` doesn't pick it up.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const original = fs.readFileSync(path.join(ROOT, "db.js"), "utf8");

// [name, exact text in db.js, replacement]. Each `from` must occur exactly once.
const MUTANTS = [
  ["daily adds 2 days", 'if (repeat === "daily") return addDays(d, 1);', 'if (repeat === "daily") return addDays(d, 2);'],
  ["weekly adds 6 days", 'if (repeat === "weekly") return addDays(d, 7);', 'if (repeat === "weekly") return addDays(d, 6);'],
  ["no month-end clamp", "Math.min(anchorDay || p.d, daysInMonth(y, m))", "(anchorDay || p.d)"],
  ["no skip-ahead when overdue", "for (var guard = 0; next < today && guard < 100000; guard++) next = step(next);", ""],
  ["duplicate guard removed", 'if (task.done && task.repeat !== "none" && !task.nextCreated) {', 'if (task.done && task.repeat !== "none") {'],
  ["next copy never created", 'if (task.done && task.repeat !== "none" && !task.nextCreated) {', "if (false) {"],
  ["next copy loses tags", "tags: task.tags.slice(),", "tags: [],"],
  ["stop repeating keeps schedule", '{ repeat: "none", repeatDay: null }', "{ repeatDay: null }"],
  ["overdue on the due day", "task.dueDate < (today || todayString())", "task.dueDate <= (today || todayString())"],
  ["blank title accepted", 'if (!clean) return Promise.reject(new Error("Task title cannot be empty"));', ""],
  // Priority and editing (Ticket #6, issue #9)
  ["invalid priority accepted", "if (PRIORITIES.indexOf(p) === -1) {", "if (false) {"],
  ["priority filter ignored", 'if (priority && (t.priority || "none") !== priority) return false;', ""],
  ["next copy loses priority", "priority: task.priority,", 'priority: "none",'],
  ["edit drops new title", "patch.title = t;", ""],
  ["edit accepts blank title", 'if (!t) throw new Error("Task title cannot be empty");', ""],
  // Search (Ticket #10, issue #13)
  ["search ignores tags", "return title.indexOf(w) !== -1 || tags.some(function (tag) { return tag.indexOf(w) !== -1; });", "return title.indexOf(w) !== -1;"],
  ["search needs only one word", "return words.every(function (w) {", "return words.some(function (w) {"],
  ["filter ignores search", "if (search && !matchesSearch(t, search)) return false;", ""],
  ["search keeps the #", '.map(function (w) { return w.replace(/^#+/, ""); })', ".map(function (w) { return w; })"],
  ["search is case-sensitive", 'String(query == null ? "" : query).toLowerCase()', 'String(query == null ? "" : query)'],
  // Task count footer (Ticket #9, issue #11)
  ["footer counts nothing as done", "var done = tasks.filter(function (t) { return !!t.done; }).length;", "var done = 0;"],
  ["footer counts done as open", "return { total: tasks.length, open: tasks.length - done, done: done };", "return { total: tasks.length, open: tasks.length, done: done };"],
  ["edit always re-anchors monthly", "if (task.repeat !== before.repeat || task.dueDate !== before.dueDate) {", "if (true) {"],
];

// Files the tests need. node_modules is linked, not copied.
const COPY = ["db.js", "app.js", "index.html", "styles.css", "package.json"];

function makeWorkdir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "todo-mutation-"));
  for (const f of COPY) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  fs.cpSync(path.join(ROOT, "tests"), path.join(dir, "tests"), { recursive: true });
  // A junction works on Windows without elevation; a plain symlink elsewhere.
  fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(dir, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  return dir;
}

function runSuite(dir) {
  const r = spawnSync(process.execPath, ["--test", "tests/**/*.test.js"], { cwd: dir, encoding: "utf8" });
  const out = r.stdout + r.stderr;
  const fail = /^# fail (\d+)/m.exec(out) || /fail (\d+)/.exec(out);
  const tests = /^# tests (\d+)/m.exec(out) || /tests (\d+)/.exec(out);
  return { fail: fail ? +fail[1] : -1, tests: tests ? +tests[1] : -1 };
}

for (const [name, from] of MUTANTS) {
  const hits = original.split(from).length - 1;
  if (hits !== 1) {
    console.error(`Mutant "${name}": expected its target once in db.js, found ${hits}. Update the mutant.`);
    process.exit(2);
  }
}

const dir = makeWorkdir();
process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
process.on("SIGINT", () => process.exit(130));

const rows = [];
for (const [name, from, to] of MUTANTS) {
  fs.writeFileSync(path.join(dir, "db.js"), original.replace(from, to));
  const { fail, tests } = runSuite(dir);
  rows.push({ name, fail, tests });
  console.log(`${fail > 0 ? "killed  " : "SURVIVED"}  ${name.padEnd(32)} ${String(fail).padStart(3)} of ${tests} tests failed`);
}

const survived = rows.filter((r) => r.fail <= 0);
console.log(`\n${rows.length - survived.length} of ${rows.length} mutants killed`);
if (survived.length) {
  console.log("Survived: " + survived.map((r) => r.name).join(", "));
  process.exit(1);
}
