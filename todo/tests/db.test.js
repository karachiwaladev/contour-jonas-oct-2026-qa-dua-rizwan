// Tests for db.js against an in-memory IndexedDB (fake-indexeddb).
// Run with: npm test   (from the todo/ folder)
const test = require("node:test");
const assert = require("node:assert/strict");
const { IDBFactory } = require("fake-indexeddb");
const { createTodoDB } = require("../db.js");

// A fresh, empty database for every test so tests never share state.
function freshDB() {
  return createTodoDB(new IDBFactory(), "todo-test");
}

test("starts with no tasks", async () => {
  const db = freshDB();
  assert.deepEqual(await db.listTasks(), []);
});

test("creates a task that is not done", async () => {
  const db = freshDB();
  const task = await db.addTask("Buy milk");
  assert.equal(task.title, "Buy milk");
  assert.equal(task.done, false);
  assert.ok(Number.isInteger(task.id), "task gets a numeric id");

  const tasks = await db.listTasks();
  assert.equal(tasks.length, 1);
  assert.deepEqual(tasks[0], task);
});

test("trims whitespace from titles", async () => {
  const db = freshDB();
  const task = await db.addTask("   Walk the dog  ");
  assert.equal(task.title, "Walk the dog");
});

test("rejects empty and whitespace-only titles", async () => {
  const db = freshDB();
  for (const bad of ["", "   ", null, undefined]) {
    await assert.rejects(db.addTask(bad), /cannot be empty/);
  }
  assert.deepEqual(await db.listTasks(), []);
});

test("lists tasks oldest first with unique ids", async () => {
  const db = freshDB();
  await db.addTask("first");
  await db.addTask("second");
  await db.addTask("third");
  const tasks = await db.listTasks();
  assert.deepEqual(tasks.map((t) => t.title), ["first", "second", "third"]);
  assert.equal(new Set(tasks.map((t) => t.id)).size, 3);
});

test("marks a task done and back to not done", async () => {
  const db = freshDB();
  const task = await db.addTask("Write report");

  const done = await db.setDone(task.id, true);
  assert.equal(done.done, true);
  assert.equal((await db.listTasks())[0].done, true);

  const undone = await db.setDone(task.id, false);
  assert.equal(undone.done, false);
  assert.equal((await db.listTasks())[0].done, false);
});

test("marking done only changes that task", async () => {
  const db = freshDB();
  const a = await db.addTask("a");
  await db.addTask("b");
  await db.setDone(a.id, true);
  const tasks = await db.listTasks();
  assert.deepEqual(tasks.map((t) => t.done), [true, false]);
  assert.equal(tasks[0].title, "a", "title is preserved when toggling");
});

test("marking a missing task done rejects", async () => {
  const db = freshDB();
  await assert.rejects(db.setDone(999, true), /not found/);
});

test("deletes a task and keeps the others", async () => {
  const db = freshDB();
  const a = await db.addTask("keep me");
  const b = await db.addTask("delete me");
  await db.deleteTask(b.id);
  const tasks = await db.listTasks();
  assert.deepEqual(tasks.map((t) => t.id), [a.id]);
});

test("deleting a missing task is a harmless no-op", async () => {
  const db = freshDB();
  await db.addTask("still here");
  await db.deleteTask(12345);
  assert.equal((await db.listTasks()).length, 1);
});

test("tasks persist across connections to the same database", async () => {
  const factory = new IDBFactory();
  const first = createTodoDB(factory, "persist");
  await first.addTask("survives reload");

  const second = createTodoDB(factory, "persist"); // like reopening the page
  const tasks = await second.listTasks();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].title, "survives reload");
});
