/* ============================================================
   全量备份与恢复（独立挂载，不修改 app.js）
   ============================================================ */

(function () {
  'use strict';

  var Store = window.HRStore;
  if (!Store) return;

  var LAST_BACKUP_KEY = 'html-runtime:last-backup';
  var REMIND_DAYS = 7;
  var MAX_IMPORT_BYTES = 80 * 1024 * 1024;

  var statusEl = null;
  var fileInput = null;

  function $(id) { return document.getElementById(id); }

  function pad(n) { return n < 10 ? '0' + n : String(n); }

  function toast(message) {
    var el = $('toast');
    if (!el) return;
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () {
      el.classList.remove('show');
    }, 2000);
  }

  function injectStyle() {
    var css = [
      '.hr-backup-bar{border-top:1px solid #232a36;padding:10px 16px 14px;}',
      '.hr-backup-row{display:flex;align-items:center;gap:8px;}',
      '.hr-backup-btn{appearance:none;border:1px solid #232a36;background:#171d29;',
      'color:#e6edf3;font-size:12px;padding:7px 12px;border-radius:8px;',
      'touch-action:manipulation;}',
      '.hr-backup-btn:active{background:#222a38;}',
      '.hr-backup-status{flex:1;text-align:right;font-size:11px;color:#8b98a9;}',
      '.hr-backup-status[data-warn="1"]{color:#f0b429;}'
    ].join('\n');

    var el = document.createElement('style');
    el.textContent = css;
    document.head.appendChild(el);
  }

  /* ================= 时间戳 ================= */
  function getLastBackup() {
    var v = 0;
    try {
      v = parseInt(localStorage.getItem(LAST_BACKUP_KEY) || '0', 10);
    } catch (e) {}
    return isNaN(v) ? 0 : v;
  }

  function setLastBackup(ts) {
    try {
      localStorage.setItem(LAST_BACKUP_KEY, String(ts));
    } catch (e) {}
  }

  function updateStatus() {
    if (!statusEl) return;
    var last = getLastBackup();

    if (!last) {
      statusEl.textContent = '从未备份';
      statusEl.setAttribute('data-warn', '1');
      return;
    }

    var days = Math.floor((Date.now() - last) / 86400000);
    if (days <= 0) {
      statusEl.textContent = '今天已备份';
      statusEl.removeAttribute('data-warn');
    } else {
      statusEl.textContent = days + ' 天前备份';
      if (days >= REMIND_DAYS) statusEl.setAttribute('data-warn', '1');
      else statusEl.removeAttribute('data-warn');
    }
  }

  /* ================= 工具 ================= */
  function download(filename, text) {
    var blob = new Blob([text], { type: 'application/json;charset=utf-8' });
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

  function blobToDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result)); };
      reader.onerror = function () { reject(reader.error || new Error('读取失败')); };
      reader.readAsDataURL(blob);
    });
  }

  /** 等 app.js 把未保存的编辑落库（最多等 4 秒） */
  function waitForSave(callback, tries) {
    tries = tries || 0;
    var hint = $('saveHint');
    var busy = hint && (hint.textContent === '未保存' || hint.textContent === '保存中…');

    if (busy && tries < 20) {
      setTimeout(function () { waitForSave(callback, tries + 1); }, 200);
      return;
    }
    callback();
  }

  /* ================= 备份 ================= */
  function exportAll() {
    waitForSave(function () {
      toast('正在打包…');

      Store.listProjects()
        .then(function (projects) {
          if (!projects.length) {
            toast('还没有项目');
            return null;
          }

          var jobs = projects.map(function (project) {
            var fileJobs = project.files.map(function (file) {
              if (file.kind === 'text') {
                return {
                  path: file.path,
                  kind: 'text',
                  mime: file.mime,
                  text: file.text || ''
                };
              }
              if (!file.blob) return null;
              return blobToDataUrl(file.blob).then(function (dataUrl) {
                return {
                  path: file.path,
                  kind: 'binary',
                  mime: file.mime,
                  dataUrl: dataUrl
                };
              });
            });

            return Promise.all(fileJobs).then(function (list) {
              return {
                id: project.id,
                name: project.name,
                entry: project.entry,
                createdAt: project.createdAt,
                updatedAt: project.updatedAt,
                files: list.filter(Boolean)
              };
            });
          });

          return Promise.all(jobs);
        })
        .then(function (projects) {
          if (!projects) return;

          var payload = {
            app: 'html-runtime',
            version: 1,
            exportedAt: Date.now(),
            projects: projects
          };

          var json = JSON.stringify(payload);
          var now = new Date();
          var name = 'html-runtime-backup-' +
            now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) + '-' +
            pad(now.getHours()) + pad(now.getMinutes()) + '.json';

          download(name, json);
          setLastBackup(Date.now());
          updateStatus();

          var mb = (json.length / 1024 / 1024).toFixed(1);
          toast('已备份 ' + projects.length + ' 个项目（' + mb + ' MB）');
        })
        .catch(function (err) {
          toast('备份失败：' + (err && err.message ? err.message : '未知错误'));
        });
    });
  }

  /* ================= 恢复 ================= */
  function importBackup(file) {
    if (file.size > MAX_IMPORT_BYTES) {
      toast('备份文件太大（超过 80MB）');
      return;
    }

    var reader = new FileReader();
    reader.onload = function () {
      var payload;
      try {
        payload = JSON.parse(String(reader.result || ''));
      } catch (e) {
        toast('不是有效的备份文件');
        return;
      }

      if (!payload || payload.app !== 'html-runtime' || !Array.isArray(payload.projects)) {
        toast('不是有效的备份文件');
        return;
      }

      restore(payload.projects);
    };
    reader.onerror = function () { toast('文件读取失败'); };
    reader.readAsText(file);
  }

  function restore(projects) {
    if (!projects.length) {
      toast('备份里没有项目');
      return;
    }

    Store.listProjects()
      .then(function (existing) {
        var ids = {};
        existing.forEach(function (p) { ids[p.id] = true; });

        var toAdd = projects.filter(function (p) {
          return p && p.id && !ids[p.id];
        });
        var skipped = projects.length - toAdd.length;

        if (!toAdd.length) {
          toast('这 ' + projects.length + ' 个项目都已存在，无需恢复');
          return null;
        }

        var chains = toAdd.map(function (project) {
          var fileJobs = (project.files || []).map(function (file) {
            if (file.kind === 'text') {
              return {
                path: file.path,
                kind: 'text',
                mime: file.mime || 'text/plain',
                text: file.text || ''
              };
            }
            if (!file.dataUrl) return null;
            return fetch(file.dataUrl)
              .then(function (res) { return res.blob(); })
              .then(function (blob) {
                return {
                  path: file.path,
                  kind: 'binary',
                  mime: file.mime || blob.type || 'application/octet-stream',
                  blob: blob
                };
              });
          });

          return Promise.all(fileJobs).then(function (list) {
            var files = list.filter(Boolean);
            return Store.putProject({
              id: project.id,
              name: project.name || '未命名项目',
              entry: project.entry || Store.pickEntry(files),
              createdAt: project.createdAt || Date.now(),
              updatedAt: project.updatedAt || Date.now(),
              files: files
            });
          });
        });

        return Promise.all(chains).then(function () {
          toast(
            '已恢复 ' + toAdd.length + ' 个项目' +
            (skipped ? '，跳过 ' + skipped + ' 个已存在的' : '')
          );
          setTimeout(function () { location.reload(); }, 1000);
        });
      })
      .catch(function (err) {
        toast('恢复失败：' + (err && err.message ? err.message : '未知错误'));
      });
  }

  /* ================= 界面 ================= */
  function buildBar() {
    var panel = document.querySelector('#projectSheet .sheet-panel');
    if (!panel || $('hrBackupBar')) return;

    var bar = document.createElement('div');
    bar.className = 'hr-backup-bar';
    bar.id = 'hrBackupBar';

    var row = document.createElement('div');
    row.className = 'hr-backup-row';

    var exportBtn = document.createElement('button');
    exportBtn.className = 'hr-backup-btn';
    exportBtn.textContent = '备份全部';
    exportBtn.addEventListener('click', exportAll);

    var importBtn = document.createElement('button');
    importBtn.className = 'hr-backup-btn';
    importBtn.textContent = '恢复备份';
    importBtn.addEventListener('click', function () {
      if (fileInput) fileInput.click();
    });

    statusEl = document.createElement('span');
    statusEl.className = 'hr-backup-status';

    row.appendChild(exportBtn);
    row.appendChild(importBtn);
    row.appendChild(statusEl);
    bar.appendChild(row);

    fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.json,application/json';
    fileInput.hidden = true;
    fileInput.addEventListener('change', function () {
      var file = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if (!file) return;
      if (!window.confirm('恢复只会补充备份里缺少的项目，不会覆盖现有的。继续？')) return;
      importBackup(file);
    });
    bar.appendChild(fileInput);

    panel.appendChild(bar);
    updateStatus();
  }

  function remind() {
    var last = getLastBackup();
    var overdue = !last || (Date.now() - last) / 86400000 >= REMIND_DAYS;
    if (!overdue) return;

    Store.listProjects()
      .then(function (list) {
        if (!list.length) return;
        toast('建议备份一下：所有项目都只存在这台手机的浏览器里');
      })
      .catch(function () {});
  }

  function init() {
    injectStyle();
    buildBar();

    var projectBtn = $('projectBtn');
    if (projectBtn) {
      projectBtn.addEventListener('click', function () {
        setTimeout(updateStatus, 0);
      });
    }

    setTimeout(remind, 3000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
