// Tests for recurring tasks (Ticket #5, issue #6).
const test = require("node:test");
const assert = require("node:assert/strict");
const { IDBFactory } = require("fake-indexeddb");
const { createTodoDB, nextDueDate, normalizeRepeat, filterTasks } = require("../db.js");

const TODAY = "2026-10-26";
const fixedClock = () => new Date(2026, 9, 26, 9, 30); // 26 Oct 2026, local time

function freshDB(name = "recurring-test", factory = new IDBFactory()) {
  return createTodoDB(factory, name, { now: fixedClock });
}

/* ---------- nextDueDate: date maths ---------- */

test("daily: next day", () => {
  assert.equal(nextDueDate("2026-10-26", "daily", TODAY), "2026-10-27");
});

test("weekly: same weekday next week", () => {
  assert.equal(nextDueDate("2026-10-26", "weekly", TODAY), "2026-11-02");
});

test("monthly: same day next month", () => {
  assert.equal(nextDueDate("2026-10-26", "monthly", TODAY), "2026-11-26");
});

test("crosses month and year boundaries", () => {
  assert.equal(nextDueDate("2026-12-31", "daily", "2026-12-31"), "2027-01-01");
  assert.equal(nextDueDate("2026-12-28", "weekly", "2026-12-28"), "2027-01-04");
  assert.equal(nextDueDate("2026-12-15", "monthly", "2026-12-15"), "2027-01-15");
});

test("monthly on the 31st clamps to the last day, then returns to the 31st", () => {
  // anchorDay 31 keeps the schedule on month ends instead of drifting to the 28th.
  assert.equal(nextDueDate("2027-01-31", "monthly", "2027-01-31", 31), "2027-02-28");
  assert.equal(nextDueDate("2027-02-28", "monthly", "2027-02-28", 31), "2027-03-31");
  assert.equal(nextDueDate("2027-03-31", "monthly", "2027-03-31", 31), "2027-04-30");
});

test("monthly respects leap years", () => {
  assert.equal(nextDueDate("2028-01-31", "monthly", "2028-01-31", 31), "2028-02-29");
  assert.equal(nextDueDate("2028-01-30", "monthly", "2028-01-30", 30), "2028-02-29");
});

test("overdue tasks skip ahead to today or later, never leaving a backlog", () => {
  assert.equal(nextDueDate("2026-10-20", "daily", TODAY), "2026-10-26", "lands on today");
  assert.equal(nextDueDate("2026-10-01", "weekly", TODAY), "2026-10-29", "stays on Thursdays");
  assert.equal(nextDueDate("2026-06-15", "monthly", TODAY), "2026-11-15");
  assert.equal(nextDueDate("2020-01-01", "daily", TODAY), "2026-10-26");
});

test("a future due date steps exactly once", () => {
  assert.equal(nextDueDate("2026-12-01", "weekly", TODAY), "2026-12-08");
});

test("no repeat means no next date", () => {
  assert.equal(nextDueDate("2026-10-26", "none", TODAY), null);
  assert.equal(nextDueDate("2026-10-26", undefined, TODAY), null);
});

test("normalizeRepeat accepts the four options and rejects others", () => {
  assert.equal(normalizeRepeat(""), "none");
  assert.equal(normalizeRepeat(null), "none");
  assert.equal(normalizeRepeat("Weekly"), "weekly");
  assert.throws(() => normalizeRepeat("yearly"), /Repeat must be one of/);
});

/* ---------- Storage ---------- */

test("addTask saves the repeat schedule", async () => {
  const db = freshDB();
  const task = await db.addTask("Gym", { repeat: "weekly", dueDate: "2026-10-27" });
  assert.equal(task.repeat, "weekly");
  assert.equal(task.dueDate, "2026-10-27");
  const [saved] = await db.listTasks();
  assert.equal(saved.repeat, "weekly");
});

test("a repeating task without a due date is due today", async () => {
  const db = freshDB();
  const task = await db.addTask("Water plants", { repeat: "daily" });
  assert.equal(task.dueDate, TODAY);
});

test("a non-repeating task without a due date stays undated", async () => {
  const db = freshDB();
  const task = await db.addTask("Someday");
  assert.equal(task.repeat, "none");
  assert.equal(task.dueDate, null);
});

test("an invalid repeat value is rejected and nothing is saved", async () => {
  const db = freshDB();
  await assert.rejects(db.addTask("Bad", { repeat: "hourly" }), /Repeat must be one of/);
  assert.deepEqual(await db.listTasks(), []);
});

