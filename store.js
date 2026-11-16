/* ============================================================
   存储层：IndexedDB + 导入导出工具
   ============================================================ */

(function (global) {
  'use strict';

  var DB_NAME = 'html-runtime';
  var DB_VERSION = 1;
  var STORE_NAME = 'projects';
  var LEGACY_KEY = 'html-runtime:code:v1';

  var dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      if (!global.indexedDB) {
        reject(new Error('此浏览器不支持 IndexedDB'));
        return;
      }
      var req = global.indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          var os = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
          os.createIndex('updatedAt', 'updatedAt');
        }
      };
      req.onsuccess = function () {
        resolve(req.result);
      };
      req.onerror = function () {
        reject(req.error || new Error('打开数据库失败'));
      };
    });
    return dbPromise;
  }

  function newId() {
    return 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function listProjects() {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var req = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAll();
        req.onsuccess = function () {
          var items = req.result || [];
          items.sort(function (a, b) {
            return (b.updatedAt || 0) - (a.updatedAt || 0);
          });
          resolve(items);
        };
        req.onerror = function () {
          reject(req.error);
        };
      });
    });
  }

  function getProject(id) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var req = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(id);
        req.onsuccess = function () {
          resolve(req.result || null);
        };
        req.onerror = function () {
          reject(req.error);
        };
      });
    });
  }

  function putProject(project) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(project);
        tx.oncomplete = function () {
          resolve(project);
        };
        tx.onerror = function () {
          reject(tx.error);
        };
      });
    });
  }

  function deleteProject(id) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).delete(id);
        tx.oncomplete = function () {
          resolve();
        };
        tx.onerror = function () {
          reject(tx.error);
        };
      });
    });
  }

  function createProject(name, code) {
    var now = Date.now();
    var project = {
      id: newId(),
      name: name || '未命名项目',
      html: (code && code.html) || '',
      css: (code && code.css) || '',
      js: (code && code.js) || '',
      createdAt: now,
      updatedAt: now
    };
    return putProject(project);
  }

  /** 把旧版存在 localStorage 里的单份代码升级成一个项目 */
  function migrateLegacy() {
    var legacy = null;
    try {
      legacy = JSON.parse(global.localStorage.getItem(LEGACY_KEY) || 'null');
    } catch (e) {
      legacy = null;
    }
    var hasContent = legacy && (legacy.html || legacy.css || legacy.js);
    if (!hasContent) return Promise.resolve(false);

    return listProjects().then(function (list) {
      if (list.length > 0) return false;
      return createProject('我的项目', legacy).then(function () {
        try {
          global.localStorage.removeItem(LEGACY_KEY);
        } catch (e) {}
        return true;
      });
    });
  }

  /* ================= 导入：把整份 HTML 拆成三段 ================= */
  function parseHtmlFile(text) {
    var doc;
    try {
      doc = new global.DOMParser().parseFromString(text, 'text/html');
    } catch (e) {
      return { html: text, css: '', js: '' };
    }

    var cssParts = [];
    var styles = doc.querySelectorAll('style');
    for (var i = 0; i < styles.length; i++) {
      cssParts.push(styles[i].textContent || '');
      if (styles[i].parentNode) styles[i].parentNode.removeChild(styles[i]);
    }

    var jsParts = [];
    var scripts = doc.querySelectorAll('script');
    for (var j = 0; j < scripts.length; j++) {
      var script = scripts[j];
      if (script.getAttribute('src')) continue;
      jsParts.push(script.textContent || '');
      if (script.parentNode) script.parentNode.removeChild(script);
    }

    return {
      html: (doc.body && doc.body.innerHTML) || '',
      css: cssParts.join('\n\n').trim(),
      js: jsParts.join('\n\n').trim()
    };
  }

  /* ================= 导出：合成一份独立可运行的 HTML ================= */
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function buildStandaloneHtml(code) {
    var css = String((code && code.css) || '').replace(/<\/style/gi, '<\\/style');
    var js = String((code && code.js) || '').replace(/<\/script/gi, '<\\/script');

    return [
      '<!doctype html>',
      '<html lang="zh-CN">',
      '<head>',
      '<meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
      '<title>' + escapeHtml((code && code.name) || '项目') + '</title>',
      '<style>',
      css,
      '</style>',
      '</head>',
      '<body>',
      (code && code.html) || '',
      '<script>',
      js,
      '</script>',
      '</body>',
      '</html>'
    ].join('\n');
  }

  function downloadText(filename, text) {
    var blob = new Blob([text], { type: 'text/html;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      if (a.parentNode) a.parentNode.removeChild(a);
      URL.revokeObjectURL(url);
    }, 1500);
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.top = '-1000px';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        if (ok) resolve();
        else reject(new Error('复制失败'));
      } catch (e) {
        reject(e);
      }
    });
  }

  global.HRStore = {
    openDb: openDb,
    listProjects: listProjects,
    getProject: getProject,
    putProject: putProject,
    deleteProject: deleteProject,
    createProject: createProject,
    migrateLegacy: migrateLegacy,
    parseHtmlFile: parseHtmlFile,
    buildStandaloneHtml: buildStandaloneHtml,
    downloadText: downloadText,
    copyText: copyText
  };
})(window);
