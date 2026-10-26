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
  var REPEATS = ["none", "daily", "weekly", "monthly"];

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

  /** Fill in fields that tasks saved by older versions are missing. */
  function normalizeTask(task) {
    return Object.assign(
      { done: false, dueDate: null, tags: [], repeat: "none", repeatDay: null, nextCreated: false },
      task
    );
  }

  /* ---------- Recurrence ---------- */

  /** "" or null -> "none"; "Weekly" -> "weekly"; anything not in REPEATS throws. */
  function normalizeRepeat(value) {
    var r = String(value == null || value === "" ? "none" : value).trim().toLowerCase();
    if (REPEATS.indexOf(r) === -1) {
      throw new Error("Repeat must be one of: " + REPEATS.join(", "));
    }
    return r;
  }

  // Date maths on YYYY-MM-DD strings in UTC, so time zones and DST never shift a day.
  function parseISO(s) {
    var p = s.split("-");
    return { y: +p[0], m: +p[1], d: +p[2] };
  }
  function toISO(y, m, d) {
    var pad = function (n) { return (n < 10 ? "0" : "") + n; };
    return y + "-" + pad(m) + "-" + pad(d);
  }
  function daysInMonth(y, m) { // m is 1-12
    return new Date(Date.UTC(y, m, 0)).getUTCDate();
  }
  function addDays(iso, n) {
    var p = parseISO(iso);
    var t = new Date(Date.UTC(p.y, p.m - 1, p.d + n));
    return toISO(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
  }
  /** Next month on the anchor day, clamped to the month's last day (31 Jan -> 28 Feb -> 31 Mar). */
  function addMonth(iso, anchorDay) {
    var p = parseISO(iso);
    var y = p.y, m = p.m + 1;
    if (m > 12) { m = 1; y++; }
    return toISO(y, m, Math.min(anchorDay || p.d, daysInMonth(y, m)));
  }

  /**
   * Due date of the next occurrence. Counts from the task's due date (or today if it
   * has none) and keeps stepping until the date is today or later, so finishing an
   * overdue task never leaves a backlog. anchorDay keeps monthly tasks on their day.
   */
  function nextDueDate(dueDate, repeat, today, anchorDay) {
    if (!repeat || repeat === "none") return null;
    today = today || todayString();
    var base = dueDate || today;
    var anchor = anchorDay || parseISO(base).d;
    var step = function (d) {
      if (repeat === "daily") return addDays(d, 1);
      if (repeat === "weekly") return addDays(d, 7);
      return addMonth(d, anchor);
    };
    var next = step(base);
    for (var guard = 0; next < today && guard < 100000; guard++) next = step(next);
    return next;
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

  /**
   * createTodoDB(indexedDB?, dbName?, options?)
   * options.now: function returning the current Date; tests pass a fixed clock.
   */
  function createTodoDB(idb, dbName, options) {
    idb = idb || root.indexedDB;
    dbName = dbName || "todo-app";
    var now = (options && options.now) || function () { return new Date(); };
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
       * Add a task. options: { dueDate: "YYYY-MM-DD" | null, tags: "a, b" | ["a", "b"],
       * repeat: "none" | "daily" | "weekly" | "monthly" }. A repeating task with no due
       * date is due today. Rejects on a blank title, bad date or bad repeat value.
       */
      addTask: function (title, options) {
        options = options || {};
        var clean = String(title == null ? "" : title).trim();
        if (!clean) return Promise.reject(new Error("Task title cannot be empty"));
        var dueDate, repeat;
        try {
          dueDate = normalizeDueDate(options.dueDate);
          repeat = normalizeRepeat(options.repeat);
        } catch (e) {
          return Promise.reject(e);
        }
        if (repeat !== "none" && !dueDate) dueDate = todayString(now());
        var task = {
          title: clean,
          done: false,
          dueDate: dueDate,
          tags: parseTags(options.tags),
          repeat: repeat,
          repeatDay: repeat === "monthly" ? parseISO(dueDate).d : null,
          nextCreated: false,
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

      /**
       * Mark a task done or not done. Resolves to the updated task.
       * Ticking a repeating task also adds its next occurrence, in the same transaction,
       * exactly once: nextCreated stops untick-and-retick from making duplicates.
       */
      setDone: function (id, done) {
        return withStore("readwrite", function (store, box) {
          var req = store.get(id);
          req.onsuccess = function () {
            if (!req.result) return;
            var task = Object.assign(normalizeTask(req.result), { done: !!done });
            if (task.done && task.repeat !== "none" && !task.nextCreated) {
              task.nextCreated = true;
              store.add({
                title: task.title,
                done: false,
                dueDate: nextDueDate(task.dueDate, task.repeat, todayString(now()), task.repeatDay),
                tags: task.tags.slice(),
                repeat: task.repeat,
                repeatDay: task.repeatDay,
                nextCreated: false,
                createdAt: Date.now(),
              });
            }
            box.value = task;
            store.put(task);
          };
        }).then(function (updated) {
          if (!updated) throw new Error("Task " + id + " not found");
          return updated;
        });
      },

      /** End a task's series: it stays in the list but no longer repeats. */
      stopRepeating: function (id) {
        return withStore("readwrite", function (store, box) {
          var req = store.get(id);
          req.onsuccess = function () {
            if (!req.result) return;
            box.value = Object.assign(normalizeTask(req.result), { repeat: "none", repeatDay: null });
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
    REPEATS: REPEATS,
    normalizeRepeat: normalizeRepeat,
    nextDueDate: nextDueDate,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = Object.assign({ createTodoDB: createTodoDB }, TodoFilters);
  } else {
    root.createTodoDB = createTodoDB;
    root.TodoFilters = TodoFilters;
  }
})(typeof window !== "undefined" ? window : globalThis);
