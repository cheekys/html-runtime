/* ============================================================
   运行环境 · 逻辑
   ============================================================ */

(function () {
  'use strict';

  var STORAGE_KEY = 'html-runtime:code:v1';
  var RUN_DELAY = 900;
  var SAVE_DELAY = 400;
  var MAX_LOGS = 300;

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

  /* ================= 空白项目 ================= */
  var EMPTY_CODE = { html: '', css: '', js: '' };

  /* ================= 状态 ================= */
  var state = { html: '', css: '', js: '' };
  var currentTab = 'html';
  var currentWindow = null;
  var immersive = false;
  var mobileView = 'code';
  var restored = false;
  var runTimer = null;
  var saveTimer = null;
  var toastTimer = null;
  var logTotal = 0;
  var errorTotal = 0;

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
  var tabButtons = document.querySelectorAll('.tab');

  /* ================= 文档构建 ================= */
  function buildDocument(code) {
    // 用户代码里如果出现 </script> 或 </style>，会提前闭合标签，必须转义
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

  /* ================= 存储 ================= */
  function load() {
    var saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    } catch (e) {
      saved = null;
    }

    var hasContent =
      saved &&
      typeof saved.html === 'string' &&
      Boolean(saved.html || saved.css || saved.js);

    if (hasContent) {
      state.html = saved.html;
      state.css = typeof saved.css === 'string' ? saved.css : '';
      state.js = typeof saved.js === 'string' ? saved.js : '';
      restored = true;
    } else {
      state.html = EMPTY_CODE.html;
      state.css = EMPTY_CODE.css;
      state.js = EMPTY_CODE.js;
    }
  }

  function scheduleSave() {
    saveHint.textContent = '未保存';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        saveHint.textContent = '已保存';
      } catch (e) {
        saveHint.textContent = '保存失败';
      }
    }, SAVE_DELAY);
  }

  function copyBackup() {
    var payload = JSON.stringify(state);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(payload).then(
        function () { toast('全部代码已复制到剪贴板'); },
        function () { toast('复制失败，请手动选择文本'); }
      );
    } else {
      toast('当前环境不支持剪贴板');
    }
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
    title.textContent = '上次的代码已恢复';
    var desc = document.createElement('div');
    desc.textContent = '为了安全起见不会自动运行。点右上角「运行」即可预览。';
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
    for (var i = 0; i < tabButtons.length; i++) {
      tabButtons[i].classList.toggle('active', tabButtons[i].getAttribute('data-tab') === tab);
    }
    editor.focus();
  }

  /* ================= 事件 ================= */
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

  $('clearAllBtn').addEventListener('click', function () {
    if (!window.confirm('确定清空所有代码吗？此操作不可撤销。')) return;
    state.html = '';
    state.css = '';
    state.js = '';
    editor.value = state[currentTab];
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (e) {}
    saveHint.textContent = '空白项目';
    clearLogs();
    showBlank();
    toast('已清空');
  });

  consoleHead.addEventListener('click', function (e) {
    if (e.target.closest('button')) return;
    setConsoleOpen(consoleBody.hidden);
  });

  $('clearBtn').addEventListener('click', function (e) {
    e.stopPropagation();
    clearLogs();
  });

  $('backupBtn').addEventListener('click', function (e) {
    e.stopPropagation();
    copyBackup();
  });

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

  /* ================= 启动 ================= */
  load();
  editor.value = state[currentTab];
  setConsoleOpen(false);
  updateLayout();

  if (restored) {
    saveHint.textContent = '已恢复';
    showRestoredHint();
  } else {
    saveHint.textContent = '空白项目';
    showBlank();
  }
})();
