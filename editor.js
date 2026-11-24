/* ============================================================
   编辑器增强（独立挂载）：语法高亮 + 自动缩进 + 查找替换
   ============================================================ */

(function () {
  'use strict';

  var editor = document.getElementById('editor');
  var area = document.querySelector('.editor-area');
  if (!editor || !area) return;

  var MAX_HIGHLIGHT = 80000;
  var HIGHLIGHT_DELAY = 90;

  var wrap = null;
  var pre = null;
  var codeEl = null;
  var composing = false;
  var highlightTimer = null;
  var highlightEnabled = true;
  var syncRaf = 0;

  /* ================= 样式 ================= */
  function injectStyle() {
    var css = [
      '.hr-editor-wrap{position:relative;flex:1 1 auto;min-height:0;}',
      '.hr-editor-wrap > #editor{position:absolute;left:0;top:0;width:100%;height:100%;',
      'background:transparent;color:transparent;caret-color:#e6edf3;',
      'scrollbar-width:none;-webkit-appearance:none;border-radius:0;}',
      '.hr-editor-wrap > #editor::-webkit-scrollbar{display:none;}',
      '.hr-editor-wrap > #editor::selection{background:rgba(76,141,255,0.30);}',
      '.hr-hl{position:absolute;left:0;top:0;width:100%;height:100%;margin:0;',
      'border:0;overflow:hidden;pointer-events:none;',
      'font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;',
      'font-size:16px;line-height:24px;padding:12px;tab-size:2;color:#e6edf3;}',
      '.hr-hl code{font:inherit;letter-spacing:inherit;word-spacing:inherit;',
      'tab-size:inherit;white-space:inherit;}',
      '.hr-composing > #editor{color:#e6edf3;}',
      '.hr-composing .hr-hl{visibility:hidden;}',
      '.hr-plain > #editor{color:#e6edf3;}',
      '.hr-plain .hr-hl{display:none;}',
      '.tok-comment{color:#5b6676;font-style:italic;}',
      '.tok-string{color:#a5e075;}',
      '.tok-number{color:#f78c6c;}',
      '.tok-keyword{color:#c792ea;}',
      '.tok-tag{color:#4ec9b0;}',
      '.tok-attr{color:#82aaff;}',
      '.tok-prop{color:#82aaff;}',
      '.tok-punct{color:#6d7a8a;}',
      '.tok-value{color:#89ddff;}',
      'mark.hr-mark{background:rgba(240,180,41,0.38);color:inherit;',
      'border-radius:2px;box-shadow:0 0 0 1px rgba(240,180,41,0.5);}',
      '.hr-find{flex:0 0 auto;display:flex;flex-direction:column;gap:6px;padding:8px 10px;',
      'background:#0e131b;border-bottom:1px solid #232a36;}',
      '.hr-find-row{display:flex;align-items:center;gap:6px;}',
      '.hr-find input{flex:1;min-width:0;appearance:none;border:1px solid #232a36;',
      'background:#11151d;color:#e6edf3;font-size:16px;padding:6px 8px;',
      'border-radius:7px;outline:none;}',
      '.hr-find button{appearance:none;border:1px solid #232a36;background:#171d29;',
      'color:#e6edf3;font-size:13px;padding:6px 10px;border-radius:7px;',
      'touch-action:manipulation;}',
      '.hr-find button:active{background:#222a38;}',
      '.hr-find-count{font-size:11px;color:#8b98a9;min-width:74px;text-align:center;',
      'white-space:nowrap;}'
    ].join('\n');

    var el = document.createElement('style');
    el.textContent = css;
    document.head.appendChild(el);
  }

  /* ================= 结构 ================= */
  function buildDom() {
    wrap = document.createElement('div');
    wrap.className = 'hr-editor-wrap';

    pre = document.createElement('pre');
    pre.className = 'hr-hl';
    pre.setAttribute('aria-hidden', 'true');
    codeEl = document.createElement('code');
    pre.appendChild(codeEl);

    wrap.appendChild(pre);

    area.insertBefore(wrap, editor);
    wrap.appendChild(editor);

    var obs = new MutationObserver(function () {
      wrap.hidden = !!editor.hidden;
    });
    obs.observe(editor, { attributes: true, attributeFilter: ['hidden'] });
    wrap.hidden = !!editor.hidden;
  }

  /* ================= 度量校准 ================= */
  var METRIC_PROPS = [
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant', 'fontStretch',
    'letterSpacing', 'wordSpacing', 'tabSize', 'textIndent', 'textTransform',
    'whiteSpace', 'overflowWrap', 'wordBreak', 'textAlign',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'boxSizing'
  ];

  function measureLineHeight(cs) {
    var probe = document.createElement('textarea');
    probe.style.position = 'absolute';
    probe.style.left = '-9999px';
    probe.style.top = '0';
    probe.style.width = '200px';
    probe.style.height = '200px';
    probe.style.overflow = 'hidden';
    probe.style.resize = 'none';

    for (var i = 0; i < METRIC_PROPS.length; i++) {
      var p = METRIC_PROPS[i];
      if (cs[p]) probe.style[p] = cs[p];
    }

    probe.value = 'x\nx\nx\nx\nx\nx\nx\nx\nx\nx';

    document.body.appendChild(probe);

    var pcs = getComputedStyle(probe);
    var padTop = parseFloat(pcs.paddingTop) || 0;
    var padBottom = parseFloat(pcs.paddingBottom) || 0;
    var inner = probe.scrollHeight - padTop - padBottom;

    document.body.removeChild(probe);

    return inner > 0 ? inner / 10 : 0;
  }

  function calibrate() {
    if (!pre || !editor) return;

    var cs = getComputedStyle(editor);
    var i;

    for (i = 0; i < METRIC_PROPS.length; i++) {
      var p = METRIC_PROPS[i];
      if (cs[p]) pre.style[p] = cs[p];
    }

    var lh = measureLineHeight(cs);
    if (lh > 0) {
      var px = Math.round(lh * 100) / 100 + 'px';
      pre.style.lineHeight = px;
      editor.style.lineHeight = px;
    }

    syncScroll();
  }

  /* ================= 滚动 ================= */
  function syncScroll() {
    if (!pre || pre.hidden) return;
    if (pre.scrollTop !== editor.scrollTop) pre.scrollTop = editor.scrollTop;
    if (pre.scrollLeft !== editor.scrollLeft) pre.scrollLeft = editor.scrollLeft;
  }

  function startScrollLoop() {
    if (syncRaf) return;
    var tick = function () {
      syncScroll();
      syncRaf = requestAnimationFrame(tick);
    };
    syncRaf = requestAnimationFrame(tick);
  }

  function stopScrollLoop() {
    if (syncRaf) cancelAnimationFrame(syncRaf);
    syncRaf = 0;
  }

  /* ================= 高亮 ================= */
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  var RE_JS = /(?<comment>\/\*[\s\S]*?\*\/|\/\/[^\n]*)|(?<string>"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|(?<number>\b\d+(?:\.\d+)?\b)|(?<keyword>\b(?:const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|default|new|delete|typeof|instanceof|in|of|try|catch|finally|throw|class|extends|super|this|await|async|yield|import|export|from|as|null|undefined|true|false|void)\b)/g;

  var RE_HTML = /(?<comment><!--[\s\S]*?-->)|(?<tag><\/?[a-zA-Z][\w:-]*)|(?<attr>[a-zA-Z_:][\w:.-]*(?=\s*=))|(?<string>"[^"]*"|'[^']*')|(?<punct>[<>/=])/g;

  var RE_CSS = /(?<comment>\/\*[\s\S]*?\*\/)|(?<string>"[^"]*"|'[^']*')|(?<at>@[a-zA-Z-]+)|(?<prop>[a-zA-Z-]+(?=\s*:))|(?<number>#[0-9a-fA-F]{3,8}\b|\b\d*\.?\d+(?:px|em|rem|%|vh|vw|vmin|vmax|s|ms|deg|fr|pt)?\b)|(?<value>\b(?:important|none|auto|inherit|initial|unset|flex|grid|block|inline|absolute|relative|fixed|sticky)\b)/g;

  function languageOf(path) {
    var m = /\.([a-z0-9]+)$/i.exec(path || '');
    var ext = m ? m[1].toLowerCase() : '';
    if (ext === 'html' || ext === 'htm') return 'html';
    if (ext === 'css') return 'css';
    if (ext === 'js' || ext === 'mjs' || ext === 'json') return 'js';
    return 'plain';
  }

  function currentPath() {
    var tab = document.querySelector('.filetabs .tab.active');
    return tab ? tab.getAttribute('data-path') : '';
  }

  function highlightToHtml(text, lang) {
    var re = lang === 'html' ? RE_HTML : (lang === 'css' ? RE_CSS : RE_JS);
    re.lastIndex = 0;

    var out = '';
    var last = 0;
    var m;

    while ((m = re.exec(text)) !== null) {
      if (m.index > last) out += escapeHtml(text.slice(last, m.index));

      var g = m.groups || {};
      var cls = '';
      if (g.comment) cls = 'tok-comment';
      else if (g.string) cls = 'tok-string';
      else if (g.number) cls = 'tok-number';
      else if (g.keyword) cls = 'tok-keyword';
      else if (g.tag) cls = 'tok-tag';
      else if (g.attr) cls = 'tok-attr';
      else if (g.prop) cls = 'tok-prop';
      else if (g.at) cls = 'tok-keyword';
      else if (g.punct) cls = 'tok-punct';
      else if (g.value) cls = 'tok-value';

      out += cls
        ? '<span class="' + cls + '">' + escapeHtml(m[0]) + '</span>'
        : escapeHtml(m[0]);

      last = re.lastIndex;
      if (m[0].length === 0) re.lastIndex++;
    }

    out += escapeHtml(text.slice(last));
    return out;
  }

  function syncHighlight() {
    if (!pre || !codeEl || !wrap) return;

    var text = editor.value || '';
    var lang = languageOf(currentPath());

    if (!highlightEnabled || text.length > MAX_HIGHLIGHT || lang === 'plain') {
      wrap.classList.add('hr-plain');
      pre.hidden = true;
      return;
    }

    wrap.classList.remove('hr-plain');
    pre.hidden = false;
    codeEl.innerHTML = highlightToHtml(text, lang) + '\n';
    syncScroll();
  }

  function scheduleHighlight() {
    clearTimeout(highlightTimer);
    highlightTimer = setTimeout(syncHighlight, HIGHLIGHT_DELAY);
  }

  function hookValue() {
    var proto = window.HTMLTextAreaElement && HTMLTextAreaElement.prototype;
    if (!proto) return;
    var desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (!desc || !desc.get || !desc.set) return;

    Object.defineProperty(editor, 'value', {
      configurable: true,
      enumerable: desc.enumerable,
      get: function () {
        return desc.get.call(editor);
      },
      set: function (v) {
        desc.set.call(editor, v);
        scheduleHighlight();
      }
    });
  }

  /* ================= 精确位置测量 ================= */
  function locate(offset) {
    if (!pre) return null;

    var walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT, null);
    var acc = 0;
    var node;

    while ((node = walker.nextNode())) {
      var len = node.nodeValue ? node.nodeValue.length : 0;
      if (acc + len >= offset) {
        return { node: node, offset: Math.max(0, offset - acc) };
      }
      acc += len;
    }
    return null;
  }

  /** 把某个字符偏移滚到可视区（center=true 时居中到 1/3 处） */
  function revealOffset(offset, center) {
    var y = null;

    if (pre && !pre.hidden) {
      var pos = locate(offset);
      if (pos) {
        var range = document.createRange();
        range.setStart(pos.node, pos.offset);
        range.setEnd(pos.node, pos.offset);

        var rect = range.getBoundingClientRect();
        var preRect = pre.getBoundingClientRect();

        if (rect && (rect.height || rect.top)) {
          y = rect.top - preRect.top + editor.scrollTop;
        }
      }
    }

    if (y === null) {
      var before = editor.value.slice(0, offset);
      var lineIndex = before.split('\n').length - 1;
      var lh = parseFloat(getComputedStyle(editor).lineHeight) || 24;
      y = lineIndex * lh;
    }

    var h = editor.clientHeight;
    var top = editor.scrollTop;

    if (center) {
      editor.scrollTop = Math.max(0, y - h / 3);
    } else if (y < top + 8 || y > top + h - 48) {
      editor.scrollTop = Math.max(0, y - h / 3);
    }

    syncScroll();
  }

  function revealCaret() {
    revealOffset(editor.selectionStart, false);
  }

  /* ================= 命中标记 ================= */
  function clearMarks() {
    if (!pre) return;
    var marks = pre.querySelectorAll('mark.hr-mark');
    for (var i = 0; i < marks.length; i++) {
      var mark = marks[i];
      var parent = mark.parentNode;
      if (!parent) continue;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      parent.removeChild(mark);
    }
    if (pre.normalize) pre.normalize();
  }

  function markMatch(start, end) {
    if (!pre || pre.hidden) return;
    clearMarks();

    var a = locate(start);
    var b = locate(end);
    if (!a || !b) return;

    var range = document.createRange();
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset);

    try {
      var frag = range.extractContents();
      var mark = document.createElement('mark');
      mark.className = 'hr-mark';
      mark.appendChild(frag);
      range.insertNode(mark);
    } catch (e) {}
  }

  /* ================= 事件 ================= */
  function bindEvents() {
    editor.addEventListener('focus', startScrollLoop);
    editor.addEventListener('blur', stopScrollLoop);

    editor.addEventListener('input', function (e) {
      if (e.isComposing || composing) return;
      scheduleHighlight();
      syncScroll();
    });

    editor.addEventListener('compositionstart', function () {
      composing = true;
      if (wrap) wrap.classList.add('hr-composing');
    });

    editor.addEventListener('compositionend', function () {
      composing = false;
      if (wrap) wrap.classList.remove('hr-composing');
      scheduleHighlight();
    });

    editor.addEventListener('scroll', syncScroll);

    editor.addEventListener('keydown', function (e) {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key !== 'Enter') return;
      if (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;

      var value = editor.value;
      var start = editor.selectionStart;
      var end = editor.selectionEnd;

      var lineStart = value.lastIndexOf('\n', start - 1) + 1;
      var line = value.slice(lineStart, start);
      var indentMatch = /^[ \t]*/.exec(line);
      var indent = indentMatch ? indentMatch[0] : '';

      var before = value.charAt(start - 1);
      var after = value.charAt(end);
      var extra = '';

      if (before === '{' || before === '[' || before === '(') extra = '  ';

      var insertion;
      var caret;

      if (extra && (after === '}' || after === ']' || after === ')')) {
        insertion = '\n' + indent + extra + '\n' + indent;
        caret = start + 1 + indent.length + extra.length;
      } else {
        insertion = '\n' + indent + extra;
        caret = start + insertion.length;
      }

      e.preventDefault();
      editor.value = value.slice(0, start) + insertion + value.slice(end);
      editor.setSelectionRange(caret, caret);
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      syncHighlight();
      revealCaret();
    });

    window.addEventListener('resize', function () {
      calibrate();
      scheduleHighlight();
    });

    window.addEventListener('orientationchange', function () {
      setTimeout(function () {
        calibrate();
        scheduleHighlight();
      }, 200);
    });
  }

  /* ================= 查找替换 ================= */
  var findBar = null;
  var findInput = null;
  var replaceInput = null;
  var countEl = null;
  var matches = [];
  var matchIndex = -1;

  function mkBtn(label, handler) {
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;

    // 防止点按钮时把焦点从输入框抢走（否则键盘会收起）
    b.addEventListener('pointerdown', function (e) {
      e.preventDefault();
    });
    b.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      handler();
    });
    return b;
  }

  function lineAt(offset) {
    var head = editor.value.slice(0, offset);
    var count = 1;
    for (var i = 0; i < head.length; i++) {
      if (head.charCodeAt(i) === 10) count++;
    }
    return count;
  }

  function updateCount() {
    if (!countEl) return;
    if (!matches.length) {
      countEl.textContent = '0/0';
      return;
    }
    countEl.textContent =
      (matchIndex + 1) + '/' + matches.length + ' · L' + lineAt(matches[matchIndex]);
  }

  function refreshMatches() {
    clearMarks();

    matches = [];
    matchIndex = -1;

    var q = findInput.value;
    if (q) {
      var hay = editor.value.toLowerCase();
      var needle = q.toLowerCase();
      var i = hay.indexOf(needle);
      var guard = 0;

      while (i !== -1 && guard < 2000) {
        matches.push(i);
        i = hay.indexOf(needle, i + needle.length);
        guard++;
      }

      if (matches.length) {
        var caret = editor.selectionStart;
        matchIndex = 0;
        for (var k = 0; k < matches.length; k++) {
          if (matches[k] >= caret) {
            matchIndex = k;
            break;
          }
        }
      }
    }
    updateCount();
  }

  /** 跳到当前位置：不抢焦点、不设选区，只滚动 + 高亮 */
  function step(dir) {
    if (!matches.length) return;

    matchIndex = (matchIndex + dir + matches.length) % matches.length;
    var start = matches[matchIndex];
    var len = findInput.value.length || 1;

    syncHighlight();
    revealOffset(start, true);
    markMatch(start, start + len);
    updateCount();
  }

  function replaceOne() {
    if (!matches.length) return;

    var len = findInput.value.length;
    var start = matches[matchIndex];
    var text = editor.value;
    var rep = replaceInput.value;

    editor.value = text.slice(0, start) + rep + text.slice(start + len);
    editor.dispatchEvent(new Event('input', { bubbles: true }));

    refreshMatches();
    syncHighlight();

    if (matches.length) {
      if (matchIndex >= matches.length) matchIndex = 0;
      var s = matches[matchIndex];
      revealOffset(s, true);
      markMatch(s, s + (findInput.value.length || 1));
      updateCount();
    }
  }

  function replaceAll() {
    var q = findInput.value;
    if (!q) return;

    var re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    var before = editor.value;
    var rep = replaceInput.value;
    var after = before.replace(re, function () {
      return rep;
    });

    if (after === before) return;

    editor.value = after;
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    refreshMatches();
    syncHighlight();
  }

  function buildFindBar() {
    findBar = document.createElement('div');
    findBar.className = 'hr-find';
    findBar.hidden = true;

    var row1 = document.createElement('div');
    row1.className = 'hr-find-row';

    findInput = document.createElement('input');
    findInput.type = 'search';
    findInput.placeholder = '查找';
    findInput.setAttribute('autocapitalize', 'off');
    findInput.setAttribute('autocorrect', 'off');
    findInput.setAttribute('spellcheck', 'false');

    countEl = document.createElement('span');
    countEl.className = 'hr-find-count';
    countEl.textContent = '0/0';

    row1.appendChild(findInput);
    row1.appendChild(countEl);
    row1.appendChild(mkBtn('↑', function () { step(-1); }));
    row1.appendChild(mkBtn('↓', function () { step(1); }));
    row1.appendChild(mkBtn('×', closeFind));

    var row2 = document.createElement('div');
    row2.className = 'hr-find-row';

    replaceInput = document.createElement('input');
    replaceInput.type = 'text';
    replaceInput.placeholder = '替换为';
    replaceInput.setAttribute('autocapitalize', 'off');
    replaceInput.setAttribute('autocorrect', 'off');
    replaceInput.setAttribute('spellcheck', 'false');

    row2.appendChild(replaceInput);
    row2.appendChild(mkBtn('替换', replaceOne));
    row2.appendChild(mkBtn('全部', replaceAll));

    findBar.appendChild(row1);
    findBar.appendChild(row2);

    area.insertBefore(findBar, wrap);

    findInput.addEventListener('input', refreshMatches);
    findInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        step(e.shiftKey ? -1 : 1);
      }
    });
  }

  function openFind() {
    if (!findBar) buildFindBar();
    findBar.hidden = false;

    var sel = editor.value.slice(editor.selectionStart, editor.selectionEnd);
    if (sel && sel.indexOf('\n') === -1) findInput.value = sel;

    refreshMatches();
    findInput.focus();
  }

  function closeFind() {
    if (findBar) findBar.hidden = true;
    clearMarks();
  }

  /* ================= 挂载 ================= */
  function addFindButton() {
    var tabbar = document.querySelector('.tabbar');
    if (!tabbar || document.getElementById('hrFindBtn')) return;

    var btn = document.createElement('button');
    btn.className = 'addfile';
    btn.id = 'hrFindBtn';
    btn.textContent = '找';
    btn.setAttribute('aria-label', '查找替换（长按开关高亮）');

    var longPressed = false;
    var pressTimer = null;

    btn.addEventListener('touchstart', function () {
      pressTimer = setTimeout(function () {
        pressTimer = null;
        longPressed = true;
        toggleHighlight();
      }, 650);
    }, { passive: true });

    ['touchend', 'touchmove', 'touchcancel'].forEach(function (ev) {
      btn.addEventListener(ev, function () {
        if (pressTimer) {
          clearTimeout(pressTimer);
          pressTimer = null;
        }
      }, { passive: true });
    });

    btn.addEventListener('click', function () {
      if (longPressed) {
        longPressed = false;
        return;
      }
      if (findBar && !findBar.hidden) closeFind();
      else openFind();
    });

    var anchor = document.getElementById('hrFileBtn') || document.getElementById('saveHint');
    if (anchor) tabbar.insertBefore(btn, anchor);
    else tabbar.appendChild(btn);
  }

  function toggleHighlight() {
    highlightEnabled = !highlightEnabled;
    syncHighlight();
    var el = document.getElementById('toast');
    if (el) {
      el.textContent = highlightEnabled ? '语法高亮已开启' : '语法高亮已关闭';
      el.classList.add('show');
      clearTimeout(toggleHighlight._t);
      toggleHighlight._t = setTimeout(function () {
        el.classList.remove('show');
      }, 1600);
    }
  }

  function init() {
    injectStyle();
    buildDom();
    calibrate();
    hookValue();
    bindEvents();
    addFindButton();
    syncHighlight();
    setTimeout(calibrate, 300);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
