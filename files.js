/* ============================================================
   文件管理扩展（独立挂载，不修改 app.js）
   功能：重命名 / 删除 / 设为入口 / 复制路径
   ============================================================ */

(function () {
  'use strict';

  var Store = window.HRStore;
  var LAST_KEY = 'html-runtime:last-project';
  var sheetEl = null;

  function $(id) { return document.getElementById(id); }

  function toast(message) {
    var el = $('toast');
    if (!el) return;
    el.textContent = message;
    el.classList.add('show');
    setTimeout(function () {
      el.classList.remove('show');
    }, 1800);
  }

  function activePath() {
    var tab = document.querySelector('.filetabs .tab.active');
    return tab ? tab.getAttribute('data-path') : '';
  }

  /** 读出编辑器里还没保存的文字，避免覆盖用户的编辑 */
  function mergeEditorText(project, path) {
    var editorEl = $('editor');
    if (!editorEl || editorEl.hidden || !path) return;
    var file = Store.findFile(project, path);
    if (file && file.kind === 'text') file.text = editorEl.value;
  }

  function currentProjectId() {
    try {
      return localStorage.getItem(LAST_KEY);
    } catch (e) {
      return null;
    }
  }

  /** 读出项目 → 修改 → 写回 → 刷新 */
  function mutate(mutator) {
    var id = currentProjectId();
    if (!id) {
      toast('找不到当前项目');
      return;
    }

    Store.getProject(id)
      .then(function (project) {
        if (!project) {
          toast('找不到当前项目');
          return;
        }
        mergeEditorText(project, activePath());

        if (mutator(project) === false) return;

        project.updatedAt = Date.now();
        return Store.putProject(project).then(function () {
          location.reload();
        });
      })
      .catch(function () {
        toast('操作失败');
      });
  }

  /* ================= 操作 ================= */

  function renameFile() {
    var path = activePath();
    if (!path) {
      toast('先选一个文件');
      return;
    }

    var next = window.prompt('新的文件路径', path);
    if (next === null) return;
    next = String(next).trim().replace(/^\/+/, '');
    if (!next) return;

    mutate(function (project) {
      if (next !== path && Store.findFile(project, next)) {
        toast('这个路径已被占用');
        return false;
      }
      var file = Store.findFile(project, path);
      if (!file) {
        toast('文件不存在');
        return false;
      }
      file.path = next;
      if (project.entry === path) project.entry = next;
      return true;
    });
  }

  function deleteFile() {
    var path = activePath();
    if (!path) {
      toast('先选一个文件');
      return;
    }
    if (!window.confirm('删除文件 ' + path + ' ？此操作不可撤销。')) return;

    mutate(function (project) {
      if (project.files.length <= 1) {
        toast('至少要保留一个文件');
        return false;
      }
      project.files = project.files.filter(function (f) {
        return f.path !== path;
      });
      if (project.entry === path) {
        project.entry = Store.pickEntry(project.files);
      }
      return true;
    });
  }

  function setEntry() {
    var path = activePath();
    if (!path) {
      toast('先选一个文件');
      return;
    }
    if (!/\.html?$/i.test(path)) {
      toast('入口必须是 .html 文件');
      return;
    }

    mutate(function (project) {
      project.entry = path;
      return true;
    });
  }

  function copyPath() {
    var path = activePath();
    if (!path) {
      toast('先选一个文件');
      return;
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(path).then(
        function () { toast('已复制：' + path); },
        function () { toast('复制失败'); }
      );
    } else {
      toast(path);
    }
    closeSheet();
  }

  /* ================= 界面 ================= */

  function closeSheet() {
    if (sheetEl) sheetEl.hidden = true;
  }

  function buildSheet() {
    var wrap = document.createElement('div');
    wrap.className = 'sheet';
    wrap.id = 'hrFileSheet';
    wrap.hidden = true;

    var backdrop = document.createElement('div');
    backdrop.className = 'sheet-backdrop';
    backdrop.addEventListener('click', closeSheet);

    var panel = document.createElement('div');
    panel.className = 'sheet-panel compact';

    var head = document.createElement('div');
    head.className = 'sheet-head';
    var title = document.createElement('span');
    title.className = 'sheet-title';
    title.textContent = '文件操作';
    var closeBtn = document.createElement('button');
    closeBtn.className = 'link';
    closeBtn.textContent = '取消';
    closeBtn.addEventListener('click', closeSheet);
    head.appendChild(title);
    head.appendChild(closeBtn);

    var items = [
      { label: '重命名当前文件', action: renameFile },
      { label: '删除当前文件', action: deleteFile },
      { label: '设为入口文件', action: setEntry },
      { label: '复制文件路径', action: copyPath }
    ];

    panel.appendChild(head);
    items.forEach(function (item) {
      var btn = document.createElement('button');
      btn.className = 'sheet-item';
      if (item.label.indexOf('删除') === 0) btn.classList.add('danger');
      btn.textContent = item.label;
      btn.addEventListener('click', function () {
        closeSheet();
        item.action();
      });
      panel.appendChild(btn);
    });

    wrap.appendChild(backdrop);
    wrap.appendChild(panel);
    document.body.appendChild(wrap);
    return wrap;
  }

  function openSheet() {
    if (!sheetEl) sheetEl = buildSheet();
    sheetEl.hidden = false;
  }

  function mount() {
    var tabbar = document.querySelector('.tabbar');
    if (!tabbar || $('hrFileBtn')) return;

    var btn = document.createElement('button');
    btn.id = 'hrFileBtn';
    btn.className = 'addfile';
    btn.textContent = '⋯';
    btn.setAttribute('aria-label', '文件操作');
    btn.addEventListener('click', openSheet);

    var hint = $('saveHint');
    if (hint) tabbar.insertBefore(btn, hint);
    else tabbar.appendChild(btn);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
