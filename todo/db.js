/*
 * Task storage on IndexedDB, the browser's built-in client-side database.
 * Works as a plain <script> (exposes window.createTodoDB) and as a Node
 * module for tests (module.exports), where a fake IndexedDB is injected.
 */
(function (root) {
  "use strict";

  var STORE = "tasks";

  function promisify(request) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error); };
    });
  }

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
      /** Add a task. Rejects on blank titles. Resolves to the saved task. */
      addTask: function (title) {
        var clean = String(title == null ? "" : title).trim();
        if (!clean) return Promise.reject(new Error("Task title cannot be empty"));
        var task = { title: clean, done: false, createdAt: Date.now() };
        return withStore("readwrite", function (store, box) {
          var req = store.add(task);
          req.onsuccess = function () { box.value = req.result; };
        }).then(function (id) {
          task.id = id;
          return task;
        });
      },

      /** All tasks, oldest first. */
      listTasks: function () {
        return withStore("readonly", function (store, box) {
          var req = store.getAll();
          req.onsuccess = function () { box.value = req.result; };
        }).then(function (tasks) {
          return (tasks || []).sort(function (a, b) {
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
            box.value = Object.assign({}, req.result, { done: !!done });
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

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { createTodoDB: createTodoDB };
  } else {
    root.createTodoDB = createTodoDB;
  }
})(typeof window !== "undefined" ? window : globalThis);
