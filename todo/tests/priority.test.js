// Tests for task priority and editing (Ticket #6, issue #9).
const test = require("node:test");
const assert = require("node:assert/strict");
const { IDBFactory } = require("fake-indexeddb");
const { createTodoDB, normalizePriority, filterTasks, PRIORITIES } = require("../db.js");

const TODAY = "2026-10-26";
const fixedClock = () => new Date(2026, 9, 26, 9, 30);

function freshDB(name = "priority-test", factory = new IDBFactory()) {
  return createTodoDB(factory, name, { now: fixedClock });
}
const ids = (tasks) => tasks.map((t) => t.id);

/* ---------- normalizePriority ---------- */

test("priority levels are none, low, medium and high", () => {
  assert.deepEqual(PRIORITIES, ["none", "low", "medium", "high"]);
});

test("normalizePriority accepts the four levels in any case, and blank means none", () => {
  assert.equal(normalizePriority("High"), "high");
  assert.equal(normalizePriority(" medium "), "medium");
  assert.equal(normalizePriority(""), "none");
  assert.equal(normalizePriority(null), "none");
  assert.equal(normalizePriority(undefined), "none");
});

test("normalizePriority rejects anything else", () => {
  for (const bad of ["urgent", "p1", "3", "hi"]) {
    assert.throws(() => normalizePriority(bad), /Priority must be one of/, bad);
  }
});

/* ---------- Adding ---------- */

test("new tasks default to no priority", async () => {
  const db = freshDB();
  const t = await db.addTask("Plain");
  assert.equal(t.priority, "none");
});

test("addTask saves the chosen priority", async () => {
  const db = freshDB();
  await db.addTask("Urgent thing", { priority: "High" });
  const [saved] = await db.listTasks();
  assert.equal(saved.priority, "high");
});

test("addTask rejects an invalid priority and saves nothing", async () => {
  const db = freshDB();
  await assert.rejects(db.addTask("Bad", { priority: "urgent" }), /Priority must be one of/);
  assert.deepEqual(await db.listTasks(), []);
});

/* ---------- Filtering ---------- */

const sample = [
  { id: 1, done: false, tags: ["work"], priority: "high" },
  { id: 2, done: true, tags: ["work"], priority: "high" },
  { id: 3, done: false, tags: ["home"], priority: "low" },
  { id: 4, done: false, tags: [], priority: "none" },
  { id: 5, done: false, tags: ["work"] }, // older task: no priority field
];

test("priority filter shows only tasks at that level", () => {
  assert.deepEqual(ids(filterTasks(sample, { priority: "high" })), [1, 2]);
  assert.deepEqual(ids(filterTasks(sample, { priority: "low" })), [3]);
  assert.deepEqual(ids(filterTasks(sample, { priority: "medium" })), []);
});

test("priority filter 'none' includes older tasks with no priority field", () => {
  assert.deepEqual(ids(filterTasks(sample, { priority: "none" })), [4, 5]);
});

test("an empty priority filter means any priority", () => {
  assert.deepEqual(ids(filterTasks(sample, { priority: "" })), [1, 2, 3, 4, 5]);
});

test("priority combines with the status and tag filters", () => {
  assert.deepEqual(ids(filterTasks(sample, { priority: "high", status: "active" })), [1]);
  assert.deepEqual(ids(filterTasks(sample, { priority: "high", status: "completed" })), [2]);
  assert.deepEqual(ids(filterTasks(sample, { priority: "none", tag: "work" })), [5]);
});

test("filter accepts priority in any case", () => {
  assert.deepEqual(ids(filterTasks(sample, { priority: "HIGH" })), [1, 2]);
});

/* ---------- Editing ---------- */

test("updateTask changes title, priority, due date and tags", async () => {
  const db = freshDB();
  const t = await db.addTask("Draft", { tags: "work" });
  const u = await db.updateTask(t.id, {
    title: "  Final report  ",
    priority: "medium",
    dueDate: "2026-11-02",
    tags: "Work, Q4",
  });
  assert.equal(u.title, "Final report");
  assert.equal(u.priority, "medium");
  assert.equal(u.dueDate, "2026-11-02");
  assert.deepEqual(u.tags, ["work", "q4"]);
  const [saved] = await db.listTasks();
  assert.deepEqual(
    { title: saved.title, priority: saved.priority, dueDate: saved.dueDate, tags: saved.tags },
    { title: "Final report", priority: "medium", dueDate: "2026-11-02", tags: ["work", "q4"] }
  );
});

