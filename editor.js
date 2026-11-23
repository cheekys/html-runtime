/* ============================================================
   编辑器增强（独立挂载）：语法高亮 + 自动缩进 + 查找替换
   不修改 app.js
   ============================================================ */

(function () {
  'use strict';

  var editor = document.getElementById('editor');
  var area = document.querySelector('.editor-area');
  if (!editor || !area) return;

  var MAX_HIGHLIGHT = 80000;   // 超过这个字符数不做高亮（避免卡顿）
  var HIGHLIGHT_DELAY = 90;

  var wrap = null;
  var pre = null;
  var codeEl = null;
  var composing = false;
  var highlightTimer = null;

  /* ================= 样式 ================= */
  function injectStyle() {
    var css = [
      '.hr-editor-wrap{position:relative;flex:1 1 auto;min-height:0;}',
      '.hr-editor-wrap > #editor{position:absolute;left:0;top:0;width:100%;height:100%;',
      'background:transparent;color:transparent;caret-color:#e6edf3;scrollbar-width:none;}',
      '.hr-editor-wrap > #editor::-webkit-scrollbar{display:none;}',
      '.hr-editor-wrap > #editor::selection{background:rgba(76,141,255,0.30);}',
      '.hr-hl{position:absolute;left:0;top:0;width:100%;height:100%;margin:0;padding:12px;',
      'border:0;overflow:hidden;pointer-events:none;white-space:pre-wrap;',
      'overflow-wrap:break-word;word-break:normal;font-size:16px;line-height:1.5;tab-size:2;',
      'font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#e6edf3;}',
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
      '.hr-find-count{font-size:11px;color:#8b98a9;min-width:46px;text-align:center;}'
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

    // 高亮层先进，textarea 后进 —— 后者叠在上面
    wrap.appendChild(pre);

    area.insertBefore(wrap, editor);
    wrap.appendChild(editor);

    // textarea 被隐藏（切到二进制文件）时，整个包装层跟着隐藏
    var obs = new MutationObserver(function () {
      wrap.hidden = !!editor.hidden;
    });
    obs.observe(editor, { attributes: true, attributeFilter: ['hidden'] });
    wrap.hidden = !!editor.hidden;
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

      if (cls) {
        out += '<span class="' + cls + '">' + escapeHtml(m[0]) + '</span>';
      } else {
        out += escapeHtml(m[0]);
      }

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

    if (text.length > MAX_HIGHLIGHT || lang === 'plain') {
      wrap.classList.add('hr-plain');
      pre.hidden = true;
      return;
    }

    wrap.classList.remove('hr-plain');
    pre.hidden = false;
    codeEl.innerHTML = highlightToHtml(text, lang) + '\n';
    pre.scrollTop = editor.scrollTop;
    pre.scrollLeft = editor.scrollLeft;
  }

  function scheduleHighlight() {
    clearTimeout(highlightTimer);
    highlightTimer = setTimeout(syncHighlight, HIGHLIGHT_DELAY);
  }

  /* 拦截 app.js 对 editor.value 的赋值，切文件时也能刷新高亮 */
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

  /* ================= 光标定位 ================= */
  function revealCaret() {
    var pos = editor.selectionStart;
    var before = editor.value.slice(0, pos);
    var lineIndex = before.split('\n').length - 1;
    var lh = parseFloat(getComputedStyle(editor).lineHeight) || 24;
    var y = lineIndex * lh;
    var top = editor.scrollTop;
    var h = editor.clientHeight;

    if (y < top || y > top + h - lh * 2) {
      editor.scrollTop = Math.max(0, y - h / 3);
    }
    if (pre && !pre.hidden) pre.scrollTop = editor.scrollTop;
  }

  /* ================= 事件 ================= */
  function bindEvents() {
    editor.addEventListener('input', function (e) {
      if (e.isComposing || composing) return;
      scheduleHighlight();
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

    editor.addEventListener('scroll', function () {
      if (pre && !pre.hidden) {
        pre.scrollTop = editor.scrollTop;
        pre.scrollLeft = editor.scrollLeft;
      }
    });

    // 回车自动缩进
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
    b.addEventListener('click', function (e) {
      e.preventDefault();
      handler();
    });
    return b;
  }

  function updateCount() {
    if (!countEl) return;
    if (!matches.length) {
      countEl.textContent = '0/0';
    } else {
      countEl.textContent = (matchIndex + 1) + '/' + matches.length;
    }
  }

  function refreshMatches() {
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

  function step(dir) {
    if (!matches.length) return;
    var len = findInput.value.length || 1;
    matchIndex = (matchIndex + dir + matches.length) % matches.length;
    var start = matches[matchIndex];
    editor.focus();
    editor.setSelectionRange(start, start + len);
    revealCaret();
    updateCount();
  }

  function replaceOne() {
    if (!matches.length) return;
    var len = findInput.value.length;
    var start = matches[matchIndex];
    var text = editor.value;

    editor.value = text.slice(0, start) + replaceInput.value + text.slice(start + len);
    editor.setSelectionRange(start + replaceInput.value.length, start + replaceInput.value.length);
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    refreshMatches();
    syncHighlight();
    revealCaret();
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
  }

  /* ================= 挂载 ================= */
  function addFindButton() {
    var tabbar = document.querySelector('.tabbar');
    if (!tabbar || document.getElementById('hrFindBtn')) return;

    var btn = document.createElement('button');
    btn.className = 'addfile';
    btn.id = 'hrFindBtn';
    btn.textContent = '找';
    btn.setAttribute('aria-label', '查找替换');
    btn.addEventListener('click', function () {
      if (findBar && !findBar.hidden) closeFind();
      else openFind();
    });

    var anchor = document.getElementById('hrFileBtn') || document.getElementById('saveHint');
    if (anchor) tabbar.insertBefore(btn, anchor);
    else tabbar.appendChild(btn);
  }

  function init() {
    injectStyle();
    buildDom();
    hookValue();
    bindEvents();
    addFindButton();
    syncHighlight();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
