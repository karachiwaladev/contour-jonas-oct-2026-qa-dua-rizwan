/* UI for the todo app. Depends on db.js being loaded first. */
(function () {
  "use strict";

  var F = window.TodoFilters;
  var form = document.getElementById("new-task-form");
  var input = document.getElementById("new-task-input");
  var dueInput = document.getElementById("new-task-due");
  var tagsInput = document.getElementById("new-task-tags");
  var repeatInput = document.getElementById("new-task-repeat");
  var priorityInput = document.getElementById("new-task-priority");
  var REPEAT_LABELS = { daily: "Daily", weekly: "Weekly", monthly: "Monthly" };
  var REPEAT_OPTIONS = [["none", "None"], ["daily", "Daily"], ["weekly", "Weekly"], ["monthly", "Monthly"]];
  var PRIORITY_LABELS = { none: "None", low: "Low", medium: "Medium", high: "High" };
  var PRIORITY_OPTIONS = [["none", "None"], ["low", "Low"], ["medium", "Medium"], ["high", "High"]];
  var list = document.getElementById("task-list");
  var empty = document.getElementById("empty-state");
  var count = document.getElementById("task-count");
  var error = document.getElementById("error");
  var statusButtons = Array.prototype.slice.call(document.querySelectorAll("[data-status]"));
  var tagSelect = document.getElementById("tag-filter");
  var prioritySelect = document.getElementById("priority-filter");
  var searchInput = document.getElementById("search");

  // Current filter. Kept in memory only, so a reload shows all tasks again.
  var filter = { status: "all", tag: "", priority: "", search: "" };
  // The task being edited in place, if any. Only one at a time.
  var editingId = null;

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

  function makeSelect(className, label, options, value) {
    var sel = document.createElement("select");
    sel.className = className;
    sel.name = className; // a name lets browsers autofill and stops a DevTools form warning
    sel.setAttribute("aria-label", label);
    options.forEach(function (o) { sel.append(new Option(o[1], o[0])); });
    sel.value = value;
    return sel;
  }

  function makeInput(type, className, label, value) {
    var el = document.createElement("input");
    el.type = type;
    el.className = className;
    el.name = className;
    el.setAttribute("aria-label", label);
    el.value = value || "";
    return el;
  }

  /** Wrap a control in a visible label, like the add form's "Due" / "Repeat" fields. */
  function labelled(text, control, grow) {
    var wrap = document.createElement("label");
    wrap.className = "field" + (grow ? " grow" : "");
    var span = document.createElement("span");
    span.textContent = text;
    wrap.append(span, control);
    return wrap;
  }

  function stopEditing() {
    editingId = null;
    showError("");
    return refresh();
  }

  /** The task row in edit mode: a small form with the same fields as the add form. */
  function renderEditor(task) {
    var li = document.createElement("li");
    li.className = "task editing";
    li.dataset.id = task.id;

    var edit = document.createElement("form");
    edit.className = "edit-form";
    edit.setAttribute("aria-label", "Edit “" + task.title + "”");

    var title = makeInput("text", "edit-title", "Title", task.title);
    title.maxLength = 200;
    title.required = true;
    var priority = makeSelect("edit-priority", "Priority", PRIORITY_OPTIONS, task.priority || "none");
    var due = makeInput("date", "edit-due", "Due date", task.dueDate);
    var repeat = makeSelect("edit-repeat", "Repeat", REPEAT_OPTIONS, task.repeat || "none");
    var tags = makeInput("text", "edit-tags", "Tags", task.tags.join(", "));
    tags.placeholder = "work, urgent";

    var save = document.createElement("button");
    save.type = "submit";
    save.className = "save";
    save.textContent = "Save";
    var cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "cancel";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", stopEditing);

    var row1 = document.createElement("div");
    row1.className = "edit-row";
    row1.append(title);
    var row2 = document.createElement("div");
    row2.className = "edit-row";
    // Visible labels: two "None" dropdowns side by side are otherwise indistinguishable.
    row2.append(
      labelled("Priority", priority),
      labelled("Due", due),
      labelled("Repeat", repeat),
      labelled("Tags", tags, true)
    );
    var row3 = document.createElement("div");
    row3.className = "edit-row edit-actions";
    row3.append(save, cancel);
    edit.append(row1, row2, row3);

    edit.addEventListener("submit", function (event) {
      event.preventDefault();
      showError(""); // like the add form: clear a stale error before trying again
      db.updateTask(task.id, {
        title: title.value,
        priority: priority.value,
        dueDate: due.value,
        tags: tags.value,
        repeat: repeat.value,
      }).then(stopEditing, onError);
    });
    // Escape anywhere in the form cancels. Enter in a field submits the form (Save).
    edit.addEventListener("keydown", function (event) {
      if (event.key === "Escape") {
        event.preventDefault();
        stopEditing();
      }
    });

    li.append(edit);
    return li;
  }

  function renderTask(task, today) {
    if (task.id === editingId) return renderEditor(task);
    var li = document.createElement("li");
    var overdue = F.isOverdue(task, today);
    li.className = "task" + (task.done ? " done" : "") + (overdue ? " overdue" : "");
    li.dataset.id = task.id;

    var main = document.createElement("div");
    main.className = "task-main";

    var label = document.createElement("label");
    var checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.name = "done-" + task.id;
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
    var prioritised = task.priority && task.priority !== "none";
    if (task.dueDate || task.tags.length || repeating || prioritised) {
      var meta = document.createElement("div");
      meta.className = "meta";
      if (prioritised) {
        var pr = document.createElement("span");
        pr.className = "priority priority-" + task.priority;
        pr.textContent = PRIORITY_LABELS[task.priority];
        pr.title = PRIORITY_LABELS[task.priority] + " priority";
        meta.append(pr);
      }
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
      // Only the live occurrence can end the series: unfinished, and its next copy
      // not created yet. Once a next copy exists, the series continues from there.
      if (repeating && !task.done && !task.nextCreated) {
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

    var editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "edit";
    editBtn.textContent = "Edit";
    editBtn.setAttribute("aria-label", "Edit “" + task.title + "”");
    editBtn.addEventListener("click", function () {
      editingId = task.id;
      showError("");
      refresh();
    });

    var del = document.createElement("button");
    del.type = "button";
    del.className = "delete";
    del.textContent = "Delete";
    del.setAttribute("aria-label", "Delete “" + task.title + "”");
    del.addEventListener("click", function () {
      db.deleteTask(task.id).then(refresh, onError);
    });

    var actions = document.createElement("div");
    actions.className = "actions";
    actions.append(editBtn, del);

    li.append(main, actions);
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

      prioritySelect.value = filter.priority;
      // Forget an edit whose task is gone, for example deleted elsewhere.
      if (editingId !== null && !tasks.some(function (t) { return t.id === editingId; })) editingId = null;
      // A task being edited stays visible even if the filter would hide it.
      var visible = tasks.filter(function (t) {
        return t.id === editingId || F.filterTasks([t], filter).length === 1;
      });
      list.replaceChildren.apply(list, visible.map(function (t) { return renderTask(t, today); }));
      var editTitle = list.querySelector(".edit-title");
      if (editTitle && !list.contains(document.activeElement)) editTitle.focus();

      empty.hidden = visible.length > 0;
      empty.textContent = tasks.length ? "No tasks match this filter." : "No tasks yet. Add one above.";

      // Footer: open and done counts over ALL tasks, whatever the filter. While a
      // filter hides some tasks it also says how many are shown. Hidden when empty.
      var c = F.countTasks(tasks);
      count.hidden = c.total === 0;
      count.textContent = c.total === 0 ? "" : c.open + " open · " + c.done + " done" +
        (visible.length < c.total ? " · Showing " + visible.length + " of " + c.total : "");
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
  prioritySelect.addEventListener("change", function () { setFilter({ priority: prioritySelect.value }); });
  // Search filters on every keystroke. The browser's built-in × on a search field
  // fires "search" (and in most browsers "input" too), so listen for both.
  function onSearch() {
    if (searchInput.value !== filter.search) setFilter({ search: searchInput.value });
  }
  searchInput.addEventListener("input", onSearch);
  searchInput.addEventListener("search", onSearch);
  searchInput.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && searchInput.value) {
      event.preventDefault();
      searchInput.value = "";
      setFilter({ search: "" });
    }
  });

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    showError("");
    db.addTask(input.value, {
      dueDate: dueInput.value,
      tags: tagsInput.value,
      repeat: repeatInput.value,
      priority: priorityInput.value,
    }).then(function () {
      input.value = "";
      dueInput.value = "";
      tagsInput.value = "";
      repeatInput.value = "none";
      priorityInput.value = "none";
      input.focus();
      return refresh();
    }, onError);
  });

  refresh();
})();
