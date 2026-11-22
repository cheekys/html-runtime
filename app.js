/* ============================================================
   运行环境 · 逻辑（M5：路径垫片 + 音频兼容 + 触摸容错）
   ============================================================ */

(function () {
  'use strict';

  var Store = window.HRStore;
  var RUN_DELAY = 900;
  var SAVE_DELAY = 400;
  var MAX_LOGS = 300;
  var LAST_KEY = 'html-runtime:last-project';

  /* ================= 桥接脚本 ================= */
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

  /* ---- iOS 音频解锁 ---- */
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

    // 给 decodeAudioData 加日志：成功和失败都报一声
    var proto = null;
    if (window.BaseAudioContext && BaseAudioContext.prototype.decodeAudioData) {
      proto = BaseAudioContext.prototype;
    } else if (window.AudioContext && AudioContext.prototype.decodeAudioData) {
      proto = AudioContext.prototype;
    }
    if (!proto) return;

    var nativeDecode = proto.decodeAudioData;

    proto.decodeAudioData = function () {
      var self = this;
      var args = Array.prototype.slice.call(arguments);
      var logged = false;

      function reportFail(err) {
        if (logged) return;
        logged = true;
        post('console', {
          level: 'error',
          args: '音频解码失败：' + (err && err.name ? err.name : String(err || '未知'))
        });
      }

      function reportOk(buffer) {
        if (logged) return;
        logged = true;
        var sec = buffer && buffer.duration ? buffer.duration.toFixed(1) : '?';
        post('console', { level: 'info', args: '音频解码成功：' + sec + ' 秒' });
      }

      if (typeof args[1] === 'function') {
        var ok = args[1];
        var fail = args[2];
        args[1] = function (buffer) {
          reportOk(buffer);
          if (ok) ok(buffer);
        };
        args[2] = function (err) {
          reportFail(err);
          if (fail) fail(err);
        };
      }

      var ret = nativeDecode.apply(self, args);

      if (ret && typeof ret.then === 'function') {
        ret.then(reportOk, reportFail);
      }
      return ret;
    };
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

    if (!window.__HR_AUDIO_LOGGED__) {
      window.__HR_AUDIO_LOGGED__ = true;
      var states = [];
      for (i = 0; i < audioContexts.length; i++) states.push(audioContexts[i].state);
      post('console', {
        level: 'info',
        args: '音频解锁：AudioContext ' + audioContexts.length + ' 个，状态 ' +
          (states.join(',') || '无')
      });
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

  /* ---- 相对路径垫片：拦截 JS 里的动态资源请求 ---- */
  var ASSETS = window.__HR_ASSETS__ || {};
  var BASE_DIR = window.__HR_BASE__ || '';
  var AUDIO_EXT = { ogg: 1, m4a: 1, mp3: 1, wav: 1, aac: 1 };

  var AUDIO_CAN = (function () {
    var can = {};
    try {
      var probe = document.createElement('audio');
      var map = {
        ogg: 'audio/ogg; codecs="vorbis"',
        m4a: 'audio/mp4',
        mp3: 'audio/mpeg',
        wav: 'audio/wav',
        aac: 'audio/aac'
      };
      for (var key in map) {
        if (!map.hasOwnProperty(key)) continue;
        can[key] = !!probe.canPlayType(map[key]);
      }
    } catch (e) {}
    return can;
  })();

  function normalizePath(input) {
    var parts = String(input || '').split('/');
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var seg = parts[i];
      if (!seg || seg === '.') continue;
      if (seg === '..') out.pop();
      else out.push(seg);
    }
    return out.join('/');
  }

  function noteFormatSwap(from, to) {
    if (!window.__HR_FMT_LOGGED__) window.__HR_FMT_LOGGED__ = {};
    if (window.__HR_FMT_LOGGED__[from]) return;
    window.__HR_FMT_LOGGED__[from] = true;
    try {
      post('console', { level: 'info', args: '音频格式替换：' + from + ' → ' + to });
    } catch (e) {}
  }

    // 只在原格式是 ogg（Apple 平台解不了）时，换成同名的 m4a / mp3
  function pickAltAudio(path) {
    var dot = path.lastIndexOf('.');
    if (dot <= 0) return null;
    if (path.slice(dot + 1).toLowerCase() !== 'ogg') return null;

    var stem = path.slice(0, dot);
    var alts = ['m4a', 'mp3', 'wav'];
    for (var i = 0; i < alts.length; i++) {
      if (ASSETS[stem + '.' + alts[i]]) return stem + '.' + alts[i];
    }
    return null;
  }

  function resolveAsset(url) {
    try {
      if (url == null) return url;
      var s = String(url);
      if (!s) return s;
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(s)) return s;

      var noQuery = s.replace(/[?#].*$/, '');
      if (!noQuery) return s;

      var path = noQuery.charAt(0) === '/'
        ? normalizePath(noQuery.slice(1))
        : normalizePath((BASE_DIR ? BASE_DIR + '/' : '') + noQuery);

      if (ASSETS[path]) {
        var altPath = pickAltAudio(path);
        if (altPath) {
          noteFormatSwap(path, altPath);
          return ASSETS[altPath];
        }
        return ASSETS[path];
      }

      // 文件本身不存在时，音频也尝试同名换格式
      var dot = path.lastIndexOf('.');
      if (dot > 0 && AUDIO_EXT[path.slice(dot + 1).toLowerCase()]) {
        var stem = path.slice(0, dot);
        var alts = ['m4a', 'mp3', 'ogg', 'wav', 'aac'];
        for (var i = 0; i < alts.length; i++) {
          var cand = stem + '.' + alts[i];
          if (ASSETS[cand]) {
            noteFormatSwap(path, cand);
            return ASSETS[cand];
          }
        }
      }

      return s;
    } catch (e) {
      return url;
    }
  }

  // 1) XMLHttpRequest（howler 走的就是这条）
  if (window.XMLHttpRequest && XMLHttpRequest.prototype.open) {
    var nativeXhrOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      var args = Array.prototype.slice.call(arguments);
      if (args.length > 1) args[1] = resolveAsset(args[1]);
      return nativeXhrOpen.apply(this, args);
    };
  }

  // 2) fetch
  if (window.fetch) {
    var nativeFetch = window.fetch;
    window.fetch = function (input, init) {
      try {
        if (typeof input === 'string') input = resolveAsset(input);
      } catch (e) {}
      return nativeFetch.call(window, input, init);
    };
  }

  // 3) img.src / audio.src / script.src
  function patchSrcProperty(proto) {
    if (!proto) return;
    var desc = Object.getOwnPropertyDescriptor(proto, 'src');
    if (!desc || !desc.set || !desc.get) return;
    try {
      Object.defineProperty(proto, 'src', {
        configurable: true,
        enumerable: desc.enumerable,
        get: desc.get,
        set: function (value) {
          desc.set.call(this, resolveAsset(value));
        }
      });
    } catch (e) {}
  }

  patchSrcProperty(window.HTMLImageElement && HTMLImageElement.prototype);
  patchSrcProperty(window.HTMLMediaElement && HTMLMediaElement.prototype);
  patchSrcProperty(window.HTMLScriptElement && HTMLScriptElement.prototype);
  patchSrcProperty(window.HTMLSourceElement && HTMLSourceElement.prototype);

  // 4) setAttribute('src', ...)
  if (window.Element && Element.prototype.setAttribute) {
    var nativeSetAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) {
      var key = String(name).toLowerCase();
      if (key === 'src' || key === 'href' || key === 'poster' || key === 'data') {
        value = resolveAsset(value);
      }
      return nativeSetAttribute.call(this, name, value);
    };
  }

  /* ---- 触摸列表容错：部分游戏用错数组长度，越界会抛异常 ---- */
  function clampTouchList(list) {
    if (!list) return list;
    var len = list.length;
    var last = len ? list[len - 1] : null;
    var safe = {
      length: len,
      item: function (i) { return safe[i] || last; }
    };
    for (var i = 0; i < len; i++) safe[i] = list[i];
    if (last) {
      for (var j = len; j < 8; j++) safe[j] = last;
    }
    return safe;
  }

  function patchTouchList(name) {
    if (!window.TouchEvent) return;
    var desc = Object.getOwnPropertyDescriptor(TouchEvent.prototype, name);
    if (!desc || !desc.get) return;
    try {
      Object.defineProperty(TouchEvent.prototype, name, {
        configurable: true,
        enumerable: desc.enumerable,
        get: function () {
          return clampTouchList(desc.get.call(this));
        }
      });
    } catch (e) {}
  }

  patchTouchList('changedTouches');
  patchTouchList('touches');
  patchTouchList('targetTouches');

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
  var currentPath = '';
  var immersive = false;
  var mobileView = 'code';
  var runTimer = null;
  var saveTimer = null;
  var toastTimer = null;
  var logTotal = 0;
  var errorTotal = 0;
  var actionTarget = null;
  var currentWindow = null;
  var assetUrls = [];
  var previewUrl = '';

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
  var fileTabsEl = $('fileTabs');
  var binaryPreviewEl = $('binaryPreview');

  /* ================= 运行 ================= */
  function releaseAssets() {
    for (var i = 0; i < assetUrls.length; i++) {
      URL.revokeObjectURL(assetUrls[i]);
    }
    assetUrls = [];
  }

  function injectGameStyles(on) {
    var iframe = frameHost.querySelector('iframe');
    if (!iframe) return;

    var doc = null;
    try {
      doc = iframe.contentDocument;
    } catch (e) {
      return;
    }
    if (!doc) return;

    var existing = doc.getElementById('__hr_game_style__');

    if (on && !existing) {
      var style = doc.createElement('style');
      style.id = '__hr_game_style__';
      style.textContent = [
        'html, body {',
        '  margin: 0;',
        '  overscroll-behavior: none;',
        '  -webkit-touch-callout: none;',
        '  -webkit-user-select: none;',
        '  user-select: none;',
        '  -webkit-tap-highlight-color: transparent;',
        '  touch-action: manipulation;',
        '}'
      ].join('\n');
      (doc.head || doc.documentElement).appendChild(style);
    } else if (!on && existing) {
      existing.parentNode.removeChild(existing);
    }
  }

  function run() {
    clearTimeout(runTimer);
    if (!current) return;

    commitEditor();
    releaseAssets();

    var built = Store.createAssetMap(current);
    assetUrls = built.urls;

    var doc = Store.buildRuntimeDocument(current, built.map, BRIDGE);

    var iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', SANDBOX);
    iframe.setAttribute('allow', 'autoplay; fullscreen; gamepad; clipboard-write');
    iframe.setAttribute('referrerpolicy', 'no-referrer');
    iframe.setAttribute('title', '运行预览');
    iframe.srcdoc = doc;

    iframe.addEventListener('load', function () {
      if (immersive) injectGameStyles(true);
    });

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
    commitEditor();
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
      persist();
    }
  }

  /* ================= 文件与编辑器 ================= */
  function commitEditor() {
    if (!current || !currentPath) return;
    var file = Store.findFile(current, currentPath);
    if (!file || file.kind !== 'text') return;
    if (file.text === editor.value) return;
    file.text = editor.value;
  }

  function renderFileTabs() {
    fileTabsEl.textContent = '';
    if (!current) return;

    current.files.forEach(function (file) {
      var tab = document.createElement('button');
      tab.className = 'tab';
      tab.setAttribute('data-path', file.path);
      if (file.path === currentPath) tab.classList.add('active');
      if (file.path === current.entry) tab.classList.add('entry');
      tab.textContent = file.path.split('/').pop();
      tab.title = file.path;
      tab.addEventListener('click', function () {
        commitEditor();
        selectFile(file.path, true);
      });
      fileTabsEl.appendChild(tab);
    });

    var active = fileTabsEl.querySelector('.tab.active');
    if (active && active.scrollIntoView) {
      active.scrollIntoView({ block: 'nearest', inline: 'center' });
    }
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(2) + ' MB';
  }

  function renderBinaryPreview(file) {
    binaryPreviewEl.textContent = '';

    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      previewUrl = '';
    }

    if (file.blob) {
      previewUrl = URL.createObjectURL(file.blob);
      var mime = file.mime || '';

      if (mime.indexOf('image/') === 0) {
        var img = document.createElement('img');
        img.className = 'preview-image';
        img.src = previewUrl;
        img.alt = file.path;
        binaryPreviewEl.appendChild(img);
      } else if (mime.indexOf('audio/') === 0) {
        var audio = document.createElement('audio');
        audio.src = previewUrl;
        audio.controls = true;
        binaryPreviewEl.appendChild(audio);
      } else if (mime.indexOf('video/') === 0) {
        var video = document.createElement('video');
        video.className = 'preview-video';
        video.src = previewUrl;
        video.controls = true;
        binaryPreviewEl.appendChild(video);
      } else {
        var tip = document.createElement('div');
        tip.className = 'preview-tip';
        tip.textContent = '这个类型没法预览，但运行时会正常加载。';
        binaryPreviewEl.appendChild(tip);
      }
    }

    var meta = document.createElement('div');
    meta.className = 'preview-meta';
    meta.textContent = file.path + ' · ' + formatBytes(file.blob ? file.blob.size : 0);
    binaryPreviewEl.appendChild(meta);
  }

  function selectFile(path, focus) {
    if (!current) return;

    var file = Store.findFile(current, path);
    currentPath = file ? path : '';
    renderFileTabs();

    if (!file) {
      editor.hidden = false;
      binaryPreviewEl.hidden = true;
      editor.value = '';
      return;
    }

    if (file.kind === 'text') {
      binaryPreviewEl.hidden = true;
      editor.hidden = false;
      editor.value = file.text || '';
      if (focus) editor.focus();
    } else {
      editor.hidden = true;
      binaryPreviewEl.hidden = false;
      renderBinaryPreview(file);
    }
  }

  /* ================= 项目 ================= */
  function openProject(project, autoRun) {
    commitEditor();
    current = project;
    currentPath = '';
    projectNameEl.textContent = project.name;

    try {
      localStorage.setItem(LAST_KEY, project.id);
    } catch (e) {}

    selectFile(project.entry, false);

    var entryFile = Store.findFile(project, project.entry);
    var hasContent = entryFile && entryFile.kind === 'text' && (entryFile.text || '').trim();

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
    var bytes = 0;
    project.files.forEach(function (file) {
      bytes += file.kind === 'text' ? (file.text || '').length : (file.blob ? file.blob.size : 0);
    });
    return formatBytes(bytes);
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
      sub.textContent =
        formatTime(project.updatedAt) + ' · ' + project.files.length + ' 个文件 · ' + sizeLabel(project);

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

  /* ================= 事件：编辑器 ================= */
  editor.addEventListener('input', function () {
    if (!current || !currentPath) return;
    var file = Store.findFile(current, currentPath);
    if (!file || file.kind !== 'text') return;
    file.text = editor.value;
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

    if (current && currentPath) {
      var file = Store.findFile(current, currentPath);
      if (file && file.kind === 'text') file.text = editor.value;
    }
    scheduleSave();
  });

  $('addFileBtn').addEventListener('click', function () {
    if (!current) return;
    var path = window.prompt('新建文件（可以带目录）', 'untitled.js');
    if (path === null) return;

    path = String(path).trim().replace(/^\/+/, '');
    if (!path) return;
    if (Store.findFile(current, path)) {
      toast('这个文件已存在');
      return;
    }

    commitEditor();
    current.files.push(Store.makeFile(path, ''));
    if (!current.entry) current.entry = path;
    selectFile(path, true);
    scheduleSave();
    renderFileTabs();
    toast('已新建 ' + path);
  });

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
    injectGameStyles(immersive);
  });

  exitBtn.addEventListener('click', function () {
    immersive = false;
    updateLayout();
    injectGameStyles(false);
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
    fileInput.value = '';

    var isZip = /\.zip$/i.test(file.name);
    flushSave();

    if (isZip) {
      var reader = new FileReader();
      reader.onload = function () {
        toast('正在解压…');
        Store.importZip(reader.result, file.name.replace(/\.zip$/i, ''))
          .then(function (result) {
            return Store.createProject(result.name, result.files);
          })
          .then(function (project) {
            projects.unshift(project);
            closeSheet('projectSheet');
            openProject(project, true);
            toast('已导入 ' + project.files.length + ' 个文件');
          })
          .catch(function (err) {
            toast(err && err.message ? err.message : '导入失败');
          });
      };
      reader.onerror = function () {
        toast('文件读取失败');
      };
      reader.readAsArrayBuffer(file);
      return;
    }

    var textReader = new FileReader();
    textReader.onload = function () {
      var text = String(textReader.result || '');
      var name = file.name.replace(/\.(html?|HTML?)$/, '') || '导入项目';
      var files = Store.makeHtmlProjectFiles(text);
      Store.createProject(name, files)
        .then(function (project) {
          projects.unshift(project);
          closeSheet('projectSheet');
          openProject(project, true);
          toast('已导入');
        })
        .catch(function () {
          toast('导入失败');
        });
    };
    textReader.onerror = function () {
      toast('文件读取失败');
    };
    textReader.readAsText(file);
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
    var target = actionTarget;
    toast('正在打包…');

    Store.buildStandaloneHtml(target)
      .then(function (html) {
        var filename = target.name.replace(/[\\/:*?"<>|]/g, '_') + '.html';
        Store.downloadText(filename, html);
        closeSheet('actionSheet');
        toast('已导出 ' + filename);
      })
      .catch(function (err) {
        toast('导出失败：' + (err && err.message ? err.message : '未知错误'));
      });
  });

  $('copyHtmlBtn').addEventListener('click', function () {
    if (!actionTarget) return;
    Store.buildStandaloneHtml(actionTarget)
      .then(function (html) {
        return Store.copyText(html);
      })
      .then(function () {
        closeSheet('actionSheet');
        toast('完整 HTML 已复制');
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
        currentPath = '';
        releaseAssets();
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
          Store.normalizeProject({
            id: 'temp',
            name: '临时项目',
            files: []
          }),
          false
        );
      });
  }

  boot();
})();
