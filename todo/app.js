/* UI for the todo app. Depends on db.js being loaded first. */
(function () {
  "use strict";

  var form = document.getElementById("new-task-form");
  var input = document.getElementById("new-task-input");
  var list = document.getElementById("task-list");
  var empty = document.getElementById("empty-state");
  var count = document.getElementById("task-count");
  var error = document.getElementById("error");

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

  function renderTask(task) {
    var li = document.createElement("li");
    li.className = "task" + (task.done ? " done" : "");
    li.dataset.id = task.id;

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

    var del = document.createElement("button");
    del.type = "button";
    del.className = "delete";
    del.textContent = "Delete";
    del.setAttribute("aria-label", "Delete “" + task.title + "”");
    del.addEventListener("click", function () {
      db.deleteTask(task.id).then(refresh, onError);
    });

    li.append(label, del);
    return li;
  }

  function refresh() {
    return db.listTasks().then(function (tasks) {
      list.replaceChildren.apply(list, tasks.map(renderTask));
      empty.hidden = tasks.length > 0;
      var remaining = tasks.filter(function (t) { return !t.done; }).length;
      count.textContent = tasks.length ? remaining + " of " + tasks.length + " left" : "";
    }, function (e) { showError("Could not load tasks: " + e.message); });
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    showError("");
    db.addTask(input.value).then(function () {
      input.value = "";
      input.focus();
      return refresh();
    }, onError);
  });

  refresh();
})();
