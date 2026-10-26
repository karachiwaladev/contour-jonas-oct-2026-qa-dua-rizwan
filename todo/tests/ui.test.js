// End-to-end UI tests: load the real index.html, db.js and app.js in jsdom
// with an in-memory IndexedDB, then drive the page the way a user would.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const { IDBFactory } = require("fake-indexeddb");

const ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const dbSource = fs.readFileSync(path.join(ROOT, "db.js"), "utf8");
const appSource = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");

/** Open the app. Pass the same factory twice to simulate a page reload. */
function openApp(factory = new IDBFactory()) {
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://localhost/" });
  const { window } = dom;
  window.indexedDB = factory;
  window.eval(dbSource);
  window.eval(appSource);
  const doc = window.document;
  const $ = (sel) => doc.querySelector(sel);

  const page = {
    window, doc, factory,
    titles: () => [...doc.querySelectorAll(".task .title")].map((n) => n.textContent),
    task: (title) => [...doc.querySelectorAll(".task")].find((li) => li.querySelector(".title").textContent === title),
    countText: () => $("#task-count").textContent,
    errorText: () => ($("#error").hidden ? "" : $("#error").textContent),
    tagOptions: () => [...$("#tag-filter").options].map((o) => o.value),

    async add(title, { due = "", tags = "", repeat = "none" } = {}) {
      const before = doc.querySelectorAll(".task").length;
      $("#new-task-input").value = title;
      $("#new-task-due").value = due;
      $("#new-task-tags").value = tags;
      $("#new-task-repeat").value = repeat;
      $("#new-task-form").dispatchEvent(new window.Event("submit", { cancelable: true }));
      await waitFor(() => doc.querySelectorAll(".task").length !== before || page.errorText());
    },
    async toggle(title) {
      const box = page.task(title).querySelector("input[type=checkbox]");
      box.checked = !box.checked;
      box.dispatchEvent(new window.Event("change"));
      await settle();
    },
    async remove(title) {
      page.task(title).querySelector(".delete").click();
      await waitFor(() => !page.task(title));
    },
    async status(name) {
      doc.querySelector(`[data-status="${name}"]`).click();
      await settle();
    },
    async tag(value) {
      const sel = $("#tag-filter");
      sel.value = value;
      sel.dispatchEvent(new window.Event("change"));
      await settle();
    },
  };
  return page;
}

// IndexedDB work is async; give pending transactions a moment to finish.
const settle = () => new Promise((r) => setTimeout(r, 30));
async function waitFor(check, ms = 1000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await settle();
  }
  throw new Error("Timed out waiting for the page to update");
}

test("shows the empty state on first load", async () => {
  const app = openApp();
  await settle();
  assert.deepEqual(app.titles(), []);
  assert.equal(app.doc.querySelector("#empty-state").hidden, false);
  assert.equal(app.doc.querySelector("#tag-filter").disabled, true, "tag filter is off with no tags");
});

test("creates, completes and deletes a task", async () => {
  const app = openApp();
  await settle();
  await app.add("Buy milk");
  assert.deepEqual(app.titles(), ["Buy milk"]);
  assert.equal(app.doc.querySelector("#new-task-input").value, "", "input clears after adding");

  await app.toggle("Buy milk");
  assert.ok(app.task("Buy milk").classList.contains("done"));

  await app.remove("Buy milk");
  assert.deepEqual(app.titles(), []);
});

test("blank titles show an error and add nothing", async () => {
  const app = openApp();
  await settle();
  await app.add("   ");
  assert.match(app.errorText(), /cannot be empty/);
  assert.deepEqual(app.titles(), []);
});

test("status filter buttons show all, incomplete and completed tasks", async () => {
  const app = openApp();
  await settle();
  await app.add("open task");
  await app.add("finished task");
  await app.toggle("finished task");

  await app.status("active");
  assert.deepEqual(app.titles(), ["open task"]);
  assert.equal(app.doc.querySelector('[data-status="active"]').getAttribute("aria-pressed"), "true");

  await app.status("completed");
  assert.deepEqual(app.titles(), ["finished task"]);

  await app.status("all");
  assert.deepEqual(app.titles(), ["open task", "finished task"]);
  assert.match(app.countText(), /Showing 2 of 2/);
});

