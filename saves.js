/* ============================================================
   存档系统（独立挂载，不修改 app.js）
   协议：游戏里定义 window.__SAVE__ / window.__LOAD__
   ============================================================ */

(function () {
  'use strict';

  var KEY_PREFIX = 'html-runtime:save:';
  var SLOTS = [1, 2, 3];
  var MAX_BYTES = 512 * 1024;

  var pane = document.getElementById('previewPane');
  if (!pane) return;

  var btn = null;
  var sheet = null;
  var statusEl = null;
  var bodyEl = null;

  function $(id) { return document.getElementById(id); }

  function projectId() {
    try {
      return localStorage.getItem('html-runtime:last-project') || 'default';
    } catch (e) {
      return 'default';
    }
  }

  function slotKey(slot) {
    return KEY_PREFIX + projectId() + ':' + slot;
  }

  function getWin() {
    var iframe = document.querySelector('#frameHost iframe');
    if (!iframe) return null;
    try {
      return iframe.contentWindow;
    } catch (e) {
      return null;
    }
  }

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

  function pad(n) { return n < 10 ? '0' + n : String(n); }

  function formatTime(ts) {
    var d = new Date(ts);
    return (d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
      pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  /* ================= 样式 ================= */
  function injectStyle() {
    var css = [
      '.sv-btn{position:absolute;top:calc(env(safe-area-inset-top,0px) + 8px);',
      'right:132px;z-index:10;width:28px;height:28px;border-radius:50%;border:0;',
      'background:rgba(0,0,0,0.22);color:rgba(255,255,255,0.45);font-size:12px;',
      'line-height:1;touch-action:manipulation;white-space:nowrap;',
      '-webkit-tap-highlight-color:transparent;}',
      '.sv-btn:active{background:rgba(0,0,0,0.55);color:#fff;}',
      '.sv-status{padding:10px 18px 4px;font-size:11px;color:#8b98a9;}',
      '.sv-status[data-ok="1"]{color:#3fb950;}',
      '.sv-status[data-ok="0"]{color:#f0b429;}',
      '.sv-body{padding:6px 14px 16px;display:flex;flex-direction:column;gap:10px;}',
      '.sv-slot{border:1px solid #232a36;background:#141a24;border-radius:10px;',
      'padding:10px 12px;}',
      '.sv-slot-head{display:flex;align-items:baseline;justify-content:space-between;',
      'margin-bottom:8px;}',
      '.sv-slot-title{font-size:13px;font-weight:600;color:#e6edf3;}',
      '.sv-slot-meta{font-size:11px;color:#8b98a9;}',
      '.sv-slot-actions{display:flex;gap:8px;}',
      '.sv-slot-actions button{flex:1;appearance:none;border:1px solid #232a36;',
      'background:#171d29;color:#e6edf3;font-size:12px;padding:7px 0;',
      'border-radius:8px;touch-action:manipulation;}',
      '.sv-slot-actions button:active{background:#222a38;}',
      '.sv-slot-actions button:disabled{opacity:0.35;}'
    ].join('\n');

    var el = document.createElement('style');
    el.textContent = css;
    document.head.appendChild(el);
  }

  /* ================= 存档核心 ================= */
  function writeSlot(slot, data) {
    var json;
    try {
      json = JSON.stringify({ at: Date.now(), data: data });
    } catch (e) {
      toast('存档数据无法序列化');
      return false;
    }

    if (json.length > MAX_BYTES) {
      toast('存档太大（超过 512KB）');
      return false;
    }

    try {
      localStorage.setItem(slotKey(slot), json);
    } catch (e) {
      toast('写入失败：本地存储空间不足');
      return false;
    }
    return true;
  }

  function doSave(slot) {
    var win = getWin();
    if (!win) {
      toast('游戏还没有运行');
      return;
    }

    if (typeof win.__SAVE__ !== 'function') {
      toast('这个游戏没有定义 __SAVE__，无法存档');
      return;
    }

    var result;
    try {
      result = win.__SAVE__();
    } catch (e) {
      toast('存档失败：' + (e && e.message ? e.message : '游戏内部出错'));
      return;
    }

    function finish(data) {
      if (data === undefined) {
        toast('游戏返回了空数据');
        return;
      }
      if (writeSlot(slot, data)) {
        refresh();
        toast('已保存到槽位 ' + slot);
      }
    }

    if (result && typeof result.then === 'function') {
      result.then(finish, function () {
        toast('存档失败：游戏返回的 Promise 被拒绝');
      });
    } else {
      finish(result);
    }
  }

  function doLoad(slot) {
    var raw = null;
    try {
      raw = localStorage.getItem(slotKey(slot));
    } catch (e) {}
    if (!raw) return;

    var parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      toast('存档已损坏');
      return;
    }

    var win = getWin();
    if (!win) {
      toast('游戏还没有运行');
      return;
    }

    if (typeof win.__LOAD__ !== 'function') {
      toast('这个游戏没有定义 __LOAD__，无法读档');
      return;
    }

    try {
      win.__LOAD__(parsed.data);
    } catch (e) {
      toast('读档失败：' + (e && e.message ? e.message : '游戏内部出错'));
      return;
    }

    close();
    toast('已读取槽位 ' + slot);
  }

  function doDelete(slot) {
    if (!window.confirm('删除槽位 ' + slot + ' 的存档？')) return;
    try {
      localStorage.removeItem(slotKey(slot));
    } catch (e) {}
    refresh();
    toast('已删除');
  }

  /* ================= 面板 ================= */
  function mkBtn(label, handler) {
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('click', function (e) {
      e.preventDefault();
      handler();
    });
    return b;
  }

  function refresh() {
    if (!bodyEl) return;

    bodyEl.textContent = '';

    var win = getWin();
    var supported = !!(win && typeof win.__SAVE__ === 'function');

    statusEl.textContent = supported
      ? '当前游戏支持存档'
      : '当前游戏没有定义 __SAVE__，不能保存进度';
    statusEl.setAttribute('data-ok', supported ? '1' : '0');

    SLOTS.forEach(function (slot) {
      var info = null;
      try {
        var raw = localStorage.getItem(slotKey(slot));
        if (raw) info = JSON.parse(raw);
      } catch (e) {
        info = null;
      }

      var card = document.createElement('div');
      card.className = 'sv-slot';

      var head = document.createElement('div');
      head.className = 'sv-slot-head';

      var title = document.createElement('span');
      title.className = 'sv-slot-title';
      title.textContent = '槽位 ' + slot;

      var meta = document.createElement('span');
      meta.className = 'sv-slot-meta';
      meta.textContent = info && info.at ? formatTime(info.at) : '空';

      head.appendChild(title);
      head.appendChild(meta);

      var row = document.createElement('div');
      row.className = 'sv-slot-actions';

      var saveBtn = mkBtn('保存', function () { doSave(slot); });
      var loadBtn = mkBtn('读取', function () { doLoad(slot); });
      var delBtn = mkBtn('删除', function () { doDelete(slot); });

      if (!info) {
        loadBtn.disabled = true;
        delBtn.disabled = true;
      }

      row.appendChild(saveBtn);
      row.appendChild(loadBtn);
      row.appendChild(delBtn);

      card.appendChild(head);
      card.appendChild(row);
      bodyEl.appendChild(card);
    });
  }

  function buildSheet() {
    sheet = document.createElement('div');
    sheet.className = 'sheet';
    sheet.hidden = true;

    var backdrop = document.createElement('div');
    backdrop.className = 'sheet-backdrop';
    backdrop.addEventListener('click', close);

    var panel = document.createElement('div');
    panel.className = 'sheet-panel compact';

    var head = document.createElement('div');
    head.className = 'sheet-head';

    var t = document.createElement('span');
    t.className = 'sheet-title';
    t.textContent = '存档';

    var closeBtn = document.createElement('button');
    closeBtn.className = 'link';
    closeBtn.textContent = '关闭';
    closeBtn.addEventListener('click', close);

    head.appendChild(t);
    head.appendChild(closeBtn);

    statusEl = document.createElement('div');
    statusEl.className = 'sv-status';

    bodyEl = document.createElement('div');
    bodyEl.className = 'sv-body';

    panel.appendChild(head);
    panel.appendChild(statusEl);
    panel.appendChild(bodyEl);
    sheet.appendChild(backdrop);
    sheet.appendChild(panel);
    document.body.appendChild(sheet);
  }

  function open() {
    if (!sheet) buildSheet();
    refresh();
    sheet.hidden = false;
  }

  function close() {
    if (sheet) sheet.hidden = true;
  }

  /* ================= 初始化 ================= */
  function updateVisibility() {
    if (!btn) return;
    btn.style.display = pane.classList.contains('immersive') ? 'block' : 'none';
  }

  function init() {
    injectStyle();

    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sv-btn';
    btn.textContent = '存';
    btn.setAttribute('aria-label', '存档');
    btn.style.display = 'none';
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      open();
    });
    pane.appendChild(btn);

    var obs = new MutationObserver(updateVisibility);
    obs.observe(pane, { attributes: true, attributeFilter: ['class'] });

    updateVisibility();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
