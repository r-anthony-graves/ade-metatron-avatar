'use strict';
/* Address grammar for the LSP slash-commands (/def /refs /hover). Pure --
   no DOM, no bridge, no state -- so node can test it while the chat window
   loads it off a script tag.

     "adeos/api/app.py:120:15"  -> { file, line: 120, col: 15 }
     "adeos/api/app.py:120"     -> { file, line: 120, col: 1 }
     "resolve_llm"              -> { symbol }
     "openChat chat.js"         -> { symbol, file }
     "" / "app.py"              -> { error }  (a file needs a :line)

   A token is a FILE when it carries a path separator, a known code
   extension, or :digits; everything else is a symbol name. Lines and
   columns are 1-based here and stay 1-based all the way to Ade OS. */
(function (root) {
  function looksLikeFile(tok) {
    return tok.indexOf('/') !== -1 || tok.indexOf('\\') !== -1
        || /\.(py|pyi|js|mjs|cjs|ts|tsx)(:|$)/.test(tok);
  }
  function parseLspAddress(raw) {
    var s = (raw || '').trim();
    if (!s) return { error: 'give a file:line[:col] or a symbol name' };
    var parts = s.split(/\s+/);
    if (looksLikeFile(parts[0])) {
      var m = /^(.*?):(\d+)(?::(\d+))?$/.exec(parts[0]);
      if (m) {
        return { file: m[1], line: parseInt(m[2], 10),
                 col: m[3] ? parseInt(m[3], 10) : 1 };
      }
      return { error: 'a file address needs :line -- e.g. '
                      + parts[0] + ':42 (or give a symbol name)' };
    }
    if (parts.length > 1 && looksLikeFile(parts[1])) {
      return { symbol: parts[0], file: parts[1] };
    }
    return { symbol: parts[0] };
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = parseLspAddress;
  } else {
    root.parseLspAddress = parseLspAddress;
  }
})(this);