test("a filtered-out task leaves the list when its status changes", async () => {
  const app = openApp();
  await settle();
  await app.add("todo item");
  await app.status("active");
  await app.toggle("todo item");
  assert.deepEqual(app.titles(), [], "completing it hides it under Incomplete");
  assert.match(app.doc.querySelector("#empty-state").textContent, /No tasks match/);
});

test("due dates are shown and overdue tasks are flagged", async () => {
  const app = openApp();
  await settle();
  await app.add("Late report", { due: "2000-01-01" });
  await app.add("Future trip", { due: "2999-12-31" });

  const late = app.task("Late report");
  assert.ok(late.classList.contains("overdue"));
  assert.match(late.querySelector(".due").textContent, /^Overdue:/);

  const future = app.task("Future trip");
  assert.ok(!future.classList.contains("overdue"));
  assert.match(future.querySelector(".due").textContent, /^Due /);

  await app.toggle("Late report");
  assert.ok(!app.task("Late report").classList.contains("overdue"), "done tasks are not overdue");
});

test("tags are shown on tasks and fill the tag filter", async () => {
  const app = openApp();
  await settle();
  await app.add("Email boss", { tags: "Work, urgent" });
  await app.add("Water plants", { tags: "home" });
  await app.add("No tags");

  const chips = [...app.task("Email boss").querySelectorAll(".tag")].map((n) => n.textContent);
  assert.deepEqual(chips, ["#work", "#urgent"]);
  assert.deepEqual(app.tagOptions(), ["", "home", "urgent", "work"]);
});

test("tag filter shows only tasks with that tag and combines with status", async () => {
  const app = openApp();
  await settle();
  await app.add("Email boss", { tags: "work" });
  await app.add("Ship release", { tags: "work" });
  await app.add("Water plants", { tags: "home" });
  await app.toggle("Ship release");

  await app.tag("work");
  assert.deepEqual(app.titles(), ["Email boss", "Ship release"]);

  await app.status("completed");
  assert.deepEqual(app.titles(), ["Ship release"]);

  await app.tag("");
  await app.status("all");
  assert.deepEqual(app.titles(), ["Email boss", "Ship release", "Water plants"]);
});

test("clicking a tag chip filters by that tag", async () => {
  const app = openApp();
  await settle();
  await app.add("Email boss", { tags: "work" });
  await app.add("Water plants", { tags: "home" });

  app.task("Water plants").querySelector(".tag").click();
  await settle();
  assert.deepEqual(app.titles(), ["Water plants"]);
  assert.equal(app.doc.querySelector("#tag-filter").value, "home");
});

test("deleting the last task with the filtered tag clears the tag filter", async () => {
  const app = openApp();
  await settle();
  await app.add("Keep", { tags: "work" });
  await app.add("Only home task", { tags: "home" });
  await app.tag("home");
  await app.remove("Only home task");
  await settle();
  assert.equal(app.doc.querySelector("#tag-filter").value, "");
  assert.deepEqual(app.tagOptions(), ["", "work"]);
  assert.deepEqual(app.titles(), ["Keep"]);
});

test("tasks, due dates and tags survive a page reload", async () => {
  const factory = new IDBFactory();
  const first = openApp(factory);
  await settle();
  await first.add("Persistent", { due: "2999-01-01", tags: "work" });
  await first.toggle("Persistent");

  const reloaded = openApp(factory);
  await waitFor(() => reloaded.titles().length === 1);
  const li = reloaded.task("Persistent");
  assert.ok(li.classList.contains("done"));
  assert.match(li.querySelector(".due").textContent, /2999/);
  assert.deepEqual(reloaded.tagOptions(), ["", "work"]);
});

