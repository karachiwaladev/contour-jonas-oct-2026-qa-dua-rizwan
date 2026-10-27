// Tests for the task count footer (Ticket #9, issue #11).
const test = require("node:test");
const assert = require("node:assert/strict");
const { countTasks } = require("../db.js");

test("countTasks counts open and done tasks", () => {
  const tasks = [{ done: false }, { done: true }, { done: false }, { done: true }, { done: true }];
  assert.deepEqual(countTasks(tasks), { total: 5, open: 2, done: 3 });
});

test("countTasks on an empty list is all zeros", () => {
  assert.deepEqual(countTasks([]), { total: 0, open: 0, done: 0 });
});

test("countTasks treats a missing done field as open", () => {
  // Tasks from older versions may lack fields; listTasks fills them, but be safe.
  assert.deepEqual(countTasks([{}, { done: true }]), { total: 2, open: 1, done: 1 });
});

test("countTasks counts each recurring occurrence separately", () => {
  const tasks = [
    { title: "Gym", repeat: "weekly", done: true },
    { title: "Gym", repeat: "weekly", done: false },
  ];
  assert.deepEqual(countTasks(tasks), { total: 2, open: 1, done: 1 });
});
