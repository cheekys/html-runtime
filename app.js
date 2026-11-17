/* ============================================================
   运行环境 · 逻辑（M2：多项目 + IndexedDB）
   ============================================================ */

(function () {
  'use strict';

  var Store = window.HRStore;
  var RUN_DELAY = 900;
  var SAVE_DELAY = 400;
  var MAX_LOGS = 300;
  var LAST_KEY = 'html-runtime:last-project';

  /* ================= 注入到运行环境的桥接脚本 ================= */
  var BRIDGE = String.raw`
(function () {
  if (window.__RUNTIME_BRIDGE__) return;
  window.__RUNTIME_BRIDGE__ = true;

  function post(type, payload) {
    try {
      parent.postMessage(Object.assign({ __runtime: 1, type: type }, payload || {}), '*');
    } catch (e) {}
  }

  function fmt(value, depth) {
    depth = depth || 0;
    try {
      if (value === null) return 'null';
      if (value === undefined) return 'undefined';
      var t = typeof value;
      if (t === 'string') return value;
      if (t === 'number' || t === 'boolean' || t === 'bigint') return String(value);
      if (t === 'function') return '[Function ' + (value.name || 'anonymous') + ']';
      if (t === 'symbol') return value.toString();
      if (value instanceof Error) return value.name + ': ' + value.message;
      if (typeof Element !== 'undefined' && value instanceof Element) {
        var raw = value.outerHTML || '';
        return raw.length > 300 ? raw.slice(0, 300) + '…' : raw;
      }
      if (depth > 2) return Array.isArray(value) ? '[Array]' : '[Object]';

      var seen = [];
      var json = JSON.stringify(value, function (k, v) {
        if (typeof v === 'function') return '[Function]';
        if (typeof v === 'bigint') return String(v) + 'n';
        if (v && typeof v === 'object') {
          if (seen.indexOf(v) !== -1) return '[Circular]';
          seen.push(v);
        }
        return v;
      });
      return json === undefined ? String(value) : json;
    } catch (e) {
      return '[无法序列化]';
    }
  }

  var levels = ['log', 'info', 'warn', 'error', 'debug'];
  for (var i = 0; i < levels.length; i++) {
    (function (level) {
      var original = console[level] ? console[level].bind(console) : function () {};
      console[level] = function () {
        var parts = [];
        for (var j = 0; j < arguments.length; j++) parts.push(fmt(arguments[j], 0));
        post('console', { level: level, args: parts.join(' ') });
        original.apply(console, arguments);
      };
    })(levels[i]);
  }

  window.addEventListener('error', function (e) {
    var target = e.target;
    if (target && target !== window && target.tagName) {
      post('console', {
        level: 'error',
        args: '资源加载失败：<' + target.tagName.toLowerCase() + '> ' + (target.src || target.href || '')
      });
      return;
    }
    var message = e.message || '未知错误';
    var where = e.lineno
      ? '（第 ' + e.lineno + ' 行' + (e.colno ? '，第 ' + e.colno + ' 列' : '') + '）'
      : '';
    post('console', { level: 'error', args: message + where });
  }, true);

  window.addEventListener('unhandledrejection', function (e) {
    post('console', { level: 'error', args: '未捕获的 Promise 异常：' + fmt(e.reason) });
  });
  /* ---- iOS 音频解锁：第一次触摸时恢复被挂起的音频 ---- */
  var audioContexts = [];

  function patchAudioContext() {
    var Native = window.AudioContext || window.webkitAudioContext;
    if (!Native) return;

    function Wrapped() {
      var ctx = new Native();
      audioContexts.push(ctx);
      return ctx;
    }
    Wrapped.prototype = Native.prototype;

    try {
      window.AudioContext = Wrapped;
      window.webkitAudioContext = Wrapped;
    } catch (e) {}
  }

  var blockedMedia = [];
  var nativePlay = window.HTMLMediaElement && window.HTMLMediaElement.prototype.play;

  if (nativePlay) {
    window.HTMLMediaElement.prototype.play = function () {
      var self = this;
      var result = nativePlay.apply(this, arguments);
      if (result && typeof result.catch === 'function') {
        result.catch(function () {
          if (blockedMedia.indexOf(self) === -1) blockedMedia.push(self);
        });
      }
      return result;
    };
  }

  function unlockAudio() {
    var i;
    for (i = 0; i < audioContexts.length; i++) {
      if (audioContexts[i].state === 'suspended') {
        audioContexts[i].resume().catch(function () {});
      }
    }
    for (i = blockedMedia.length - 1; i >= 0; i--) {
      var media = blockedMedia[i];
      if (!media.paused) {
        blockedMedia.splice(i, 1);
        continue;
      }
      var p = media.play();
      if (p && typeof p.catch === 'function') p.catch(function () {});
      else blockedMedia.splice(i, 1);
    }
  }

  function installAudioUnlock() {
    var events = ['touchstart', 'touchend', 'pointerdown', 'click', 'keydown'];
    for (var i = 0; i < events.length; i++) {
      window.addEventListener(events[i], unlockAudio, { capture: true, passive: true });
    }
  }

  patchAudioContext();
  installAudioUnlock();
  post('ready');
})();
`;

  /* ================= 沙箱策略 ================= */
  var SANDBOX = [
    'allow-scripts',
    'allow-same-origin',
    'allow-forms',
    'allow-modals',
    'allow-popups',
    'allow-pointer-lock',
    'allow-downloads'
  ].join(' ');

  /* ================= 状态 ================= */
  var projects = [];
  var current = null;
  var state = { html: '', css: '', js: '' };
  var currentTab = 'html';
  var currentWindow = null;
  var immersive = false;
  var mobileView = 'code';
  var runTimer = null;
  var saveTimer = null;
  var toastTimer = null;
  var logTotal = 0;
  var errorTotal = 0;
  var actionTarget = null;

  var $ = function (id) { return document.getElementById(id); };

  var editor = $('editor');
  var editorPane = $('editorPane');
  var previewPane = $('previewPane');
  var frameHost = $('frameHost');
  var viewSwitch = $('viewSwitch');
  var consoleHead = $('consoleHead');
  var consoleBody = $('consoleBody');
  var logCountEl = $('logCount');
  var errCountEl = $('errCount');
  var chevEl = $('chev');
  var saveHint = $('saveHint');
  var exitBtn = $('exitBtn');
  var toastEl = $('toast');
  var projectNameEl = $('projectName');
  var projectListEl = $('projectList');
  var projectSheet = $('projectSheet');
  var actionSheet = $('actionSheet');
  var actionTitleEl = $('actionTitle');
  var fileInput = $('fileInput');
  var tabButtons = document.querySelectorAll('.tab');

  /* ================= 文档构建 ================= */
  function buildDocument(code) {
    var css = String(code.css || '').replace(/<\/style/gi, '<\\/style');
    var js = String(code.js || '').replace(/<\/script/gi, '<\\/script');

    return [
      '<!doctype html>',
      '<html lang="zh-CN">',
      '<head>',
      '<meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
      '<link rel="icon" href="data:,">',
      '<script>' + BRIDGE + '</script>',
      '<style>',
      'html, body { margin: 0; }',
      css,
      '</style>',
      '</head>',
      '<body>',
      code.html || '',
      '<script>',
      js,
      '</script>',
      '</body>',
      '</html>'
    ].join('\n');
  }

  /* ================= 运行 ================= */
  function run() {
    clearTimeout(runTimer);

    var iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', SANDBOX);
    iframe.setAttribute('allow', 'autoplay; fullscreen; gamepad; clipboard-write');
    iframe.setAttribute('referrerpolicy', 'no-referrer');
    iframe.setAttribute('title', '运行预览');
    iframe.srcdoc = buildDocument(state);

    frameHost.replaceChildren(iframe);
    currentWindow = iframe.contentWindow;
    clearLogs();
  }

  function scheduleRun() {
    clearTimeout(runTimer);
    runTimer = setTimeout(run, RUN_DELAY);
  }

  /* ================= 控制台 ================= */
  var MARK = { log: '', debug: '', info: 'ℹ ', warn: '⚠ ', error: '✖ ' };

  function updatePills() {
    logCountEl.hidden = logTotal === 0;
    logCountEl.textContent = String(logTotal);
    errCountEl.hidden = errorTotal === 0;
    errCountEl.textContent = errorTotal + ' 错误';
  }

  function appendLog(level, text) {
    var nearBottom = true;
    if (!consoleBody.hidden) {
      nearBottom =
        consoleBody.scrollHeight - consoleBody.scrollTop - consoleBody.clientHeight < 48;
    }

    var empty = consoleBody.querySelector('.console-empty');
    if (empty) empty.remove();

    var row = document.createElement('div');
    row.className = 'log';
    row.setAttribute('data-level', level);

    var mark = document.createElement('span');
    mark.className = 'log-mark';
    mark.textContent = MARK[level] || '';

    var body = document.createElement('span');
    body.className = 'log-text';
    body.textContent = text.length > 2000 ? text.slice(0, 2000) + '…' : text;

    row.appendChild(mark);
    row.appendChild(body);
    consoleBody.appendChild(row);

    while (consoleBody.children.length > MAX_LOGS) {
      consoleBody.removeChild(consoleBody.firstChild);
    }

    logTotal += 1;
    if (level === 'error') {
      errorTotal += 1;
      setConsoleOpen(true);
    }
    updatePills();

    if (!consoleBody.hidden && nearBottom) {
      consoleBody.scrollTop = consoleBody.scrollHeight;
    }
  }

  function clearLogs() {
    consoleBody.textContent = '';
    var empty = document.createElement('p');
    empty.className = 'console-empty';
    empty.textContent = '还没有输出。代码里的 console.log 和运行错误会显示在这里。';
    consoleBody.appendChild(empty);
    logTotal = 0;
    errorTotal = 0;
    updatePills();
  }

  function setConsoleOpen(open) {
    consoleBody.hidden = !open;
    chevEl.textContent = open ? '▾' : '▸';
  }

  /* ================= 保存 ================= */
  function persist() {
    if (!current) return;
    current.html = state.html;
    current.css = state.css;
    current.js = state.js;
    current.updatedAt = Date.now();

    saveHint.textContent = '保存中…';
    Store.putProject(current)
      .then(function () {
        saveHint.textContent = '已保存';
        var replaced = false;
        for (var i = 0; i < projects.length; i++) {
          if (projects[i].id === current.id) {
            projects[i] = current;
            replaced = true;
            break;
          }
        }
        if (!replaced) projects.unshift(current);
      })
      .catch(function () {
        saveHint.textContent = '保存失败';
      });
  }

  function scheduleSave() {
    saveHint.textContent = '未保存';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      saveTimer = null;
      persist();
    }, SAVE_DELAY);
  }

  function flushSave() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
      persist();
    }
  }

  /* ================= 项目 ================= */
  function updateTabButtons() {
    for (var i = 0; i < tabButtons.length; i++) {
      tabButtons[i].classList.toggle('active', tabButtons[i].getAttribute('data-tab') === currentTab);
    }
  }

  function openProject(project, autoRun) {
    current = project;
    state.html = project.html || '';
    state.css = project.css || '';
    state.js = project.js || '';
    currentTab = 'html';
    editor.value = state.html;
    updateTabButtons();
    projectNameEl.textContent = project.name;

    try {
      localStorage.setItem(LAST_KEY, project.id);
    } catch (e) {}

    var hasContent = Boolean(state.html || state.css || state.js);
    if (autoRun && hasContent) {
      run();
    } else if (hasContent) {
      showRestoredHint();
    } else {
      showBlank();
    }
  }

  function formatTime(ts) {
    if (!ts) return '—';
    var d = new Date(ts);
    var pad = function (n) { return n < 10 ? '0' + n : String(n); };
    return (d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function sizeLabel(project) {
    var bytes = (project.html || '').length + (project.css || '').length + (project.js || '').length;
    if (bytes < 1024) return bytes + ' B';
    return (bytes / 1024).toFixed(1) + ' KB';
  }

  function renderProjects() {
    projectListEl.textContent = '';

    if (!projects.length) {
      var empty = document.createElement('p');
      empty.className = 'project-empty';
      empty.textContent = '还没有项目。点上面的「新建」开始。';
      projectListEl.appendChild(empty);
      return;
    }

    projects.forEach(function (project) {
      var row = document.createElement('div');
      row.className = 'project-row';
      if (current && project.id === current.id) row.classList.add('active');

      var meta = document.createElement('div');
      meta.className = 'project-meta';

      var name = document.createElement('div');
      name.className = 'project-row-name';
      name.textContent = project.name;

      var sub = document.createElement('div');
      sub.className = 'project-row-sub';
      sub.textContent = formatTime(project.updatedAt) + ' · ' + sizeLabel(project);

      meta.appendChild(name);
      meta.appendChild(sub);

      var more = document.createElement('button');
      more.className = 'more-btn';
      more.textContent = '⋯';
      more.setAttribute('aria-label', '更多操作');
      more.addEventListener('click', function (e) {
        e.stopPropagation();
        openActions(project);
      });

      row.appendChild(meta);
      row.appendChild(more);
      row.addEventListener('click', function () {
        switchTo(project);
      });

      projectListEl.appendChild(row);
    });
  }

  function switchTo(project) {
    closeSheet('projectSheet');
    if (current && current.id === project.id) return;
    flushSave();
    Store.getProject(project.id).then(function (full) {
      openProject(full || project, true);
    });
  }

  function openActions(project) {
    actionTarget = project;
    actionTitleEl.textContent = project.name;
    actionSheet.hidden = false;
  }

  function closeSheet(id) {
    var el = $(id);
    if (el) el.hidden = true;
  }

  /* ================= 界面 ================= */
  function toast(message) {
    toastEl.textContent = message;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastEl.classList.remove('show');
    }, 1800);
  }

  function isWide() {
    return window.innerWidth >= 900;
  }

  function updateLayout() {
    var wide = isWide();
    var showEditor = wide || (mobileView === 'code' && !immersive);
    var showPreview = wide || mobileView === 'preview' || immersive;

    editorPane.hidden = !showEditor;
    previewPane.hidden = !showPreview;
    previewPane.classList.toggle('immersive', immersive);
    exitBtn.hidden = !immersive;
    viewSwitch.hidden = wide || immersive;

    var buttons = viewSwitch.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].classList.toggle('active', buttons[i].getAttribute('data-view') === mobileView);
    }
  }

  function showRestoredHint() {
    var box = document.createElement('div');
    box.className = 'placeholder';
    var title = document.createElement('strong');
    title.textContent = '项目已加载';
    var desc = document.createElement('div');
    desc.textContent = '点右上角「运行」查看效果。';
    box.appendChild(title);
    box.appendChild(desc);
    frameHost.replaceChildren(box);
    currentWindow = null;
  }

  function showBlank() {
    var box = document.createElement('div');
    box.className = 'blank-hint';
    box.textContent = '空白';
    frameHost.replaceChildren(box);
    currentWindow = null;
  }

  function setTab(tab) {
    state[currentTab] = editor.value;
    currentTab = tab;
    editor.value = state[tab];
    updateTabButtons();
    editor.focus();
  }

  /* ================= 事件：编辑器 ================= */
  editor.addEventListener('input', function () {
    state[currentTab] = editor.value;
    scheduleSave();
    scheduleRun();
  });

  editor.addEventListener('keydown', function (e) {
    if (e.key !== 'Tab') return;
    e.preventDefault();
    var start = editor.selectionStart;
    var end = editor.selectionEnd;
    editor.value = editor.value.slice(0, start) + '  ' + editor.value.slice(end);
    editor.selectionStart = editor.selectionEnd = start + 2;
    state[currentTab] = editor.value;
    scheduleSave();
  });

  for (var i = 0; i < tabButtons.length; i++) {
    (function (btn) {
      btn.addEventListener('click', function () {
        setTab(btn.getAttribute('data-tab'));
      });
    })(tabButtons[i]);
  }

  /* ================= 事件：运行 / 全屏 ================= */
  $('runBtn').addEventListener('click', function () {
    run();
    if (!isWide()) {
      mobileView = 'preview';
      updateLayout();
    }
  });

  $('fullBtn').addEventListener('click', function () {
    immersive = !immersive;
    if (immersive && !isWide()) mobileView = 'preview';
    updateLayout();
  });

  exitBtn.addEventListener('click', function () {
    immersive = false;
    updateLayout();
  });

  /* ================= 事件：项目列表 ================= */
  $('projectBtn').addEventListener('click', function () {
    renderProjects();
    projectSheet.hidden = false;
  });

  $('newProjectBtn').addEventListener('click', function () {
    var name = window.prompt('项目名称', '新项目');
    if (name === null) return;
    name = String(name).trim() || '未命名项目';
    flushSave();
    Store.createProject(name).then(function (project) {
      projects.unshift(project);
      closeSheet('projectSheet');
      openProject(project, false);
      toast('已创建「' + name + '」');
    });
  });

  $('importBtn').addEventListener('click', function () {
    fileInput.click();
  });

  fileInput.addEventListener('change', function () {
    var file = fileInput.files && fileInput.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var parsed = Store.parseHtmlFile(String(reader.result || ''));
      var name = file.name.replace(/\.(html?|HTML?)$/, '') || '导入项目';
      flushSave();
      Store.createProject(name, parsed).then(function (project) {
        projects.unshift(project);
        closeSheet('projectSheet');
        openProject(project, true);
        toast('已导入「' + name + '」');
      });
    };
    reader.onerror = function () {
      toast('文件读取失败');
    };
    reader.readAsText(file);
    fileInput.value = '';
  });

  /* ================= 事件：项目操作 ================= */
  $('renameBtn').addEventListener('click', function () {
    if (!actionTarget) return;
    var name = window.prompt('新名称', actionTarget.name);
    if (name === null) return;
    name = String(name).trim() || actionTarget.name;
    actionTarget.name = name;
    actionTarget.updatedAt = Date.now();

    Store.putProject(actionTarget).then(function () {
      if (current && current.id === actionTarget.id) {
        current.name = name;
        projectNameEl.textContent = name;
      }
      closeSheet('actionSheet');
      renderProjects();
      toast('已重命名');
    });
  });

  $('exportBtn').addEventListener('click', function () {
    if (!actionTarget) return;
    var html = Store.buildStandaloneHtml(actionTarget);
    var filename = actionTarget.name.replace(/[\\/:*?"<>|]/g, '_') + '.html';
    Store.downloadText(filename, html);
    closeSheet('actionSheet');
    toast('已导出 ' + filename);
  });

  $('copyHtmlBtn').addEventListener('click', function () {
    if (!actionTarget) return;
    Store.copyText(Store.buildStandaloneHtml(actionTarget))
      .then(function () {
        closeSheet('actionSheet');
        toast('完整 HTML 已复制');
      })
      .catch(function () {
        toast('复制失败');
      });
  });

  $('copyJsonBtn').addEventListener('click', function () {
    if (!actionTarget) return;
    Store.copyText(JSON.stringify(actionTarget))
      .then(function () {
        closeSheet('actionSheet');
        toast('JSON 已复制');
      })
      .catch(function () {
        toast('复制失败');
      });
  });

  $('deleteBtn').addEventListener('click', function () {
    if (!actionTarget) return;
    var target = actionTarget;
    if (!window.confirm('删除「' + target.name + '」？此操作不可撤销。')) return;

    Store.deleteProject(target.id).then(function () {
      projects = projects.filter(function (p) {
        return p.id !== target.id;
      });
      closeSheet('actionSheet');
      closeSheet('projectSheet');

      if (current && current.id === target.id) {
        current = null;
        if (projects.length) {
          openProject(projects[0], true);
        } else {
          Store.createProject('未命名项目').then(function (project) {
            projects = [project];
            openProject(project, false);
          });
        }
      }
      renderProjects();
      toast('已删除');
    });
  });

  /* ================= 事件：弹层关闭 ================= */
  var closers = document.querySelectorAll('[data-close]');
  for (var c = 0; c < closers.length; c++) {
    (function (el) {
      el.addEventListener('click', function () {
        closeSheet(el.getAttribute('data-close'));
      });
    })(closers[c]);
  }

  /* ================= 事件：控制台 ================= */
  consoleHead.addEventListener('click', function (e) {
    if (e.target.closest('button')) return;
    setConsoleOpen(consoleBody.hidden);
  });

  $('clearBtn').addEventListener('click', function (e) {
    e.stopPropagation();
    clearLogs();
  });

  /* ================= 事件：视图切换 ================= */
  viewSwitch.addEventListener('click', function (e) {
    var btn = e.target.closest('button');
    if (!btn) return;
    mobileView = btn.getAttribute('data-view');
    updateLayout();
  });

  window.addEventListener('resize', updateLayout);
  window.addEventListener('orientationchange', function () {
    setTimeout(updateLayout, 120);
  });

  window.addEventListener('message', function (event) {
    if (!currentWindow || event.source !== currentWindow) return;
    var data = event.data;
    if (!data || data.__runtime !== 1) return;
    if (data.type === 'console') {
      appendLog(data.level || 'log', String(data.args || ''));
    }
  });

  /* ================= 应用被切到后台时立刻保存 ================= */
  window.addEventListener('pagehide', flushSave);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') flushSave();
  });

  /* ================= 启动 ================= */
  function boot() {
    editor.value = '';
    setConsoleOpen(false);
    updateLayout();

    Store.migrateLegacy()
      .then(function () {
        return Store.listProjects();
      })
      .then(function (list) {
        projects = list;
        var lastId = null;
        try {
          lastId = localStorage.getItem(LAST_KEY);
        } catch (e) {}

        var target = null;
        for (var i = 0; i < list.length; i++) {
          if (list[i].id === lastId) {
            target = list[i];
            break;
          }
        }
        if (!target) target = list[0];
        if (target) return target;
        return Store.createProject('未命名项目').then(function (project) {
          projects = [project];
          return project;
        });
      })
      .then(function (project) {
        openProject(project, false);
      })
      .catch(function (err) {
        if (window.console) console.error(err);
        toast('存储不可用，改动不会保存');
        openProject(
          { id: 'temp', name: '临时项目', html: '', css: '', js: '', createdAt: Date.now(), updatedAt: Date.now() },
          false
        );
      });
  }

  boot();
})();
