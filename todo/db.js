/*
 * Task storage on IndexedDB, the browser's built-in client-side database,
 * plus pure helpers for tags, due dates and filtering.
 * Works as a plain <script> (exposes window.createTodoDB and window.TodoFilters)
 * and as a Node module for tests (module.exports), where a fake IndexedDB is injected.
 */
(function (root) {
  "use strict";

  var STORE = "tasks";
  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  function promisify(request) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error); };
    });
  }

  /* ---------- Pure helpers (no storage) ---------- */

  /** "Work, urgent ,work" or ["Work"] -> ["work", "urgent"]: trimmed, lowercased, unique, non-empty. */
  function parseTags(input) {
    var parts = Array.isArray(input) ? input : String(input == null ? "" : input).split(",");
    var seen = [];
    parts.forEach(function (p) {
      var tag = String(p).trim().toLowerCase().replace(/^#/, "").replace(/\s+/g, "-");
      if (tag && seen.indexOf(tag) === -1) seen.push(tag);
    });
    return seen;
  }

  /** "" or null -> null; "2026-10-30" -> "2026-10-30"; anything else throws. */
  function normalizeDueDate(value) {
    if (value == null || value === "") return null;
    var s = String(value).trim();
    if (!DATE_RE.test(s) || isNaN(new Date(s + "T00:00:00").getTime())) {
      throw new Error("Due date must be a date in YYYY-MM-DD format");
    }
    return s;
  }

  /** Fill in fields that tasks saved before due dates and tags existed are missing. */
  function normalizeTask(task) {
    return Object.assign({ done: false, dueDate: null, tags: [] }, task);
  }

  /** Today's date as YYYY-MM-DD in local time. */
  function todayString(now) {
    var d = now || new Date();
    var pad = function (n) { return (n < 10 ? "0" : "") + n; };
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }

  /** An unfinished task whose due date is before today. */
  function isOverdue(task, today) {
    return !task.done && !!task.dueDate && task.dueDate < (today || todayString());
  }

  /**
   * Filter tasks by status ("all" | "active" | "completed") and an optional tag.
   * Unknown statuses behave like "all".
   */
  function filterTasks(tasks, options) {
    var status = (options && options.status) || "all";
    var tag = options && options.tag ? parseTags(options.tag)[0] : null;
    return tasks.filter(function (t) {
      if (status === "active" && t.done) return false;
      if (status === "completed" && !t.done) return false;
      if (tag && (t.tags || []).indexOf(tag) === -1) return false;
      return true;
    });
  }

  /** Every tag in use, sorted alphabetically, each listed once. */
  function collectTags(tasks) {
    var all = [];
    tasks.forEach(function (t) {
      (t.tags || []).forEach(function (tag) { if (all.indexOf(tag) === -1) all.push(tag); });
    });
    return all.sort();
  }

  /* ---------- IndexedDB storage ---------- */

  function createTodoDB(idb, dbName) {
    idb = idb || root.indexedDB;
    dbName = dbName || "todo-app";
    var dbPromise = null;

    function open() {
      if (!dbPromise) {
        var request = idb.open(dbName, 1);
        request.onupgradeneeded = function () {
          var db = request.result;
          if (!db.objectStoreNames.contains(STORE)) {
            db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
          }
        };
        dbPromise = promisify(request);
      }
      return dbPromise;
    }

    // Run fn inside one transaction; resolve with box.value once it commits.
    function withStore(mode, fn) {
      return open().then(function (db) {
        var tx = db.transaction(STORE, mode);
        var box = {};
        fn(tx.objectStore(STORE), box);
        return new Promise(function (resolve, reject) {
          tx.oncomplete = function () { resolve(box.value); };
          tx.onerror = function () { reject(tx.error); };
          tx.onabort = function () { reject(tx.error); };
        });
      });
    }

    return {
      /**
       * Add a task. options: { dueDate: "YYYY-MM-DD" | null, tags: "a, b" | ["a", "b"] }.
       * Rejects on a blank title or a malformed due date. Resolves to the saved task.
       */
      addTask: function (title, options) {
        options = options || {};
        var clean = String(title == null ? "" : title).trim();
        if (!clean) return Promise.reject(new Error("Task title cannot be empty"));
        var dueDate;
        try {
          dueDate = normalizeDueDate(options.dueDate);
        } catch (e) {
          return Promise.reject(e);
        }
        var task = {
          title: clean,
          done: false,
          dueDate: dueDate,
          tags: parseTags(options.tags),
          createdAt: Date.now(),
        };
        return withStore("readwrite", function (store, box) {
          var req = store.add(task);
          req.onsuccess = function () { box.value = req.result; };
        }).then(function (id) {
          task.id = id;
          return task;
        });
      },

      /** All tasks, oldest first, with dueDate and tags always present. */
      listTasks: function () {
        return withStore("readonly", function (store, box) {
          var req = store.getAll();
          req.onsuccess = function () { box.value = req.result; };
        }).then(function (tasks) {
          return (tasks || []).map(normalizeTask).sort(function (a, b) {
            return a.createdAt - b.createdAt || a.id - b.id;
          });
        });
      },

      /** Mark a task done or not done. Resolves to the updated task. */
      setDone: function (id, done) {
        return withStore("readwrite", function (store, box) {
          var req = store.get(id);
          req.onsuccess = function () {
            if (!req.result) return;
            box.value = Object.assign(normalizeTask(req.result), { done: !!done });
            store.put(box.value);
          };
        }).then(function (updated) {
          if (!updated) throw new Error("Task " + id + " not found");
          return updated;
        });
      },

      /** Delete a task by id. Deleting a missing id is a no-op. */
      deleteTask: function (id) {
        return withStore("readwrite", function (store) {
          store.delete(id);
        });
      },
    };
  }

  var TodoFilters = {
    parseTags: parseTags,
    normalizeDueDate: normalizeDueDate,
    todayString: todayString,
    isOverdue: isOverdue,
    filterTasks: filterTasks,
    collectTags: collectTags,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = Object.assign({ createTodoDB: createTodoDB }, TodoFilters);
  } else {
    root.createTodoDB = createTodoDB;
    root.TodoFilters = TodoFilters;
  }
})(typeof window !== "undefined" ? window : globalThis);
