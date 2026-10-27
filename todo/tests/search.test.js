// Tests for search (Ticket #10, issue #13).
const test = require("node:test");
const assert = require("node:assert/strict");
const { matchesSearch, filterTasks } = require("../db.js");

const report = { id: 1, title: "Write weekly report", done: false, tags: ["work", "q4"], priority: "high" };
const milk = { id: 2, title: "Buy milk", done: true, tags: ["home"], priority: "none" };
const plants = { id: 3, title: "Water plants", done: false, tags: ["home", "garden"], priority: "low" };
const old = { id: 4, title: "Old task from before tags", done: false }; // no tags or priority fields
const all = [report, milk, plants, old];
const ids = (ts) => ts.map((t) => t.id);

test("an empty or blank query matches everything", () => {
  for (const q of ["", "   ", null, undefined, "#"]) {
    assert.equal(matchesSearch(report, q), true, JSON.stringify(q));
  }
});

test("matches the title, case-insensitively, anywhere in it", () => {
  assert.equal(matchesSearch(report, "report"), true);
  assert.equal(matchesSearch(report, "REPORT"), true);
  assert.equal(matchesSearch(report, "Weekly Rep"), true);
  assert.equal(matchesSearch(report, "eek"), true, "matches inside a word");
  assert.equal(matchesSearch(report, "milk"), false);
});

test("matches tags, with or without a leading #", () => {
  assert.equal(matchesSearch(plants, "garden"), true);
  assert.equal(matchesSearch(plants, "#garden"), true);
  assert.equal(matchesSearch(plants, "#GARD"), true, "partial and case-insensitive");
  assert.equal(matchesSearch(plants, "#work"), false);
});

test("several words narrow: each must be in the title or a tag", () => {
  assert.equal(matchesSearch(report, "rep wo"), true, "'rep' in title, 'wo' in #work");
  assert.equal(matchesSearch(report, "report home"), false, "'home' is in neither");
  assert.equal(matchesSearch(plants, "water #home"), true);
});

test("extra spaces between words don't matter", () => {
  assert.equal(matchesSearch(report, "   weekly    report  "), true);
});

test("tasks without a tags field still match on title", () => {
  assert.equal(matchesSearch(old, "before"), true);
  assert.equal(matchesSearch(old, "#work"), false);
});

test("filterTasks applies search", () => {
  assert.deepEqual(ids(filterTasks(all, { search: "home" })), [2, 3]);
  assert.deepEqual(ids(filterTasks(all, { search: "" })), [1, 2, 3, 4]);
  assert.deepEqual(ids(filterTasks(all, { search: "nothing-matches" })), []);
});

test("search combines with the status filter", () => {
  assert.deepEqual(ids(filterTasks(all, { search: "home", status: "active" })), [3]);
  assert.deepEqual(ids(filterTasks(all, { search: "home", status: "completed" })), [2]);
});

test("search combines with the tag filter", () => {
  assert.deepEqual(ids(filterTasks(all, { search: "water", tag: "home" })), [3]);
  assert.deepEqual(ids(filterTasks(all, { search: "milk", tag: "garden" })), []);
});

test("search combines with the priority filter", () => {
  assert.deepEqual(ids(filterTasks(all, { search: "e", priority: "high" })), [1]);
  assert.deepEqual(ids(filterTasks(all, { search: "o", priority: "none" })), [2, 4]);
});
