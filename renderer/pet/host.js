/* dsh-pet 宿主垫片：让插件的官方客户端 bundle 脱离 DSH 直接跑在本页里。
   只做四件事：模块加载器、react 注入、最小 ctx（slots/locale/effect）、把 shell.overlay 渲进页面。 */
(function () {
  if (window.__dshPetHost) return;
  window.__dshPetHost = true;

  var loaded = [];

  /* 1) DSH 的模块系统契约：插件 bundle 调 window.__ModuleLoader__.load({id, factory}) */
  window.__ModuleLoader__ = {
    load: function (info) {
      loaded.push(info);
    }
  };

  /* 2) react/jsx-runtime 用 createElement 等价实现（UMD 包不带 jsx-runtime） */
  var jsxRuntime = {
    Fragment: window.React.Fragment,
    jsx: function (type, props, key) {
      var p = props || {};
      if (key !== undefined && key !== null) p = Object.assign({}, p, { key: key });
      return window.React.createElement(type, p);
    },
    jsxs: function (type, props, key) {
      return jsxRuntime.jsx(type, props, key);
    },
    jsxDEV: function (type, props, key) {
      return jsxRuntime.jsx(type, props, key);
    }
  };

  var modules = {
    react: window.React,
    'react/jsx-runtime': jsxRuntime,
    'react-dom': window.ReactDOM,
    'react-dom/client': {
      createRoot: window.ReactDOM.createRoot,
      hydrateRoot: window.ReactDOM.hydrateRoot
    }
  };

  function req(name) {
    if (Object.prototype.hasOwnProperty.call(modules, name)) return modules[name];
    throw new Error('dsh-pet host: 模块不可用 ' + name);
  }

  /* 3) 最小 ctx：插件只用 effect / provide / get / locale / slots */
  var registry = {};
  var roots = {};
  var hostEl = null;

  function ensureHost() {
    if (hostEl && document.body.contains(hostEl)) return hostEl;
    hostEl = document.createElement('div');
    hostEl.id = 'dsh-pet-overlay';
    hostEl.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:50;';
    document.body.appendChild(hostEl);
    return hostEl;
  }

  function paint() {
    var list = (registry['shell.overlay'] || []).slice().sort(function (a, b) {
      return a.order - b.order;
    });
    if (!list.length) return;

    var host = ensureHost();
    for (var i = 0; i < list.length; i += 1) {
      var item = list[i];
      if (roots[item.id]) continue;
      var box = document.createElement('div');
      box.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
      host.appendChild(box);
      var root = window.ReactDOM.createRoot(box);
      roots[item.id] = root;
      try {
        root.render(window.React.createElement(item.Component, {}));
      } catch (e) {
        console.error('[dsh-pet] 渲染失败', e);
      }
    }
  }

  var ctx = {
    effect: function (fn) {
      try {
        var d = fn();
        return typeof d === 'function' ? d : function () {};
      } catch (e) {
        console.warn('[dsh-pet] effect 失败：' + (e && e.message));
        return function () {};
      }
    },
    provide: function () {},
    get: function () {
      return undefined;
    },
    locale: {
      register: function () {
        return function () {};
      },
      bind: function () {
        return function (k) {
          return k;
        };
      }
    },
    slots: {
      register: function (entry, Component) {
        var name = entry && entry.name;
        if (!name || typeof Component !== 'function') return { dispose: function () {} };
        (registry[name] || (registry[name] = [])).push({
          id: entry.id || name,
          order: entry.order || 0,
          Component: Component
        });
        if (name === 'shell.overlay') setTimeout(paint, 0);
        return { dispose: function () {} };
      },
      inject: function (name, gen) {
        try {
          var it = gen();
          var r = it.next();
          while (!r.done) r = it.next();
        } catch (e) {
          console.warn('[dsh-pet] 插槽注入失败 ' + name + '：' + (e && e.message));
        }
      }
    }
  };

  /* 4) 启动：跑插件 factory → apply → 渲染 */
  function boot() {
    if (!loaded.length) {
      console.warn('[dsh-pet] 客户端 bundle 没有注册任何模块');
      return;
    }
    loaded.forEach(function (info) {
      var mod;
      try {
        mod = info.factory(req);
      } catch (e) {
        console.error('[dsh-pet] factory 失败：' + (e && e.message));
        return;
      }
      if (!mod || typeof mod.apply !== 'function') {
        console.warn('[dsh-pet] 模块缺少 apply');
        return;
      }
      try {
        mod.apply(ctx);
        console.log('[dsh-pet] 已挂载：' + (info.id || ''));
      } catch (e) {
        console.error('[dsh-pet] apply 失败：' + (e && e.message));
      }
    });
  }

  function loadScript(src) {
    return new Promise(function (resolve) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = function () {
        resolve(true);
      };
      s.onerror = function () {
        console.warn('[dsh-pet] 脚本加载失败 ' + src);
        resolve(false);
      };
      document.head.appendChild(s);
    });
  }

  loadScript('/pet/client.js').then(boot);
})();