test("ticking a repeating task keeps it done and adds the next occurrence", async () => {
  const db = freshDB();
  const gym = await db.addTask("Gym", { repeat: "weekly", dueDate: "2026-10-27", tags: "health" });
  await db.setDone(gym.id, true);

  const tasks = await db.listTasks();
  assert.equal(tasks.length, 2);
  const [done, next] = tasks;
  assert.equal(done.done, true, "original stays done as history");
  assert.equal(next.done, false);
  assert.equal(next.title, "Gym");
  assert.equal(next.dueDate, "2026-11-03");
  assert.equal(next.repeat, "weekly");
  assert.deepEqual(next.tags, ["health"], "tags carry over");
  assert.notEqual(next.id, done.id);
});

test("untick and re-tick never creates a duplicate", async () => {
  const db = freshDB();
  const t = await db.addTask("Standup", { repeat: "daily", dueDate: TODAY });
  await db.setDone(t.id, true);
  await db.setDone(t.id, false);
  await db.setDone(t.id, true);
  await db.setDone(t.id, true);
  const tasks = await db.listTasks();
  assert.equal(tasks.length, 2, "exactly one next occurrence");
  assert.equal(tasks[1].dueDate, "2026-10-27");
});

test("unticking a completed occurrence leaves its next copy in place", async () => {
  const db = freshDB();
  const t = await db.addTask("Standup", { repeat: "daily", dueDate: TODAY });
  await db.setDone(t.id, true);
  await db.setDone(t.id, false);
  const tasks = await db.listTasks();
  assert.deepEqual(tasks.map((x) => x.done), [false, false]);
});

test("ticking the next occurrence continues the series", async () => {
  const db = freshDB();
  const t = await db.addTask("Rent", { repeat: "monthly", dueDate: "2026-10-31" });
  await db.setDone(t.id, true);
  let tasks = await db.listTasks();
  assert.equal(tasks[1].dueDate, "2026-11-30");

  await db.setDone(tasks[1].id, true);
  tasks = await db.listTasks();
  assert.equal(tasks.length, 3);
  assert.equal(tasks[2].dueDate, "2026-12-31", "back on the 31st after a 30-day month");
});

test("ticking an overdue repeating task schedules from today, not the past", async () => {
  const db = freshDB();
  const t = await db.addTask("Daily log", { repeat: "daily", dueDate: "2026-10-01" });
  await db.setDone(t.id, true);
  const tasks = await db.listTasks();
  assert.equal(tasks.length, 2, "one new occurrence, not a backlog of 25");
  assert.equal(tasks[1].dueDate, TODAY);
});

test("stopRepeating ends the series; ticking then adds nothing", async () => {
  const db = freshDB();
  const t = await db.addTask("Newsletter", { repeat: "weekly", dueDate: TODAY });
  const stopped = await db.stopRepeating(t.id);
  assert.equal(stopped.repeat, "none");
  assert.equal(stopped.dueDate, TODAY, "keeps its due date");
  await db.setDone(t.id, true);
  const tasks = await db.listTasks();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].done, true);
});

test("stopRepeating a missing task rejects", async () => {
  const db = freshDB();
  await assert.rejects(db.stopRepeating(404), /not found/);
});

test("non-repeating tasks still just toggle", async () => {
  const db = freshDB();
  const t = await db.addTask("One-off", { dueDate: TODAY });
  await db.setDone(t.id, true);
  assert.equal((await db.listTasks()).length, 1);
});

test("recurring tasks work with the status filter", async () => {
  const db = freshDB();
  const t = await db.addTask("Gym", { repeat: "weekly", dueDate: TODAY });
  await db.setDone(t.id, true);
  const tasks = await db.listTasks();
  assert.equal(filterTasks(tasks, { status: "active" }).length, 1, "next occurrence is incomplete");
  assert.equal(filterTasks(tasks, { status: "completed" }).length, 1, "ticked one is completed");
});

test("tasks saved before recurrence existed load as non-repeating", async () => {
  const factory = new IDBFactory();
  const db = freshDB("legacy-recur", factory);
  await db.listTasks();
  await new Promise((resolve, reject) => {
    const open = factory.open("legacy-recur", 1);
    open.onsuccess = () => {
      const tx = open.result.transaction("tasks", "readwrite");
      tx.objectStore("tasks").add({ title: "old", done: false, dueDate: TODAY, tags: [], createdAt: 1 });
      tx.oncomplete = () => { open.result.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
    open.onerror = () => reject(open.error);
  });
  const db2 = freshDB("legacy-recur", factory);
  const [old] = await db2.listTasks();
  assert.equal(old.repeat, "none");
  await db2.setDone(old.id, true);
  assert.equal((await db2.listTasks()).length, 1, "ticking an old task adds no copy");
});
