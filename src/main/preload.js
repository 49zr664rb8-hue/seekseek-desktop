'use strict';

/* 1) 不再预置占位 API Key：公开版由用户自己在设置里填服务商地址、模型和 Key */

/* 2) 补齐 ES2023 的数组方法（旧内核没有，前端用到 toReversed 会直接报错） */
(function polyfill() {
  const def = (name, fn) => {
    if (!Array.prototype[name]) {
      Object.defineProperty(Array.prototype, name, {
        value: fn,
        writable: true,
        configurable: true,
        enumerable: false
      });
    }
  };

  def('toReversed', function () { return Array.prototype.slice.call(this).reverse(); });
  def('toSorted', function (cmp) { return Array.prototype.slice.call(this).sort(cmp); });
  def('toSpliced', function () {
    const args = Array.prototype.slice.call(arguments);
    const copy = Array.prototype.slice.call(this);
    copy.splice.apply(copy, args);
    return copy;
  });
  def('with', function (index, value) {
    const copy = Array.prototype.slice.call(this);
    const i = index < 0 ? copy.length + index : index;
    copy[i] = value;
    return copy;
  });
})();


/* 3) 暴露给页面的桥接（代码块预览 + 服务商设置 + 系统语音） */
try {
  const { contextBridge, ipcRenderer } = require('electron');
  contextBridge.exposeInMainWorld('dsBridge', {
    preview: (html) => ipcRenderer.send('preview:html', html),
    saveProvider: (payload) => ipcRenderer.invoke('provider:save', payload),
    getProvider: () => ipcRenderer.invoke('provider:get'),
    listVoices: () => ipcRenderer.invoke('voices:list')
  });
} catch (e) { /* ignore */ }

/* 4) 给代码块加「下载 / 预览」按钮（网页版有，官方 demo 没有） */
(function decorateCodeBlocks() {
  const { ipcRenderer } = require('electron');

  const isHtml = (code, lang) => {
    if (lang && /^html?$/i.test(lang)) return true;
    const head = code.trim().slice(0, 200).toLowerCase();
    return head.startsWith('<!doctype html') || head.startsWith('<html') || /^<(div|body|head|script|style|table)\b/.test(head);
  };

  const langOf = (codeEl, preEl) => {
    const cls = (codeEl.className || '') + ' ' + (preEl.className || '');
    const m = cls.match(/language-([\w+-]+)/i) || cls.match(/lang-([\w+-]+)/i);
    if (m) return m[1].toLowerCase();
    const label = preEl.parentElement && preEl.parentElement.querySelector('[class*="lang"], [data-lang]');
    return label ? (label.textContent || '').trim().toLowerCase() : '';
  };

  const decorate = (pre) => {
    if (!pre || pre.dataset.dsDecorated) return;
    const codeEl = pre.querySelector('code');
    if (!codeEl) return;
    const code = codeEl.textContent || '';
    if (code.trim().length < 10) return;

    pre.dataset.dsDecorated = '1';
    if (getComputedStyle(pre).position === 'static') pre.style.position = 'relative';

    const bar = document.createElement('div');
    bar.style.cssText = 'position:absolute;top:6px;right:8px;display:flex;gap:6px;z-index:5;';

    const mkBtn = (label, fn) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText =
        'font:12px/1 inherit;padding:4px 8px;border-radius:6px;cursor:pointer;' +
        'border:1px solid rgba(255,255,255,.25);background:rgba(255,255,255,.12);color:#e6e9f2;';
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        fn();
      });
      return b;
    };

    const lang = langOf(codeEl, pre);
    const html = isHtml(code, lang);

    bar.appendChild(
      mkBtn('下载', () => {
        const ext = lang === 'javascript' ? 'js' : lang === 'typescript' ? 'ts' : lang === 'python' ? 'py' : html ? 'html' : 'txt';
        const blob = new Blob([code], { type: 'text/plain;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'code.' + ext;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      })
    );

    if (html) {
      bar.appendChild(mkBtn('预览', () => ipcRenderer.send('preview:html', code)));
    }

    pre.appendChild(bar);
  };

  const scan = () => {
    document.querySelectorAll('pre').forEach(decorate);
  };

  const start = () => {
    scan();
    const mo = new MutationObserver(() => scan());
    mo.observe(document.body, { childList: true, subtree: true });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();

/* 5) 原版桌宠：加载 dsh-pet 官方客户端 bundle + 宿主垫片 */
(function mountRealPet() {
  const load = (src) =>
    new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => resolve(true);
      s.onerror = () => { console.warn('[dsh-pet] 加载失败 ' + src); resolve(false); };
      document.head.appendChild(s);
    });

  const start = async () => {
    const ok1 = await load('/pet/vendor/react.js');
    const ok2 = await load('/pet/vendor/react-dom.js');
    if (!ok1 || !ok2) return;
    await load('/pet/host.js');
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
