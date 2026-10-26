// End-to-end UI tests: load the real index.html, db.js and app.js in jsdom
// with an in-memory IndexedDB, then drive the page the way a user would.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");
const { IDBFactory } = require("fake-indexeddb");

const ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
// Compiled with their real filenames so Node's coverage report attributes them.
const dbScript = new vm.Script(fs.readFileSync(path.join(ROOT, "db.js"), "utf8"), { filename: path.join(ROOT, "db.js") });
const appScript = new vm.Script(fs.readFileSync(path.join(ROOT, "app.js"), "utf8"), { filename: path.join(ROOT, "app.js") });

/** Open the app. Pass the same factory twice to simulate a page reload. */
function openApp(factory = new IDBFactory()) {
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://localhost/" });
  const { window } = dom;
  window.indexedDB = factory;
  const ctx = dom.getInternalVMContext();
  dbScript.runInContext(ctx);
  appScript.runInContext(ctx);
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
  // Wait for the first load to finish rather than a fixed delay: on a busy machine
  // (first test, cold start) 30ms wasn't always enough and the test flaked.
  await waitFor(() => app.doc.querySelector("#tag-filter").disabled);
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

test("an unticked occurrence whose next copy exists offers no Stop repeating", async () => {
  // Found in the browser check: stopping here wouldn't end the series,
  // because the next occurrence already exists. Only the live one can stop it.
  const app = openApp();
  await settle();
  await app.add("Gym", { repeat: "weekly", due: "2999-01-04" });
  await app.toggle("Gym");
  await waitFor(() => app.doc.querySelectorAll(".task").length === 2);
  const firstBox = () => app.doc.querySelectorAll(".task")[0].querySelector("input[type=checkbox]");
  firstBox().click();
  await settle();
  const [original, next] = allTasks(app);
  assert.equal(original.done, false, "unticked again");
  assert.equal(original.canStop, false, "its series has moved on to the next copy");
  assert.equal(next.canStop, true, "the live occurrence can still stop the series");
});

test("a browser without IndexedDB sees an error instead of a broken page", () => {
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://localhost/" });
  const ctx = dom.getInternalVMContext();
  dom.window.indexedDB = undefined;
  dbScript.runInContext(ctx);
  appScript.runInContext(ctx);
  const error = dom.window.document.querySelector("#error");
  assert.equal(error.hidden, false, "the error banner is shown");
  assert.match(error.textContent, /does not support IndexedDB/);
});

/* ---------- Priority and editing (Ticket #6, issue #9) ---------- */

async function addWithPriority(app, title, priority, extra = {}) {
  app.doc.querySelector("#new-task-priority").value = priority;
  await app.add(title, extra);
}
const badge = (app, title) => {
  const b = app.task(title) && app.task(title).querySelector(".priority");
  return b ? b.textContent : "";
};
async function setPriorityFilter(app, value) {
  const sel = app.doc.querySelector("#priority-filter");
  sel.value = value;
  sel.dispatchEvent(new app.window.Event("change"));
  await settle();
}
async function startEdit(app, title) {
  app.task(title).querySelector(".edit").click();
  await waitFor(() => app.doc.querySelector(".task.editing"));
  return app.doc.querySelector(".task.editing");
}
async function saveEdit(app, values) {
  const row = app.doc.querySelector(".task.editing");
  for (const [cls, v] of Object.entries(values)) row.querySelector("." + cls).value = v;
  row.querySelector(".edit-form").dispatchEvent(new app.window.Event("submit", { cancelable: true }));
  await waitFor(() => !app.doc.querySelector(".task.editing") || app.errorText());
}

test("the add form has a Priority dropdown that resets to None after adding", async () => {
  const app = openApp();
  await settle();
  const sel = app.doc.querySelector("#new-task-priority");
  assert.deepEqual([...sel.options].map((o) => o.value), ["none", "low", "medium", "high"]);
  await addWithPriority(app, "Urgent", "high");
  assert.equal(sel.value, "none");
});

test("tasks show a priority badge, and none for no priority", async () => {
  const app = openApp();
  await settle();
  await addWithPriority(app, "Fire drill", "high");
  await addWithPriority(app, "Report", "medium");
  await addWithPriority(app, "Tidy desk", "low");
  await app.add("Someday");
  assert.equal(badge(app, "Fire drill"), "High");
  assert.equal(badge(app, "Report"), "Medium");
  assert.equal(badge(app, "Tidy desk"), "Low");
  assert.equal(badge(app, "Someday"), "", "no badge for no priority");
  assert.ok(app.task("Fire drill").querySelector(".priority-high"));
});

test("the priority filter shows only that level and combines with status and tag", async () => {
  const app = openApp();
  await settle();
  await addWithPriority(app, "A", "high", { tags: "work" });
  await addWithPriority(app, "B", "high", { tags: "home" });
  await addWithPriority(app, "C", "low", { tags: "work" });
  await app.add("D");
  await app.toggle("B");

  await setPriorityFilter(app, "high");
  assert.deepEqual(app.titles(), ["A", "B"]);
  await app.status("active");
  assert.deepEqual(app.titles(), ["A"]);
  await app.status("all");
  await app.tag("home");
  assert.deepEqual(app.titles(), ["B"]);
  await app.tag("");
  await setPriorityFilter(app, "none");
  assert.deepEqual(app.titles(), ["D"]);
  await setPriorityFilter(app, "");
  assert.deepEqual(app.titles(), ["A", "B", "C", "D"]);
});

test("Edit opens a form filled with the task's current values", async () => {
  const app = openApp();
  await settle();
  await addWithPriority(app, "Report", "medium", { due: "2999-01-04", tags: "work, q4", repeat: "weekly" });
  const row = await startEdit(app, "Report");
  assert.equal(row.querySelector(".edit-title").value, "Report");
  assert.equal(row.querySelector(".edit-priority").value, "medium");
  assert.equal(row.querySelector(".edit-due").value, "2999-01-04");
  assert.equal(row.querySelector(".edit-tags").value, "work, q4");
  assert.equal(row.querySelector(".edit-repeat").value, "weekly");
  assert.equal(app.doc.activeElement, row.querySelector(".edit-title"), "title gets focus");
});

test("Save updates every field and leaves edit mode", async () => {
  const app = openApp();
  await settle();
  await app.add("Draft", { tags: "work" });
  await startEdit(app, "Draft");
  await saveEdit(app, {
    "edit-title": "Final report",
    "edit-priority": "high",
    "edit-due": "2999-02-01",
    "edit-tags": "work, Q4",
  });
  assert.equal(app.doc.querySelector(".task.editing"), null);
  assert.deepEqual(app.titles(), ["Final report"]);
  const li = app.task("Final report");
  assert.equal(badge(app, "Final report"), "High");
  assert.match(li.querySelector(".due").textContent, /2999/);
  assert.deepEqual([...li.querySelectorAll(".tag")].map((n) => n.textContent), ["#work", "#q4"]);
  assert.deepEqual(app.tagOptions(), ["", "q4", "work"], "tag filter picks up the new tag");
});

test("Cancel discards changes", async () => {
  const app = openApp();
  await settle();
  await addWithPriority(app, "Keep", "low");
  const row = await startEdit(app, "Keep");
  row.querySelector(".edit-title").value = "Changed";
  row.querySelector(".edit-priority").value = "high";
  row.querySelector(".cancel").click();
  await waitFor(() => !app.doc.querySelector(".task.editing"));
  assert.deepEqual(app.titles(), ["Keep"]);
  assert.equal(badge(app, "Keep"), "Low");
});

test("Escape cancels editing", async () => {
  const app = openApp();
  await settle();
  await app.add("Esc me");
  const row = await startEdit(app, "Esc me");
  row.querySelector(".edit-title").value = "Should not save";
  row.querySelector(".edit-title").dispatchEvent(new app.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await waitFor(() => !app.doc.querySelector(".task.editing"));
  assert.deepEqual(app.titles(), ["Esc me"]);
});

test("saving a blank title shows the error and stays in edit mode", async () => {
  const app = openApp();
  await settle();
  await app.add("Named");
  await startEdit(app, "Named");
  await saveEdit(app, { "edit-title": "   " });
  assert.match(app.errorText(), /cannot be empty/);
  assert.ok(app.doc.querySelector(".task.editing"), "still editing so the user can fix it");
  // Fixing it and saving clears the error.
  await saveEdit(app, { "edit-title": "Renamed" });
  assert.equal(app.errorText(), "");
  assert.deepEqual(app.titles(), ["Renamed"]);
});

test("a task being edited stays visible even if the edit moves it out of the filter", async () => {
  const app = openApp();
  await settle();
  await addWithPriority(app, "Shift me", "high");
  await setPriorityFilter(app, "high");
  const row = await startEdit(app, "Shift me");
  row.querySelector(".edit-priority").value = "low";
  row.querySelector(".edit-title").value = "";
  row.querySelector(".edit-form").dispatchEvent(new app.window.Event("submit", { cancelable: true }));
  await waitFor(() => app.errorText());
  assert.ok(app.doc.querySelector(".task.editing"), "the failed edit is still on screen");
  await saveEdit(app, { "edit-title": "Shift me", "edit-priority": "low" });
  assert.deepEqual(app.titles(), [], "after saving, the high-only filter hides it");
});

test("editing a recurring task carries the change into its next copy", async () => {
  const app = openApp();
  await settle();
  await app.add("Gym", { repeat: "weekly", due: "2999-01-04" });
  await startEdit(app, "Gym");
  await saveEdit(app, { "edit-title": "Gym session", "edit-priority": "high" });
  await app.toggle("Gym session");
  await waitFor(() => app.doc.querySelectorAll(".task").length === 2);
  const copies = [...app.doc.querySelectorAll(".task")];
  assert.equal(copies[1].querySelector(".title").textContent, "Gym session");
  assert.equal(copies[1].querySelector(".priority").textContent, "High");
});

test("priority and edits survive a reload", async () => {
  const factory = new IDBFactory();
  const first = openApp(factory);
  await settle();
  await first.add("Persist");
  await startEdit(first, "Persist");
  await saveEdit(first, { "edit-title": "Persisted", "edit-priority": "medium" });

  const reloaded = openApp(factory);
  await waitFor(() => reloaded.titles().length === 1);
  assert.deepEqual(reloaded.titles(), ["Persisted"]);
  assert.equal(badge(reloaded, "Persisted"), "Medium");
});

test("edited titles are rendered as text, not HTML", async () => {
  const app = openApp();
  await settle();
  await app.add("Safe");
  await startEdit(app, "Safe");
  await saveEdit(app, { "edit-title": '<img src=x onerror="window.hacked=1">' });
  assert.equal(app.doc.querySelector(".task img"), null);
  assert.equal(app.window.hacked, undefined);
  const row = await startEdit(app, '<img src=x onerror="window.hacked=1">');
  assert.equal(row.querySelector("img"), null, "edit form shows it as a value, not markup");
  assert.equal(row.querySelector(".edit-title").value, '<img src=x onerror="window.hacked=1">');
});

test("edit form fields have visible labels, so its dropdowns can be told apart", async () => {
  // Found in the browser check: Priority and Repeat both read "None" with no label.
  const app = openApp();
  await settle();
  await app.add("Labelled");
  const row = await startEdit(app, "Labelled");
  const labelFor = (cls) => {
    const control = row.querySelector("." + cls);
    const label = control.closest("label");
    return label ? label.querySelector("span").textContent : "";
  };
  assert.equal(labelFor("edit-priority"), "Priority");
  assert.equal(labelFor("edit-due"), "Due");
  assert.equal(labelFor("edit-repeat"), "Repeat");
  assert.equal(labelFor("edit-tags"), "Tags");
});

test("every form field has a name or id", async () => {
  // Found in the browser check: Chrome flagged 25 unnamed fields.
  const app = openApp();
  await settle();
  await app.add("Named fields");
  await startEdit(app, "Named fields");
  const unnamed = [...app.doc.querySelectorAll("input, select")].filter((e) => !e.id && !e.name);
  assert.equal(unnamed.length, 0);
});