test("task titles are rendered as text, not HTML", async () => {
  const app = openApp();
  await settle();
  await app.add('<img src=x onerror="window.hacked=1">');
  assert.equal(app.doc.querySelector(".task img"), null);
  assert.equal(app.window.hacked, undefined);
  assert.equal(app.titles()[0], '<img src=x onerror="window.hacked=1">');
});

/* ---------- Recurring tasks (Ticket #5, issue #6) ---------- */

const allTasks = (app) => [...app.doc.querySelectorAll(".task")].map((li) => ({
  title: li.querySelector(".title").textContent,
  done: li.classList.contains("done"),
  repeat: li.querySelector(".repeat") ? li.querySelector(".repeat").textContent : "",
  due: li.querySelector(".due") ? li.querySelector(".due").textContent : "",
  canStop: !!li.querySelector(".stop-repeat"),
}));

test("repeat dropdown offers None, Daily, Weekly and Monthly and resets after adding", async () => {
  const app = openApp();
  await settle();
  const sel = app.doc.querySelector("#new-task-repeat");
  assert.deepEqual([...sel.options].map((o) => o.value), ["none", "daily", "weekly", "monthly"]);
  await app.add("Gym", { repeat: "weekly", due: "2999-01-04" });
  assert.equal(sel.value, "none");
});

test("recurring tasks show a badge and a Stop repeating button", async () => {
  const app = openApp();
  await settle();
  await app.add("Gym", { repeat: "weekly", due: "2999-01-04" });
  await app.add("Plain task");
  const [gym, plain] = allTasks(app);
  assert.match(gym.repeat, /Weekly/);
  assert.equal(gym.canStop, true);
  assert.equal(plain.repeat, "");
  assert.equal(plain.canStop, false);
});

test("a repeating task with no due date shows as due today", async () => {
  const app = openApp();
  await settle();
  await app.add("Water plants", { repeat: "daily" });
  const [t] = allTasks(app);
  assert.match(t.due, /^Due /, "has a due date, and today is not overdue");
});

test("ticking a recurring task adds the next occurrence once", async () => {
  const app = openApp();
  await settle();
  await app.add("Gym", { repeat: "weekly", due: "2999-01-04" });
  await app.toggle("Gym");
  await waitFor(() => app.doc.querySelectorAll(".task").length === 2);
  let tasks = allTasks(app);
  assert.equal(tasks[0].done, true);
  assert.equal(tasks[0].canStop, false, "a finished occurrence can't stop the series");
  assert.equal(tasks[1].done, false);
  assert.match(tasks[1].due, /11 Jan 2999|Jan 11, 2999/, "one week later");
  assert.match(tasks[1].repeat, /Weekly/);

  // Untick and re-tick the first one: still only two tasks.
  const first = () => app.doc.querySelectorAll(".task")[0].querySelector("input[type=checkbox]");
  first().click(); await settle();
  first().click(); await settle();
  assert.equal(app.doc.querySelectorAll(".task").length, 2);
});

test("Stop repeating removes the badge, and ticking then adds no copy", async () => {
  const app = openApp();
  await settle();
  await app.add("Newsletter", { repeat: "monthly", due: "2999-01-31" });
  app.task("Newsletter").querySelector(".stop-repeat").click();
  await waitFor(() => !app.task("Newsletter").querySelector(".repeat"));
  assert.equal(allTasks(app)[0].canStop, false);
  await app.toggle("Newsletter");
  await settle();
  assert.equal(app.doc.querySelectorAll(".task").length, 1);
});

test("recurring tasks survive a reload", async () => {
  const factory = new IDBFactory();
  const first = openApp(factory);
  await settle();
  await first.add("Gym", { repeat: "weekly", due: "2999-01-04" });
  await first.toggle("Gym");
  await waitFor(() => first.doc.querySelectorAll(".task").length === 2);

  const reloaded = openApp(factory);
  await waitFor(() => reloaded.titles().length === 2);
  const tasks = allTasks(reloaded);
  assert.deepEqual(tasks.map((t) => t.done), [true, false]);
  assert.match(tasks[1].repeat, /Weekly/);
});
