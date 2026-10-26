#!/usr/bin/env node
// Planted-bug mutation run: proves the tests bite, not just pass.
//
// Each mutant is one deliberate bug in db.js. The runner applies it, runs the
// full suite, records how many tests fail, and restores the original file
// before moving on (also on Ctrl-C or a crash). A mutant that fails no test
// is "survived": a behaviour the tests don't actually check.
//
// Run with `npm run test:mutation`. Exits non-zero if any mutant survives.
// Not a *.test.js file on purpose, so `npm test` doesn't pick it up.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const DB = path.join(ROOT, "db.js");
const original = fs.readFileSync(DB, "utf8");

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
  ["harmless comment change", "// m is 1-12", "// months are 1-12"],
];

function runSuite() {
  const r = spawnSync(process.execPath, ["--test", "tests/**/*.test.js"], { cwd: ROOT, encoding: "utf8" });
  const out = r.stdout + r.stderr;
  const fail = /^# fail (\d+)/m.exec(out) || /fail (\d+)/.exec(out);
  const tests = /^# tests (\d+)/m.exec(out) || /tests (\d+)/.exec(out);
  return { fail: fail ? +fail[1] : -1, tests: tests ? +tests[1] : -1 };
}

function restore() {
  if (fs.readFileSync(DB, "utf8") !== original) fs.writeFileSync(DB, original);
}
process.on("exit", restore);
process.on("SIGINT", () => { restore(); process.exit(130); });

const rows = [];
for (const [name, from, to] of MUTANTS) {
  const hits = original.split(from).length - 1;
  if (hits !== 1) {
    console.error(`Mutant "${name}": expected its target once in db.js, found ${hits}. Update the mutant.`);
    process.exit(2);
  }
  fs.writeFileSync(DB, original.replace(from, to));
  const { fail, tests } = runSuite();
  restore();
  rows.push({ name, fail, tests });
  console.log(`${fail > 0 ? "killed  " : "SURVIVED"}  ${name.padEnd(32)} ${String(fail).padStart(3)} of ${tests} tests failed`);
}

const survived = rows.filter((r) => r.fail <= 0);
console.log(`\n${rows.length - survived.length} of ${rows.length} mutants killed`);
if (survived.length) {
  console.log("Survived: " + survived.map((r) => r.name).join(", "));
  process.exit(1);
}
