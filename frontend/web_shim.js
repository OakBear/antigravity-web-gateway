(function () {
  const DEFAULT_WORKSPACE = __DEFAULT_WORKSPACE__;
  const INITIAL_STORAGE = __INITIAL_APP_STORAGE__;

  // 1. Bounce off /onboarding back to root and ensure ConnectRPC multiplexes over WebSocket
  //    so browser requests do not hit Chrome's 6-connections-per-origin HTTP/1.1 limit.
  if (window.location.pathname === '/onboarding') {
    window.history.replaceState(null, '', '/?useWebSocket=true');
  } else {
    try {
      const u = new URL(window.location.href);
      if (u.searchParams.get('useWebSocket') !== 'true') {
        u.searchParams.set('useWebSocket', 'true');
        window.history.replaceState(window.history.state, '', u.toString());
      }
    } catch {}
  }

  // 2. Seed localStorage from gateway-managed app_storage.json and expose window.nativeStorage
  try {
    for (const [k, v] of Object.entries(INITIAL_STORAGE || {})) {
      if (typeof v === 'string' && window.localStorage.getItem(k) === null) {
        window.localStorage.setItem(k, v);
      }
    }
  } catch {}

  const storageListeners = new Set();
  window.nativeStorage = {
    getItems: async () => {
      try {
        const res = await fetch('/__agy_gateway_storage', { cache: 'no-store' });
        if (res.ok) return await res.json();
      } catch {}
      return INITIAL_STORAGE;
    },
    updateItems: async (changes) => {
      Object.assign(INITIAL_STORAGE, changes || {});
      try {
        for (const [k, v] of Object.entries(changes || {})) {
          if (v === null || v === undefined) window.localStorage.removeItem(k);
          else window.localStorage.setItem(k, String(v));
        }
      } catch {}
      try {
        await fetch('/__agy_gateway_storage', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(changes || {}),
        });
      } catch {}
      for (const fn of storageListeners) {
        try {
          fn(changes);
        } catch {}
      }
    },
    onChanged: (cb) => {
      storageListeners.add(cb);
      return () => storageListeners.delete(cb);
    },
  };

  // 3. Polyfill Electron folder dialogs for remote web browser sessions
  window.dialog = {
    showOpenDialog: async () => {
      const p = window.prompt('请输入 Linux 服务器上的文件夹绝对路径:', DEFAULT_WORKSPACE);
      return p ? p.trim() : undefined;
    },
    showOpenMultipleFolderDialog: async () => {
      const p = window.prompt('请输入 Linux 服务器上的文件夹绝对路径:', DEFAULT_WORKSPACE);
      return p ? [p.trim()] : undefined;
    },
  };

  // 4. Rewrite local sidecar iframe URLs (http://localhost:<port>/...) through this gateway
  //    (/__agy_sidecar/<port>/...) so UI plugins render over a single SSH tunnel.
  function rewriteSidecarUrl(raw) {
    if (typeof raw !== 'string') return raw;
    try {
      const u = new URL(raw);
      if (u.protocol !== 'http:') return raw;
      if (u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') return raw;
      if (!u.port || u.port === String(window.location.port || '80')) return raw;
      return (
        window.location.origin +
        '/__agy_sidecar/' +
        u.port +
        (u.pathname || '/') +
        u.search +
        u.hash
      );
    } catch {
      return raw;
    }
  }

  function collectThemeCssVars() {
    const cs = window.getComputedStyle(document.documentElement);
    const keys = [
      '--background',
      '--foreground',
      '--primary',
      '--primary-foreground',
      '--card',
      '--card-foreground',
      '--muted',
      '--muted-foreground',
      '--border',
      '--accent',
      '--accent-foreground',
      '--popover',
      '--popover-foreground',
    ];
    const vars = {};
    for (const k of keys) {
      const val = cs.getPropertyValue(k).trim();
      if (val) vars[k] = val;
    }
    return vars;
  }

  function pushThemeToIframe(iframe) {
    try {
      const vars = collectThemeCssVars();
      if (Object.keys(vars).length > 0 && iframe.contentWindow) {
        iframe.contentWindow.postMessage(
          { type: 'theme-change', payload: { cssVariables: vars } },
          window.location.origin
        );
      }
    } catch {}
  }

  function attachSidecarIframeHooks(iframe) {
    if (!iframe || iframe.__agySidecarHooked) return;
    iframe.__agySidecarHooked = true;
    iframe.addEventListener('load', () => pushThemeToIframe(iframe));
  }

  const origSetAttr = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    if (this && this.tagName === 'IFRAME' && String(name).toLowerCase() === 'src') {
      const rewritten = rewriteSidecarUrl(String(value));
      if (rewritten !== String(value)) attachSidecarIframeHooks(this);
      return origSetAttr.call(this, name, rewritten);
    }
    return origSetAttr.call(this, name, value);
  };

  const iframeSrcDesc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'src');
  if (iframeSrcDesc && iframeSrcDesc.set) {
    Object.defineProperty(HTMLIFrameElement.prototype, 'src', {
      configurable: true,
      enumerable: iframeSrcDesc.enumerable,
      get: iframeSrcDesc.get,
      set: function (val) {
        const rewritten = rewriteSidecarUrl(String(val));
        if (rewritten !== String(val)) attachSidecarIframeHooks(this);
        return iframeSrcDesc.set.call(this, rewritten);
      },
    });
  }

  function scanIframes(root) {
    if (!root || !root.querySelectorAll) return;
    const list = root.tagName === 'IFRAME' ? [root] : root.querySelectorAll('iframe[src]');
    for (const el of list) {
      const cur = el.getAttribute('src');
      if (!cur) continue;
      const next = rewriteSidecarUrl(cur);
      if (next !== cur) {
        attachSidecarIframeHooks(el);
        origSetAttr.call(el, 'src', next);
      }
    }
  }

  const mo = new MutationObserver((muts) => {
    for (const mut of muts) {
      if (mut.type === 'attributes' && mut.target.tagName === 'IFRAME') {
        scanIframes(mut.target);
      } else if (mut.type === 'childList') {
        for (const node of mut.addedNodes) {
          if (node.nodeType === 1) scanIframes(node);
        }
      }
    }
  });
  mo.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['src'],
  });

  const themeMo = new MutationObserver(() => {
    document.querySelectorAll('iframe[src*="/__agy_sidecar/"]').forEach(pushThemeToIframe);
  });
  themeMo.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style', 'class', 'data-theme'],
  });
})();
