// Tests for due dates, tags and filtering (Ticket #4).
const test = require("node:test");
const assert = require("node:assert/strict");
const { IDBFactory } = require("fake-indexeddb");
const {
  createTodoDB, parseTags, normalizeDueDate, todayString, isOverdue, filterTasks, collectTags,
} = require("../db.js");

function freshDB() {
  return createTodoDB(new IDBFactory(), "todo-test");
}

const sample = [
  { id: 1, title: "a", done: false, dueDate: null, tags: ["work"] },
  { id: 2, title: "b", done: true, dueDate: null, tags: ["work", "urgent"] },
  { id: 3, title: "c", done: false, dueDate: null, tags: [] },
  { id: 4, title: "d", done: true, dueDate: null, tags: ["home"] },
];
const ids = (tasks) => tasks.map((t) => t.id);

/* ---------- Status filter ---------- */

test("status filter: all shows every task", () => {
  assert.deepEqual(ids(filterTasks(sample, { status: "all" })), [1, 2, 3, 4]);
  assert.deepEqual(ids(filterTasks(sample)), [1, 2, 3, 4], "no options means all");
});

test("status filter: active shows only incomplete tasks", () => {
  assert.deepEqual(ids(filterTasks(sample, { status: "active" })), [1, 3]);
});

test("status filter: completed shows only done tasks", () => {
  assert.deepEqual(ids(filterTasks(sample, { status: "completed" })), [2, 4]);
});

test("status filter: unknown status falls back to all", () => {
  assert.deepEqual(ids(filterTasks(sample, { status: "bogus" })), [1, 2, 3, 4]);
});

/* ---------- Tag filter ---------- */

test("tag filter shows only tasks with that tag", () => {
  assert.deepEqual(ids(filterTasks(sample, { tag: "work" })), [1, 2]);
  assert.deepEqual(ids(filterTasks(sample, { tag: "home" })), [4]);
});

test("tag filter ignores case and a leading #", () => {
  assert.deepEqual(ids(filterTasks(sample, { tag: "#WORK" })), [1, 2]);
});

test("tag filter with an unused tag shows nothing", () => {
  assert.deepEqual(ids(filterTasks(sample, { tag: "garden" })), []);
});

test("status and tag filters combine", () => {
  assert.deepEqual(ids(filterTasks(sample, { status: "active", tag: "work" })), [1]);
  assert.deepEqual(ids(filterTasks(sample, { status: "completed", tag: "work" })), [2]);
});

test("collectTags lists each tag in use once, sorted", () => {
  assert.deepEqual(collectTags(sample), ["home", "urgent", "work"]);
  assert.deepEqual(collectTags([]), []);
});

/* ---------- Tag parsing ---------- */

test("parseTags trims, lowercases, dedupes and drops blanks", () => {
  assert.deepEqual(parseTags(" Work, urgent ,work,, "), ["work", "urgent"]);
  assert.deepEqual(parseTags(["#Home", "home"]), ["home"]);
  assert.deepEqual(parseTags("big project"), ["big-project"]);
  assert.deepEqual(parseTags(""), []);
  assert.deepEqual(parseTags(undefined), []);
});

/* ---------- Due dates ---------- */

test("normalizeDueDate accepts YYYY-MM-DD and blank", () => {
  assert.equal(normalizeDueDate("2026-10-30"), "2026-10-30");
  assert.equal(normalizeDueDate(""), null);
  assert.equal(normalizeDueDate(null), null);
});

test("normalizeDueDate rejects malformed dates", () => {
  for (const bad of ["30/10/2026", "2026-13-01", "tomorrow", "2026-1-5"]) {
    assert.throws(() => normalizeDueDate(bad), /YYYY-MM-DD/, bad);
  }
});

test("todayString formats local dates as YYYY-MM-DD", () => {
  assert.equal(todayString(new Date(2026, 0, 5)), "2026-01-05");
});

test("isOverdue: only unfinished tasks due before today", () => {
  const today = "2026-10-26";
  assert.equal(isOverdue({ done: false, dueDate: "2026-10-25" }, today), true);
  assert.equal(isOverdue({ done: false, dueDate: "2026-10-26" }, today), false, "due today is not overdue");
  assert.equal(isOverdue({ done: false, dueDate: "2026-10-27" }, today), false);
  assert.equal(isOverdue({ done: true, dueDate: "2026-10-01" }, today), false, "done tasks are never overdue");
  assert.equal(isOverdue({ done: false, dueDate: null }, today), false);
});

/* ---------- Storage ---------- */

test("addTask saves a due date and tags", async () => {
  const db = freshDB();
  const task = await db.addTask("Pay rent", { dueDate: "2026-11-01", tags: "Home, bills" });
  assert.equal(task.dueDate, "2026-11-01");
  assert.deepEqual(task.tags, ["home", "bills"]);
  const [saved] = await db.listTasks();
  assert.equal(saved.dueDate, "2026-11-01");
  assert.deepEqual(saved.tags, ["home", "bills"]);
});

test("addTask without options gives no due date and no tags", async () => {
  const db = freshDB();
  const task = await db.addTask("Plain task");
  assert.equal(task.dueDate, null);
  assert.deepEqual(task.tags, []);
});

test("addTask rejects a malformed due date and saves nothing", async () => {
  const db = freshDB();
  await assert.rejects(db.addTask("Bad date", { dueDate: "next week" }), /YYYY-MM-DD/);
  assert.deepEqual(await db.listTasks(), []);
});

test("marking done keeps the due date and tags", async () => {
  const db = freshDB();
  const task = await db.addTask("Report", { dueDate: "2026-10-30", tags: ["work"] });
  const done = await db.setDone(task.id, true);
  assert.equal(done.dueDate, "2026-10-30");
  assert.deepEqual(done.tags, ["work"]);
});

test("tasks saved before this feature still load with empty tags and no due date", async () => {
  const factory = new IDBFactory();
  const db = createTodoDB(factory, "legacy");
  await db.listTasks(); // creates the database and store

  // Write a task in the old shape, with no dueDate or tags fields.
  await new Promise((resolve, reject) => {
    const open = factory.open("legacy", 1);
    open.onsuccess = () => {
      const tx = open.result.transaction("tasks", "readwrite");
      tx.objectStore("tasks").add({ title: "old task", done: false, createdAt: 1 });
      tx.oncomplete = () => { open.result.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
    open.onerror = () => reject(open.error);
  });

  const [old] = await createTodoDB(factory, "legacy").listTasks();
  assert.equal(old.title, "old task");
  assert.equal(old.dueDate, null);
  assert.deepEqual(old.tags, []);
  assert.deepEqual(ids(filterTasks([old], { tag: "work" })), [], "old tasks don't match a tag filter");
  assert.deepEqual(ids(filterTasks([old], { status: "active" })), [old.id]);
});
