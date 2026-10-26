/* UI for the todo app. Depends on db.js being loaded first. */
(function () {
  "use strict";

  var F = window.TodoFilters;
  var form = document.getElementById("new-task-form");
  var input = document.getElementById("new-task-input");
  var dueInput = document.getElementById("new-task-due");
  var tagsInput = document.getElementById("new-task-tags");
  var repeatInput = document.getElementById("new-task-repeat");
  var REPEAT_LABELS = { daily: "Daily", weekly: "Weekly", monthly: "Monthly" };
  var list = document.getElementById("task-list");
  var empty = document.getElementById("empty-state");
  var count = document.getElementById("task-count");
  var error = document.getElementById("error");
  var statusButtons = Array.prototype.slice.call(document.querySelectorAll("[data-status]"));
  var tagSelect = document.getElementById("tag-filter");

  // Current filter. Kept in memory only, so a reload shows all tasks again.
  var filter = { status: "all", tag: "" };

  function showError(message) {
    error.textContent = message || "";
    error.hidden = !message;
  }

  if (!window.indexedDB) {
    showError("This browser does not support IndexedDB, so tasks cannot be saved.");
    return;
  }

  var db = window.createTodoDB();
  var onError = function (e) { showError(e.message); };

  function formatDate(iso) {
    var d = new Date(iso + "T00:00:00");
    return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  }

  function renderTask(task, today) {
    var li = document.createElement("li");
    var overdue = F.isOverdue(task, today);
    li.className = "task" + (task.done ? " done" : "") + (overdue ? " overdue" : "");
    li.dataset.id = task.id;

    var main = document.createElement("div");
    main.className = "task-main";

    var label = document.createElement("label");
    var checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = task.done;
    checkbox.setAttribute("aria-label", "Mark “" + task.title + "” done");
    checkbox.addEventListener("change", function () {
      db.setDone(task.id, checkbox.checked).then(refresh, onError);
    });

    var title = document.createElement("span");
    title.className = "title";
    title.textContent = task.title; // textContent, never innerHTML: titles are user input
    label.append(checkbox, title);
    main.append(label);

    var repeating = task.repeat && task.repeat !== "none";
    if (task.dueDate || task.tags.length || repeating) {
      var meta = document.createElement("div");
      meta.className = "meta";
      if (repeating) {
        var badge = document.createElement("span");
        badge.className = "repeat";
        badge.textContent = "🔁 " + REPEAT_LABELS[task.repeat];
        badge.title = "Repeats " + task.repeat;
        meta.append(badge);
      }
      if (task.dueDate) {
        var due = document.createElement("span");
        due.className = "due";
        due.textContent = (overdue ? "Overdue: " : "Due ") + formatDate(task.dueDate);
        meta.append(due);
      }
      task.tags.forEach(function (tag) {
        var chip = document.createElement("button");
        chip.type = "button";
        chip.className = "tag";
        chip.textContent = "#" + tag;
        chip.title = "Show only #" + tag;
        chip.addEventListener("click", function () { setFilter({ tag: tag }); });
        meta.append(chip);
      });
      // Only the live (unfinished) occurrence can end the series.
      if (repeating && !task.done) {
        var stop = document.createElement("button");
        stop.type = "button";
        stop.className = "stop-repeat";
        stop.textContent = "Stop repeating";
        stop.setAttribute("aria-label", "Stop repeating “" + task.title + "”");
        stop.addEventListener("click", function () {
          db.stopRepeating(task.id).then(refresh, onError);
        });
        meta.append(stop);
      }
      main.append(meta);
    }

    var del = document.createElement("button");
    del.type = "button";
    del.className = "delete";
    del.textContent = "Delete";
    del.setAttribute("aria-label", "Delete “" + task.title + "”");
    del.addEventListener("click", function () {
      db.deleteTask(task.id).then(refresh, onError);
    });

    li.append(main, del);
    return li;
  }

  function renderTagOptions(tags) {
    // Drop a tag filter whose last task was deleted.
    if (filter.tag && tags.indexOf(filter.tag) === -1) filter.tag = "";
    var options = [new Option("All tags", "")].concat(tags.map(function (t) {
      return new Option("#" + t, t);
    }));
    tagSelect.replaceChildren.apply(tagSelect, options);
    tagSelect.value = filter.tag;
    tagSelect.disabled = tags.length === 0;
  }

  function refresh() {
    return db.listTasks().then(function (tasks) {
      var today = F.todayString();
      renderTagOptions(F.collectTags(tasks));
      statusButtons.forEach(function (b) {
        b.setAttribute("aria-pressed", String(b.dataset.status === filter.status));
      });

      var visible = F.filterTasks(tasks, filter);
      list.replaceChildren.apply(list, visible.map(function (t) { return renderTask(t, today); }));

      empty.hidden = visible.length > 0;
      empty.textContent = tasks.length ? "No tasks match this filter." : "No tasks yet. Add one above.";

      var remaining = tasks.filter(function (t) { return !t.done; }).length;
      count.textContent = tasks.length
        ? "Showing " + visible.length + " of " + tasks.length + " · " + remaining + " left"
        : "";
    }, function (e) { showError("Could not load tasks: " + e.message); });
  }

  function setFilter(changes) {
    Object.assign(filter, changes);
    refresh();
  }

  statusButtons.forEach(function (b) {
    b.addEventListener("click", function () { setFilter({ status: b.dataset.status }); });
  });
  tagSelect.addEventListener("change", function () { setFilter({ tag: tagSelect.value }); });

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    showError("");
    db.addTask(input.value, {
      dueDate: dueInput.value,
      tags: tagsInput.value,
      repeat: repeatInput.value,
    }).then(function () {
      input.value = "";
      dueInput.value = "";
      tagsInput.value = "";
      repeatInput.value = "none";
      input.focus();
      return refresh();
    }, onError);
  });

  refresh();
})();
