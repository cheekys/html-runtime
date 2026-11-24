/* ============================================================
   虚拟手柄 / 虚拟摇杆（独立挂载，不修改 app.js）
   ============================================================ */

(function () {
  'use strict';

  var PREF_ON = 'html-runtime:pad-on:';
  var PREF_PRESET = 'html-runtime:pad-preset';

  var pane = document.getElementById('previewPane');
  if (!pane) return;

  var root = null;
  var toggleBtn = null;
  var enabled = false;
  var presetIndex = 0;
  var activeDefs = [];
  var wasImmersive = false;

  /* ================= 预设 ================= */
  function arrows() {
    return {
      up: { code: 'ArrowUp', key: 'ArrowUp', keyCode: 38 },
      down: { code: 'ArrowDown', key: 'ArrowDown', keyCode: 40 },
      left: { code: 'ArrowLeft', key: 'ArrowLeft', keyCode: 37 },
      right: { code: 'ArrowRight', key: 'ArrowRight', keyCode: 39 }
    };
  }

  function wasd() {
    return {
      up: { code: 'KeyW', key: 'w', keyCode: 87 },
      down: { code: 'KeyS', key: 's', keyCode: 83 },
      left: { code: 'KeyA', key: 'a', keyCode: 65 },
      right: { code: 'KeyD', key: 'd', keyCode: 68 }
    };
  }

  var SPACE = { code: 'Space', key: ' ', keyCode: 32 };
  var ENTER = { code: 'Enter', key: 'Enter', keyCode: 13 };
  var KEY_J = { code: 'KeyJ', key: 'j', keyCode: 74 };
  var KEY_K = { code: 'KeyK', key: 'k', keyCode: 75 };

  var PRESETS = [
    { mode: 'dpad', short: '十字·方向', dir: arrows(), a: SPACE, b: ENTER },
    { mode: 'stick', short: '摇杆·方向', dir: arrows(), a: SPACE, b: ENTER },
    { mode: 'dpad', short: '十字·WASD', dir: wasd(), a: KEY_J, b: KEY_K },
    { mode: 'stick', short: '摇杆·WASD', dir: wasd(), a: KEY_J, b: KEY_K }
  ];

  /* ================= 偏好：按项目记忆 ================= */
  function projectId() {
    try {
      return localStorage.getItem('html-runtime:last-project') || 'default';
    } catch (e) {
      return 'default';
    }
  }

  function loadPref() {
    try {
      enabled = localStorage.getItem(PREF_ON + projectId()) === '1';
      var saved = parseInt(localStorage.getItem(PREF_PRESET) || '0', 10);
      if (!isNaN(saved) && saved >= 0 && saved < PRESETS.length) presetIndex = saved;
    } catch (e) {
      enabled = false;
    }
  }

  function savePref() {
    try {
      localStorage.setItem(PREF_ON + projectId(), enabled ? '1' : '0');
    } catch (e) {}
  }

  /* ================= 样式 ================= */
  function injectStyle() {
    var css = [
      '.gp-root{position:absolute;left:0;right:0;bottom:0;z-index:25;',
      'padding:0 14px calc(env(safe-area-inset-bottom,0px) + 16px);',
      'display:flex;align-items:flex-end;justify-content:space-between;',
      'pointer-events:none;user-select:none;-webkit-user-select:none;',
      '-webkit-touch-callout:none;}',
      '.gp-left-zone{pointer-events:none;display:flex;align-items:flex-end;}',
      '.gp-pad{display:grid;grid-template-columns:repeat(3,48px);',
      'grid-template-rows:repeat(3,48px);gap:5px;pointer-events:none;}',
      '.gp-up{grid-area:1/2;}',
      '.gp-left{grid-area:2/1;}',
      '.gp-right{grid-area:2/3;}',
      '.gp-down{grid-area:3/2;}',
      '.gp-actions{display:flex;gap:12px;align-items:flex-end;pointer-events:none;}',
      '.gp-key{pointer-events:auto;appearance:none;padding:0;line-height:1;',
      'width:48px;height:48px;border-radius:12px;font-size:15px;',
      'border:1px solid rgba(255,255,255,0.28);background:rgba(18,24,34,0.5);',
      'color:rgba(255,255,255,0.92);backdrop-filter:blur(6px);',
      'touch-action:none;-webkit-tap-highlight-color:transparent;',
      'transition:background 0.06s,transform 0.06s;}',
      '.gp-key.gp-active{background:rgba(76,141,255,0.8);',
      'border-color:rgba(255,255,255,0.6);transform:scale(0.95);}',
      '.gp-a,.gp-b{width:58px;height:58px;border-radius:50%;',
      'font-size:16px;font-weight:600;}',
      '.gp-stick{position:relative;width:116px;height:116px;border-radius:50%;',
      'border:2px solid rgba(255,255,255,0.2);background:rgba(18,24,34,0.32);',
      'backdrop-filter:blur(6px);pointer-events:auto;touch-action:none;',
      'display:flex;align-items:center;justify-content:center;}',
      '.gp-stick-knob{width:50px;height:50px;border-radius:50%;',
      'background:rgba(255,255,255,0.22);border:1px solid rgba(255,255,255,0.38);',
      'pointer-events:none;transition:transform 0.04s linear;}',
      '.gp-preset{position:absolute;left:50%;transform:translateX(-50%);',
      'bottom:calc(env(safe-area-inset-bottom,0px) + 20px);pointer-events:auto;',
      'appearance:none;border:1px solid rgba(255,255,255,0.2);',
      'background:rgba(18,24,34,0.5);color:rgba(255,255,255,0.75);',
      'font-size:11px;padding:5px 12px;border-radius:999px;',
      'backdrop-filter:blur(6px);touch-action:manipulation;white-space:nowrap;}',
      '.gp-preset:active{background:rgba(76,141,255,0.6);color:#fff;}',
      '.gp-toggle{position:absolute;top:calc(env(safe-area-inset-top,0px) + 8px);',
      'right:44px;z-index:10;height:28px;padding:0 11px;border-radius:14px;border:0;',
      'background:rgba(0,0,0,0.3);color:rgba(255,255,255,0.55);font-size:11px;',
      'line-height:28px;touch-action:manipulation;white-space:nowrap;',
      '-webkit-tap-highlight-color:transparent;}',
      '.gp-toggle[data-on="1"]{background:rgba(76,141,255,0.55);color:#fff;}',
      '.gp-toggle:active{background:rgba(0,0,0,0.55);color:#fff;}'
    ].join('\n');

    var el = document.createElement('style');
    el.textContent = css;
    document.head.appendChild(el);
  }

  /* ================= 键盘事件 ================= */
  function dispatchKey(type, def) {
    var iframe = document.querySelector('#frameHost iframe');
    if (!iframe) return;

    var win;
    var doc;
    try {
      win = iframe.contentWindow;
      doc = iframe.contentDocument;
    } catch (e) {
      return;
    }
    if (!win || !doc) return;

    var target = doc.body || doc.documentElement;
    if (!target) return;

    var event;
    try {
      event = new win.KeyboardEvent(type, {
        key: def.key,
        code: def.code,
        bubbles: true,
        cancelable: true
      });
    } catch (e) {
      return;
    }

    try {
      Object.defineProperty(event, 'keyCode', { get: function () { return def.keyCode; } });
      Object.defineProperty(event, 'which', { get: function () { return def.keyCode; } });
      Object.defineProperty(event, 'charCode', { get: function () { return 0; } });
    } catch (e) {}

    target.dispatchEvent(event);
  }

  function press(def) {
    if (!def || def.down) return;
    def.down = true;
    dispatchKey('keydown', def);
  }

  function releaseKey(def) {
    if (!def || !def.down) return;
    def.down = false;
    dispatchKey('keyup', def);
  }

  function releaseAll() {
    for (var i = 0; i < activeDefs.length; i++) {
      if (activeDefs[i].down) {
        activeDefs[i].down = false;
        dispatchKey('keyup', activeDefs[i]);
      }
    }
  }

  function applyDir(preset, keys) {
    var names = ['up', 'down', 'left', 'right'];
    for (var i = 0; i < names.length; i++) {
      var def = preset.dir[names[i]];
      if (keys[names[i]]) press(def);
      else releaseKey(def);
    }
  }

  /** 给自写游戏用的模拟量 */
  function pushStick(nx, ny) {
    var iframe = document.querySelector('#frameHost iframe');
    if (!iframe) return;
    try {
      var win = iframe.contentWindow;
      if (!win) return;
      win.__HR_STICK__ = {
        x: Math.round(nx * 100) / 100,
        y: Math.round(ny * 100) / 100,
        active: !(nx === 0 && ny === 0)
      };
    } catch (e) {}
  }

  /* ================= 按键 ================= */
  function makeKey(label, def, extraClass) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'gp-key' + (extraClass ? ' ' + extraClass : '');
    btn.textContent = label;
    btn.setAttribute('aria-label', label);

    if (activeDefs.indexOf(def) === -1) activeDefs.push(def);

    var pointerId = null;

    btn.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      e.stopPropagation();
      pointerId = e.pointerId;
      try { btn.setPointerCapture(e.pointerId); } catch (err) {}
      btn.classList.add('gp-active');
      press(def);
    });

    function up(e) {
      if (pointerId === null) return;
      if (e && e.pointerId !== undefined && e.pointerId !== pointerId) return;
      pointerId = null;
      btn.classList.remove('gp-active');
      releaseKey(def);
    }

    btn.addEventListener('pointerup', up);
    btn.addEventListener('pointercancel', up);
    btn.addEventListener('lostpointercapture', up);

    return btn;
  }

  function buildDpad(preset) {
    var pad = document.createElement('div');
    pad.className = 'gp-pad';
    pad.appendChild(makeKey('▲', preset.dir.up, 'gp-up'));
    pad.appendChild(makeKey('◀', preset.dir.left, 'gp-left'));
    pad.appendChild(makeKey('▶', preset.dir.right, 'gp-right'));
    pad.appendChild(makeKey('▼', preset.dir.down, 'gp-down'));
    return pad;
  }

  function buildStick(preset) {
    var base = document.createElement('div');
    base.className = 'gp-stick';

    var knob = document.createElement('div');
    knob.className = 'gp-stick-knob';
    base.appendChild(knob);

    var names = ['up', 'down', 'left', 'right'];
    for (var i = 0; i < names.length; i++) {
      var def = preset.dir[names[i]];
      if (activeDefs.indexOf(def) === -1) activeDefs.push(def);
    }

    var pointerId = null;
    var centerX = 0;
    var centerY = 0;
    var maxDist = 1;

    function onMove(e) {
      if (pointerId === null || e.pointerId !== pointerId) return;
      e.preventDefault();

      var dx = e.clientX - centerX;
      var dy = e.clientY - centerY;
      var dist = Math.sqrt(dx * dx + dy * dy);

      if (dist > maxDist) {
        dx = dx / dist * maxDist;
        dy = dy / dist * maxDist;
      }

      knob.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';

      var nx = dx / maxDist;
      var ny = dy / maxDist;
      var t = 0.36;

      applyDir(preset, {
        up: ny < -t,
        down: ny > t,
        left: nx < -t,
        right: nx > t
      });
      pushStick(nx, ny);
    }

    function onUp(e) {
      if (pointerId === null) return;
      if (e && e.pointerId !== undefined && e.pointerId !== pointerId) return;
      pointerId = null;
      knob.style.transform = 'translate(0px,0px)';
      applyDir(preset, { up: false, down: false, left: false, right: false });
      pushStick(0, 0);
    }

    base.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      e.stopPropagation();
      var rect = base.getBoundingClientRect();
      centerX = rect.left + rect.width / 2;
      centerY = rect.top + rect.height / 2;
      maxDist = rect.width * 0.31;
      pointerId = e.pointerId;
      try { base.setPointerCapture(e.pointerId); } catch (err) {}
      onMove(e);
    });

    base.addEventListener('pointermove', onMove);
    base.addEventListener('pointerup', onUp);
    base.addEventListener('pointercancel', onUp);
    base.addEventListener('lostpointercapture', onUp);

    return base;
  }

  /* ================= 构建 ================= */
  function buildPad() {
    if (!root) return;

    releaseAll();
    activeDefs = [];
    root.textContent = '';

    var preset = PRESETS[presetIndex];

    var left = document.createElement('div');
    left.className = 'gp-left-zone';
    left.appendChild(preset.mode === 'stick' ? buildStick(preset) : buildDpad(preset));

    var actions = document.createElement('div');
    actions.className = 'gp-actions';
    actions.appendChild(makeKey('B', preset.b, 'gp-b'));
    actions.appendChild(makeKey('A', preset.a, 'gp-a'));

    var presetBtn = document.createElement('button');
    presetBtn.type = 'button';
    presetBtn.className = 'gp-preset';
    presetBtn.textContent = preset.short;
    presetBtn.addEventListener('pointerdown', function (e) {
      e.preventDefault();
    });
    presetBtn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      releaseAll();
      applyDir(preset, { up: false, down: false, left: false, right: false });
      presetIndex = (presetIndex + 1) % PRESETS.length;
      try {
        localStorage.setItem(PREF_PRESET, String(presetIndex));
      } catch (err) {}
      buildPad();
      updateVisibility();
    });

    root.appendChild(left);
    root.appendChild(actions);
    root.appendChild(presetBtn);
  }

  /* ================= 显示逻辑 ================= */
  function updateToggleLabel() {
    if (!toggleBtn) return;
    toggleBtn.textContent = enabled ? '手柄 开' : '手柄 关';
    toggleBtn.setAttribute('data-on', enabled ? '1' : '0');
  }

  function updateVisibility() {
    var immersive = pane.classList.contains('immersive');

    if (immersive && !wasImmersive) loadPref();
    wasImmersive = immersive;

    if (root) {
      root.style.display = immersive && enabled ? 'flex' : 'none';
    }
    if (toggleBtn) {
      toggleBtn.style.display = immersive ? 'block' : 'none';
      updateToggleLabel();
    }
    if (!immersive || !enabled) releaseAll();
  }

  function toggle() {
    enabled = !enabled;
    savePref();
    updateVisibility();
  }

  /* ================= 初始化 ================= */
  function init() {
    injectStyle();

    root = document.createElement('div');
    root.className = 'gp-root';
    root.style.display = 'none';
    pane.appendChild(root);
    buildPad();

    toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'gp-toggle';
    toggleBtn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      toggle();
    });
    toggleBtn.style.display = 'none';
    pane.appendChild(toggleBtn);

    var obs = new MutationObserver(updateVisibility);
    obs.observe(pane, { attributes: true, attributeFilter: ['class'] });

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') releaseAll();
    });

    window.addEventListener('blur', releaseAll);

    updateVisibility();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