test("updateTask leaves fields it was not given alone", async () => {
  const db = freshDB();
  const t = await db.addTask("Keep me", { priority: "high", dueDate: "2026-11-01", tags: "a, b" });
  await db.setDone(t.id, true);
  const u = await db.updateTask(t.id, { title: "Renamed" });
  assert.equal(u.title, "Renamed");
  assert.equal(u.priority, "high");
  assert.equal(u.dueDate, "2026-11-01");
  assert.deepEqual(u.tags, ["a", "b"]);
  assert.equal(u.done, true, "editing doesn't untick");
  assert.equal(u.createdAt, t.createdAt, "editing doesn't move the task in the list");
});

test("updateTask can clear the due date and tags", async () => {
  const db = freshDB();
  const t = await db.addTask("Clear me", { dueDate: "2026-11-01", tags: "x" });
  const u = await db.updateTask(t.id, { dueDate: "", tags: "" });
  assert.equal(u.dueDate, null);
  assert.deepEqual(u.tags, []);
});

test("updateTask rejects a blank title and changes nothing", async () => {
  const db = freshDB();
  const t = await db.addTask("Original", { priority: "low" });
  await assert.rejects(db.updateTask(t.id, { title: "   ", priority: "high" }), /cannot be empty/);
  const [saved] = await db.listTasks();
  assert.equal(saved.title, "Original");
  assert.equal(saved.priority, "low", "a rejected edit is all-or-nothing");
});

test("updateTask rejects bad dates, priorities and repeat values", async () => {
  const db = freshDB();
  const t = await db.addTask("Valid");
  await assert.rejects(db.updateTask(t.id, { dueDate: "next week" }), /YYYY-MM-DD/);
  await assert.rejects(db.updateTask(t.id, { priority: "urgent" }), /Priority must be one of/);
  await assert.rejects(db.updateTask(t.id, { repeat: "yearly" }), /Repeat must be one of/);
});

test("updateTask on a missing task rejects", async () => {
  const db = freshDB();
  await assert.rejects(db.updateTask(404, { title: "x" }), /not found/);
});

test("turning on repeat for an undated task makes it due today", async () => {
  const db = freshDB();
  const t = await db.addTask("Water plants");
  const u = await db.updateTask(t.id, { repeat: "daily" });
  assert.equal(u.repeat, "daily");
  assert.equal(u.dueDate, TODAY);
});

test("changing a monthly task's date re-anchors it; editing other fields doesn't", async () => {
  const db = freshDB();
  const t = await db.addTask("Rent", { repeat: "monthly", dueDate: "2026-10-31" });
  await db.setDone(t.id, true);
  const next = (await db.listTasks())[1];
  assert.equal(next.dueDate, "2026-11-30", "clamped copy");

  // Renaming the clamped 30 Nov copy must keep the 31st as its anchor.
  await db.updateTask(next.id, { title: "Pay rent", dueDate: "2026-11-30" });
  await db.setDone(next.id, true);
  assert.equal((await db.listTasks())[2].dueDate, "2026-12-31", "still on month ends");

  // Moving the date to the 15th re-anchors the series to the 15th.
  const third = (await db.listTasks())[2];
  await db.updateTask(third.id, { dueDate: "2026-12-15" });
  await db.setDone(third.id, true);
  assert.equal((await db.listTasks())[3].dueDate, "2027-01-15");
});

test("the next copy of a recurring task inherits its edited priority and title", async () => {
  const db = freshDB();
  const t = await db.addTask("Gym", { repeat: "weekly", dueDate: TODAY });
  await db.updateTask(t.id, { title: "Gym session", priority: "high", tags: "health" });
  await db.setDone(t.id, true);
  const [, next] = await db.listTasks();
  assert.equal(next.title, "Gym session");
  assert.equal(next.priority, "high");
  assert.deepEqual(next.tags, ["health"]);
});

test("turning repeat off stops the series", async () => {
  const db = freshDB();
  const t = await db.addTask("Weekly sync", { repeat: "weekly", dueDate: TODAY });
  await db.updateTask(t.id, { repeat: "none" });
  await db.setDone(t.id, true);
  assert.equal((await db.listTasks()).length, 1);
});

test("tasks saved before priorities existed load with priority none and can be edited", async () => {
  const factory = new IDBFactory();
  const db = freshDB("legacy-priority", factory);
  await db.listTasks();
  await new Promise((resolve, reject) => {
    const open = factory.open("legacy-priority", 1);
    open.onsuccess = () => {
      const tx = open.result.transaction("tasks", "readwrite");
      tx.objectStore("tasks").add({ title: "old", done: false, createdAt: 1 });
      tx.oncomplete = () => { open.result.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
    open.onerror = () => reject(open.error);
  });
  const db2 = freshDB("legacy-priority", factory);
  const [old] = await db2.listTasks();
  assert.equal(old.priority, "none");
  const u = await db2.updateTask(old.id, { priority: "low" });
  assert.equal(u.priority, "low");
  assert.deepEqual(u.tags, [], "missing fields are filled in on edit too");
});
