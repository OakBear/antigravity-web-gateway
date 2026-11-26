(function () {
  var PREFIX = __SIDECAR_PREFIX__;

  function rewritePath(raw) {
    if (typeof raw !== 'string') return raw;
    if (raw.startsWith('/') && !raw.startsWith('//') && raw !== PREFIX && !raw.startsWith(PREFIX + '/')) {
      return PREFIX + raw;
    }
    return raw;
  }

  // Patch fetch
  if (typeof window.fetch === 'function') {
    var origFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      if (typeof input === 'string') {
        input = rewritePath(input);
      } else if (input instanceof Request) {
        try {
          var u = new URL(input.url);
          if (u.origin === window.location.origin && u.pathname !== PREFIX && !u.pathname.startsWith(PREFIX + '/')) {
            input = new Request(u.origin + PREFIX + u.pathname + u.search + u.hash, input);
          }
        } catch {}
      }
      return origFetch(input, init);
    };
  }

  // Patch XMLHttpRequest
  if (typeof XMLHttpRequest !== 'undefined' && XMLHttpRequest.prototype) {
    var origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      var args = Array.prototype.slice.call(arguments);
      if (typeof url === 'string') {
        args[1] = rewritePath(url);
      }
      return origOpen.apply(this, args);
    };
  }

  // Patch EventSource (SSE)
  if (typeof window.EventSource === 'function') {
    var OrigEventSource = window.EventSource;
    window.EventSource = function (url, config) {
      return new OrigEventSource(rewritePath(String(url)), config);
    };
    window.EventSource.prototype = OrigEventSource.prototype;
  }
})();
