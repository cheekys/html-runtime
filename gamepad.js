/* ============================================================
   虚拟手柄（独立挂载，不修改 app.js）
   在游戏模式下向 iframe 派发键盘事件
   ============================================================ */

(function () {
  'use strict';

  var STORE_ON = 'html-runtime:pad-on';
  var STORE_PRESET = 'html-runtime:pad-preset';

  var pane = document.getElementById('previewPane');
  if (!pane) return;

  var root = null;
  var toggleBtn = null;
  var enabled = false;
  var presetIndex = 0;
  var activeDefs = [];
  var presetLabelEl = null;

  /* ================= 键位预设 ================= */
  function arrows() {
    return {
      up: { code: 'ArrowUp', key: 'ArrowUp', keyCode: 38 },
      down: { code: 'ArrowDown', key: 'ArrowDown', keyCode: 40 },
      left: { code: 'ArrowLeft', key: 'ArrowLeft', keyCode: 37 },
      right: { code: 'ArrowRight', key: 'ArrowRight', keyCode: 39 }
    };
  }

  var PRESETS = [
    {
      short: '方向键',
      dir: arrows(),
      a: { code: 'Space', key: ' ', keyCode: 32 },
      b: { code: 'Enter', key: 'Enter', keyCode: 13 }
    },
    {
      short: 'WASD',
      dir: {
        up: { code: 'KeyW', key: 'w', keyCode: 87 },
        down: { code: 'KeyS', key: 's', keyCode: 83 },
        left: { code: 'KeyA', key: 'a', keyCode: 65 },
        right: { code: 'KeyD', key: 'd', keyCode: 68 }
      },
      a: { code: 'KeyJ', key: 'j', keyCode: 74 },
      b: { code: 'KeyK', key: 'k', keyCode: 75 }
    },
    {
      short: '方向键 ZX',
      dir: arrows(),
      a: { code: 'KeyZ', key: 'z', keyCode: 90 },
      b: { code: 'KeyX', key: 'x', keyCode: 88 }
    }
  ];

  /* ================= 样式 ================= */
  function injectStyle() {
    var css = [
      '.gp-root{position:absolute;left:0;right:0;bottom:0;z-index:25;',
      'padding:0 14px calc(env(safe-area-inset-bottom,0px) + 16px);',
      'display:flex;align-items:flex-end;justify-content:space-between;',
      'pointer-events:none;user-select:none;-webkit-user-select:none;',
      '-webkit-touch-callout:none;}',
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
      '.gp-preset{position:absolute;left:50%;transform:translateX(-50%);',
      'bottom:calc(env(safe-area-inset-bottom,0px) + 20px);pointer-events:auto;',
      'appearance:none;border:1px solid rgba(255,255,255,0.2);',
      'background:rgba(18,24,34,0.45);color:rgba(255,255,255,0.7);',
      'font-size:11px;padding:5px 12px;border-radius:999px;',
      'backdrop-filter:blur(6px);touch-action:manipulation;white-space:nowrap;}',
      '.gp-preset:active{background:rgba(76,141,255,0.6);color:#fff;}',
      '.gp-toggle{position:absolute;top:calc(env(safe-area-inset-top,0px) + 8px);',
      'right:44px;z-index:10;width:28px;height:28px;border-radius:50%;border:0;',
      'background:rgba(0,0,0,0.22);color:rgba(255,255,255,0.45);font-size:12px;',
      'line-height:1;touch-action:manipulation;',
      '-webkit-tap-highlight-color:transparent;}',
      '.gp-toggle[data-on="1"]{background:rgba(76,141,255,0.45);',
      'color:rgba(255,255,255,0.9);}',
      '.gp-toggle:active{background:rgba(0,0,0,0.5);color:#fff;}'
    ].join('\n');

    var el = document.createElement('style');
    el.textContent = css;
    document.head.appendChild(el);
  }

  /* ================= 派发键盘事件 ================= */
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
      Object.defineProperty(event, 'keyCode', {
        get: function () { return def.keyCode; }
      });
      Object.defineProperty(event, 'which', {
        get: function () { return def.keyCode; }
      });
      Object.defineProperty(event, 'charCode', {
        get: function () { return 0; }
      });
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
      var def = activeDefs[i];
      if (def.down) {
        def.down = false;
        dispatchKey('keyup', def);
      }
    }
  }

  /* ================= 按键 ================= */
  function makeKey(label, def, extraClass) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'gp-key' + (extraClass ? ' ' + extraClass : '');
    btn.textContent = label;
    btn.setAttribute('aria-label', label);

    var pointerId = null;

    btn.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      e.stopPropagation();
      pointerId = e.pointerId;
      try {
        btn.setPointerCapture(e.pointerId);
      } catch (err) {}
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

    activeDefs.push(def);
    return btn;
  }

  /* ================= 构建 ================= */
  function buildPad() {
    if (!root) return;

    activeDefs = [];
    root.textContent = '';

    var preset = PRESETS[presetIndex];

    var pad = document.createElement('div');
    pad.className = 'gp-pad';
    pad.appendChild(makeKey('▲', preset.dir.up, 'gp-up'));
    pad.appendChild(makeKey('◀', preset.dir.left, 'gp-left'));
    pad.appendChild(makeKey('▶', preset.dir.right, 'gp-right'));
    pad.appendChild(makeKey('▼', preset.dir.down, 'gp-down'));

    var actions = document.createElement('div');
    actions.className = 'gp-actions';
    actions.appendChild(makeKey('B', preset.b, 'gp-b'));
    actions.appendChild(makeKey('A', preset.a, 'gp-a'));

    var presetBtn = document.createElement('button');
    presetBtn.type = 'button';
    presetBtn.className = 'gp-preset';
    presetBtn.textContent = preset.short;
    presetBtn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      releaseAll();
      presetIndex = (presetIndex + 1) % PRESETS.length;
      try {
        localStorage.setItem(STORE_PRESET, String(presetIndex));
      } catch (err) {}
      buildPad();
      updateVisibility();
    });

    root.appendChild(pad);
    root.appendChild(actions);
    root.appendChild(presetBtn);
    presetLabelEl = presetBtn;
  }

  /* ================= 显示逻辑 ================= */
  function isImmersive() {
    return pane.classList.contains('immersive');
  }

  function updateVisibility() {
    if (!root) return;

    var immersive = isImmersive();
    root.style.display = immersive && enabled ? 'flex' : 'none';

    if (toggleBtn) {
      toggleBtn.style.display = immersive ? 'block' : 'none';
      toggleBtn.setAttribute('data-on', enabled ? '1' : '0');
    }

    if (!immersive || !enabled) releaseAll();
  }

  function toggle() {
    enabled = !enabled;
    try {
      localStorage.setItem(STORE_ON, enabled ? '1' : '0');
    } catch (e) {}
    updateVisibility();
  }

  /* ================= 初始化 ================= */
  function init() {
    injectStyle();

    try {
      enabled = localStorage.getItem(STORE_ON) === '1';
      var saved = parseInt(localStorage.getItem(STORE_PRESET) || '0', 10);
      if (!isNaN(saved) && saved >= 0 && saved < PRESETS.length) presetIndex = saved;
    } catch (e) {}

    root = document.createElement('div');
    root.className = 'gp-root';
    root.style.display = 'none';
    pane.appendChild(root);
    buildPad();

    toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'gp-toggle';
    toggleBtn.textContent = '键';
    toggleBtn.setAttribute('aria-label', '显示虚拟手柄');
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
