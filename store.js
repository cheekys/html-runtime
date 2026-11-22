/* ============================================================
   存储层 + 文件模型 + zip 导入 + 导出
   ============================================================ */

(function (global) {
  'use strict';

  var DB_NAME = 'html-runtime';
  var DB_VERSION = 1;
  var STORE_NAME = 'projects';
  var LEGACY_KEY = 'html-runtime:code:v1';
  var MAX_UNZIP_BYTES = 60 * 1024 * 1024;

  /* ================= IndexedDB ================= */
  var dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      if (!global.indexedDB) {
        reject(new Error('此浏览器不支持 IndexedDB'));
        return;
      }
      var req = global.indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          var os = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
          os.createIndex('updatedAt', 'updatedAt');
        }
      };
      req.onsuccess = function () {
        resolve(req.result);
      };
      req.onerror = function () {
        reject(req.error || new Error('打开数据库失败'));
      };
    });
    return dbPromise;
  }

  function newId() {
    return 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function listProjects() {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var req = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAll();
        req.onsuccess = function () {
          var items = (req.result || []).map(normalizeProject);
          items.sort(function (a, b) {
            return (b.updatedAt || 0) - (a.updatedAt || 0);
          });
          resolve(items);
        };
        req.onerror = function () {
          reject(req.error);
        };
      });
    });
  }

  function getProject(id) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var req = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(id);
        req.onsuccess = function () {
          resolve(req.result ? normalizeProject(req.result) : null);
        };
        req.onerror = function () {
          reject(req.error);
        };
      });
    });
  }

  function putProject(project) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(project);
        tx.oncomplete = function () {
          resolve(project);
        };
        tx.onerror = function () {
          reject(tx.error);
        };
      });
    });
  }

  function deleteProject(id) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).delete(id);
        tx.oncomplete = function () {
          resolve();
        };
        tx.onerror = function () {
          reject(tx.error);
        };
      });
    });
  }

  /* ================= 文件类型 ================= */
  var MIME = {
    html: 'text/html',
    htm: 'text/html',
    css: 'text/css',
    js: 'text/javascript',
    mjs: 'text/javascript',
    json: 'application/json',
    txt: 'text/plain',
    md: 'text/markdown',
    xml: 'application/xml',
    csv: 'text/csv',
    svg: 'image/svg+xml',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    ico: 'image/x-icon',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    m4a: 'audio/mp4',
    aac: 'audio/aac',
    mp4: 'video/mp4',
    webm: 'video/webm',
    woff: 'font/woff',
    woff2: 'font/woff2',
    ttf: 'font/ttf',
    otf: 'font/otf',
    glb: 'model/gltf-binary',
    gltf: 'model/gltf+json',
    wasm: 'application/wasm'
  };

  var TEXT_EXT = {
    html: 1, htm: 1, css: 1, js: 1, mjs: 1, json: 1, txt: 1, md: 1,
    xml: 1, csv: 1, svg: 1, glsl: 1, frag: 1, vert: 1, map: 1, ts: 1
  };

  function extOf(path) {
    var m = /\.([a-z0-9]+)$/i.exec(path || '');
    return m ? m[1].toLowerCase() : '';
  }

  function mimeOf(path) {
    return MIME[extOf(path)] || 'application/octet-stream';
  }

  function isTextPath(path) {
    return TEXT_EXT[extOf(path)] === 1;
  }

  function makeFile(path, content) {
    path = String(path || '').replace(/^\/+/, '');
    var mime = mimeOf(path);

    if (isTextPath(path)) {
      return {
        path: path,
        kind: 'text',
        mime: mime,
        text: content == null ? '' : String(content)
      };
    }

    if (content instanceof Blob) {
      return { path: path, kind: 'binary', mime: mime, blob: content };
    }
    return {
      path: path,
      kind: 'binary',
      mime: mime,
      blob: new Blob([content || new Uint8Array(0)], { type: mime })
    };
  }

  /* ================= 项目模型 ================= */
  function findFile(project, path) {
    if (!project || !path) return null;
    for (var i = 0; i < project.files.length; i++) {
      if (project.files[i].path === path) return project.files[i];
    }
    return null;
  }

  function pickEntry(files) {
    var i;
    for (i = 0; i < files.length; i++) {
      if (files[i].path === 'index.html') return 'index.html';
    }
    for (i = 0; i < files.length; i++) {
      if (/^[^/]+\.html?$/i.test(files[i].path)) return files[i].path;
    }
    for (i = 0; i < files.length; i++) {
      if (/\.html?$/i.test(files[i].path)) return files[i].path;
    }
    return files.length ? files[0].path : '';
  }

  /** 旧版「html/css/js 三段」-> 文件树 */
  function legacyToFiles(html, css, js) {
    var files = [];
    var head = [];

    css = String(css || '');
    js = String(js || '');
    html = String(html || '');

    if (css.trim()) {
      files.push(makeFile('style.css', css));
      head.push('<link rel="stylesheet" href="style.css">');
    }
    if (js.trim()) {
      files.push(makeFile('script.js', js));
      head.push('<script src="script.js"></script>');
    }

    var doc = [
      '<!doctype html>',
      '<html lang="zh-CN">',
      '<head>',
      '<meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">'
    ].concat(head).concat([
      '</head>',
      '<body>',
      html,
      '</body>',
      '</html>'
    ]).join('\n');

    files.unshift(makeFile('index.html', doc));
    return files;
  }

  function normalizeProject(raw) {
    var project = {
      id: raw.id || newId(),
      name: raw.name || '未命名项目',
      createdAt: raw.createdAt || Date.now(),
      updatedAt: raw.updatedAt || Date.now(),
      files: [],
      entry: raw.entry || ''
    };

    if (Array.isArray(raw.files) && raw.files.length) {
      project.files = raw.files;
    } else {
      project.files = legacyToFiles(raw.html, raw.css, raw.js);
    }

    if (!project.entry || !findFile(project, project.entry)) {
      project.entry = pickEntry(project.files);
    }
    return project;
  }

  function defaultFiles() {
    return [
      makeFile(
        'index.html',
        [
          '<!doctype html>',
          '<html lang="zh-CN">',
          '<head>',
          '<meta charset="utf-8">',
          '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
          '<title>新项目</title>',
          '</head>',
          '<body>',
          '',
          '</body>',
          '</html>'
        ].join('\n')
      )
    ];
  }

  function createProject(name, files) {
    var now = Date.now();
    var list = files && files.length ? files : defaultFiles();
    var project = {
      id: newId(),
      name: name || '未命名项目',
      createdAt: now,
      updatedAt: now,
      files: list,
      entry: pickEntry(list)
    };
    return putProject(project);
  }

  function migrateLegacy() {
    var legacy = null;
    try {
      legacy = JSON.parse(global.localStorage.getItem(LEGACY_KEY) || 'null');
    } catch (e) {
      legacy = null;
    }
    var hasContent = legacy && (legacy.html || legacy.css || legacy.js);
    if (!hasContent) return Promise.resolve(false);

    return listProjects().then(function (list) {
      if (list.length > 0) return false;
      return createProject('我的项目').then(function () {
        try {
          global.localStorage.removeItem(LEGACY_KEY);
        } catch (e) {}
        return true;
      });
    });
  }

  /* ================= 路径解析 ================= */
  function isExternalUrl(url) {
    return /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(url);
  }

  function dirOf(path) {
    var idx = String(path || '').lastIndexOf('/');
    return idx < 0 ? '' : path.slice(0, idx);
  }

  /** 把 fromPath 里的相对 url 解析成项目内的绝对路径；外部 URL 返回 null */
  function resolvePath(fromPath, url) {
    if (!url) return null;
    if (isExternalUrl(url)) return null;

    var clean = String(url).replace(/[?#].*$/, '');
    if (!clean) return null;

    var baseDir = dirOf(fromPath);
    var raw = clean.charAt(0) === '/' ? clean.slice(1) : baseDir + '/' + clean;
    var segments = raw.split('/');
    var stack = [];

    for (var i = 0; i < segments.length; i++) {
      var seg = segments[i];
      if (!seg || seg === '.') continue;
      if (seg === '..') {
        stack.pop();
      } else {
        stack.push(seg);
      }
    }
    return stack.join('/');
  }

  /* ================= 运行时：Blob URL 映射 ================= */
  function rewriteCssUrls(css, fromPath, map) {
    return String(css || '').replace(
      /url\(\s*(['"]?)([^'")]*)\1\s*\)/gi,
      function (match, quote, rawValue) {
        var url = String(rawValue || '').trim();
        if (!url) return match;
        var resolved = resolvePath(fromPath, url);
        if (!resolved || !map[resolved]) return match;
        return 'url("' + map[resolved] + '")';
      }
    );
  }

  function createAssetMap(project) {
    var map = {};
    var urls = [];

    function add(path, blob) {
      var url = URL.createObjectURL(blob);
      map[path] = url;
      urls.push(url);
    }

    // 第一遍：非 CSS 文件
    project.files.forEach(function (file) {
      if (/\.css$/i.test(file.path)) return;
      var blob = file.kind === 'text'
        ? new Blob([file.text || ''], { type: file.mime || 'text/plain' })
        : file.blob;
      if (blob) add(file.path, blob);
    });

    // 第二遍：CSS 先把 url() 换成 blob，再建 URL
    project.files.forEach(function (file) {
      if (!/\.css$/i.test(file.path)) return;
      var css = rewriteCssUrls(file.text || '', file.path, map);
      add(file.path, new Blob([css], { type: 'text/css' }));
    });

    return { map: map, urls: urls };
  }

  var BASE_STYLE = 'html,body{margin:0;background:#0b0e14;color:#e6edf3;}';

  function buildRuntimeDocument(project, map, bridgeSource) {
    var entry = findFile(project, project.entry) || project.files[0];
    if (!entry || entry.kind !== 'text') return '';

    var doc;
    try {
      doc = new global.DOMParser().parseFromString(entry.text || '', 'text/html');
    } catch (e) {
      return entry.text || '';
    }

    var head = doc.head || doc.documentElement;

    // 1) 资源映射表：路径 -> blob URL，必须在桥接脚本之前注入
    var mapJson = JSON.stringify(map).replace(/</g, '\\u003c');
    var assetScript = doc.createElement('script');
    assetScript.textContent =
      'window.__HR_ASSETS__=' + mapJson + ';' +
      'window.__HR_BASE__=' + JSON.stringify(dirOf(entry.path)) + ';';
    head.insertBefore(assetScript, head.firstChild);

    // 2) 桥接脚本
    var bridge = doc.createElement('script');
    bridge.textContent = bridgeSource;
    head.insertBefore(bridge, assetScript.nextSibling);

    // 3) 基础样式（放在用户样式之前，方便被覆盖）
    var baseStyle = doc.createElement('style');
    baseStyle.textContent = BASE_STYLE;
    head.insertBefore(baseStyle, bridge.nextSibling);

    // 重写属性里的资源引用
    var attrNames = ['src', 'href', 'poster', 'data'];
    var all = doc.querySelectorAll('*');

    for (var i = 0; i < all.length; i++) {
      var el = all[i];

      for (var a = 0; a < attrNames.length; a++) {
        var name = attrNames[a];
        var value = el.getAttribute(name);
        if (!value) continue;
        var resolved = resolvePath(entry.path, value);
        if (resolved && map[resolved]) el.setAttribute(name, map[resolved]);
      }

      var styleAttr = el.getAttribute('style');
      if (styleAttr) {
        el.setAttribute('style', rewriteCssUrls(styleAttr, entry.path, map));
      }
    }

    // 内联 <style> 也要处理
    var styles = doc.querySelectorAll('style');
    for (var s = 0; s < styles.length; s++) {
      if (styles[s] === baseStyle) continue;
      styles[s].textContent = rewriteCssUrls(styles[s].textContent || '', entry.path, map);
    }

    return '<!doctype html>\n' + doc.documentElement.outerHTML;
  }

  /* ================= 导出：单文件 HTML ================= */
  function blobToDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        resolve(String(reader.result));
      };
      reader.onerror = function () {
        reject(reader.error || new Error('读取失败'));
      };
      reader.readAsDataURL(blob);
    });
  }

  function escapeStyleText(css) {
    return String(css || '').replace(/<\/style/gi, '<\\/style');
  }

  function escapeScriptText(js) {
    return String(js || '').replace(/<\/script/gi, '<\\/script');
  }

  function buildStandaloneHtml(project) {
    var entry = findFile(project, project.entry) || project.files[0];
    if (!entry || entry.kind !== 'text') {
      return Promise.reject(new Error('入口文件不是文本文件'));
    }

    var jobs = project.files.map(function (file) {
      var blob = file.kind === 'text'
        ? new Blob([file.text || ''], { type: file.mime || 'text/plain' })
        : file.blob;
      if (!blob) return Promise.resolve(null);
      return blobToDataUrl(blob).then(function (dataUrl) {
        return { path: file.path, dataUrl: dataUrl, file: file };
      });
    });

    return Promise.all(jobs).then(function (items) {
      var dataMap = {};
      items.forEach(function (item) {
        if (item) dataMap[item.path] = item.dataUrl;
      });

      var doc = new global.DOMParser().parseFromString(entry.text || '', 'text/html');
      var i;

      // 外链样式 -> 内联
      var links = doc.querySelectorAll('link[rel="stylesheet"]');
      for (i = 0; i < links.length; i++) {
        var link = links[i];
        var href = link.getAttribute('href');
        var path = resolvePath(entry.path, href);
        var cssFile = path ? findFile(project, path) : null;
        if (cssFile && cssFile.kind === 'text') {
          var style = doc.createElement('style');
          style.textContent = escapeStyleText(rewriteCssUrls(cssFile.text || '', cssFile.path, dataMap));
          link.parentNode.replaceChild(style, link);
        }
      }

      // 外部脚本 -> 内联
      var scripts = doc.querySelectorAll('script[src]');
      for (i = 0; i < scripts.length; i++) {
        var script = scripts[i];
        var scriptPath = resolvePath(entry.path, script.getAttribute('src'));
        var jsFile = scriptPath ? findFile(project, scriptPath) : null;
        if (jsFile && jsFile.kind === 'text') {
          var inline = doc.createElement('script');
          if (script.getAttribute('type')) inline.setAttribute('type', script.getAttribute('type'));
          inline.textContent = escapeScriptText(jsFile.text || '');
          script.parentNode.replaceChild(inline, script);
        }
      }

      // 其余属性 -> data URL
      var attrNames = ['src', 'href', 'poster', 'data'];
      var all = doc.querySelectorAll('*');
      for (i = 0; i < all.length; i++) {
        var el = all[i];
        for (var a = 0; a < attrNames.length; a++) {
          var name = attrNames[a];
          var value = el.getAttribute(name);
          if (!value) continue;
          var resolved = resolvePath(entry.path, value);
          if (resolved && dataMap[resolved]) el.setAttribute(name, dataMap[resolved]);
        }
        var styleAttr = el.getAttribute('style');
        if (styleAttr) el.setAttribute('style', rewriteCssUrls(styleAttr, entry.path, dataMap));
      }

      return '<!doctype html>\n' + doc.documentElement.outerHTML;
    });
  }

  /* ================= zip 解压 ================= */
  function inflateRaw(bytes) {
    if (typeof global.DecompressionStream === 'undefined') {
      return Promise.reject(new Error('此系统不支持解压，需要 iOS 16.4 以上'));
    }
    var stream;
    try {
      stream = new global.DecompressionStream('deflate-raw');
    } catch (e) {
      return Promise.reject(new Error('此系统不支持 deflate-raw 解压'));
    }
    var piped = new Blob([bytes]).stream().pipeThrough(stream);
    return new Response(piped).arrayBuffer().then(function (buffer) {
      return new Uint8Array(buffer);
    });
  }

  function extractEntry(buffer, view, header) {
    var offset = header.localOffset;
    if (view.getUint32(offset, true) !== 0x04034b50) {
      return Promise.reject(new Error('zip 数据损坏'));
    }
    var nameLen = view.getUint16(offset + 26, true);
    var extraLen = view.getUint16(offset + 28, true);
    var start = offset + 30 + nameLen + extraLen;
    var bytes = new Uint8Array(buffer, start, header.compSize);

    if (header.method === 0) return Promise.resolve(bytes);
    if (header.method === 8) return inflateRaw(bytes);
    return Promise.reject(new Error('不支持的压缩方式：' + header.method));
  }

  function readZip(buffer) {
    return Promise.resolve().then(function () {
      var view = new DataView(buffer);
      if (view.byteLength < 22) throw new Error('不是有效的 zip 文件');

      var start = Math.max(0, view.byteLength - 22 - 65535);
      var eocd = -1;
      for (var i = view.byteLength - 22; i >= start; i--) {
        if (view.getUint32(i, true) === 0x06054b50) {
          eocd = i;
          break;
        }
      }
      if (eocd < 0) throw new Error('不是有效的 zip 文件');

      var count = view.getUint16(eocd + 10, true);
      var cdOffset = view.getUint32(eocd + 16, true);

      var headers = [];
      var offset = cdOffset;
      for (var n = 0; n < count; n++) {
        if (offset + 46 > view.byteLength) break;
        if (view.getUint32(offset, true) !== 0x02014b50) break;

        var method = view.getUint16(offset + 10, true);
        var compSize = view.getUint32(offset + 20, true);
        var uncompSize = view.getUint32(offset + 24, true);
        var nameLen = view.getUint16(offset + 28, true);
        var extraLen = view.getUint16(offset + 30, true);
        var commentLen = view.getUint16(offset + 32, true);
        var localOffset = view.getUint32(offset + 42, true);

        var nameBytes = new Uint8Array(buffer, offset + 46, nameLen);
        var path = new TextDecoder('utf-8').decode(nameBytes);

        headers.push({
          path: path,
          method: method,
          compSize: compSize,
          uncompSize: uncompSize,
          localOffset: localOffset
        });

        offset += 46 + nameLen + extraLen + commentLen;
      }

      if (!headers.length) throw new Error('压缩包里没有文件');

      var total = 0;
      for (var j = 0; j < headers.length; j++) total += headers[j].uncompSize || 0;
      if (total > MAX_UNZIP_BYTES) throw new Error('压缩包解压后太大（上限 60MB）');

      return Promise.all(
        headers.map(function (header) {
          return extractEntry(buffer, view, header).then(function (bytes) {
            return { path: header.path, bytes: bytes };
          });
        })
      );
    });
  }

  function commonPrefix(paths) {
    if (!paths.length) return '';
    var first = paths[0].split('/')[0];
    for (var i = 0; i < paths.length; i++) {
      var parts = paths[i].split('/');
      if (parts.length < 2 || parts[0] !== first) return '';
    }
    return first + '/';
  }

  function importZip(buffer, fallbackName) {
    return readZip(buffer).then(function (entries) {
      var usable = entries.filter(function (entry) {
        var path = entry.path;
        if (!path || path.charAt(path.length - 1) === '/') return false;
        if (path.indexOf('__MACOSX/') === 0) return false;
        var base = path.split('/').pop();
        if (base === '.DS_Store') return false;
        if (base.charAt(0) === '.' && base !== '.well-known') return false;
        return true;
      });

      if (!usable.length) throw new Error('压缩包里没有可用文件');

      var prefix = commonPrefix(
        usable.map(function (entry) {
          return entry.path;
        })
      );

      var files = usable.map(function (entry) {
        var path = entry.path.slice(prefix.length);
        if (isTextPath(path)) {
          return makeFile(path, new TextDecoder('utf-8').decode(entry.bytes));
        }
        return makeFile(path, new Blob([entry.bytes], { type: mimeOf(path) }));
      });

      return {
        name: fallbackName || '导入项目',
        files: files,
        entry: pickEntry(files)
      };
    });
  }

  /* ================= HTML 导入 ================= */
  function makeHtmlProjectFiles(text) {
    return [makeFile('index.html', text)];
  }

  /* ================= 其它 ================= */
  function downloadText(filename, text) {
    var blob = new Blob([text], { type: 'text/html;charset=utf-8' });
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

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.top = '-1000px';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        if (ok) resolve();
        else reject(new Error('复制失败'));
      } catch (e) {
        reject(e);
      }
    });
  }

  global.HRStore = {
    openDb: openDb,
    listProjects: listProjects,
    getProject: getProject,
    putProject: putProject,
    deleteProject: deleteProject,
    createProject: createProject,
    migrateLegacy: migrateLegacy,
    normalizeProject: normalizeProject,
    findFile: findFile,
    pickEntry: pickEntry,
    makeFile: makeFile,
    isTextPath: isTextPath,
    mimeOf: mimeOf,
    createAssetMap: createAssetMap,
    buildRuntimeDocument: buildRuntimeDocument,
    buildStandaloneHtml: buildStandaloneHtml,
    importZip: importZip,
    makeHtmlProjectFiles: makeHtmlProjectFiles,
    resolvePath: resolvePath,
    downloadText: downloadText,
    copyText: copyText
  };
})(window);
