/* DetectCommandLine -- the chat's bare-line detector
 *
 * A line typed in the chat composer with no prefix is normally a question
 * for Ade. Some lines are unmistakably PowerShell though ("get-process",
 * "git status", "cd C:\\Users") and since 2026-09-13 those RUN instead,
 * with output streamed into the chat thread.
 *
 * Conservative to chat by design: only lines that clearly look like
 * commands are commands; everything else stays Ade's. The rules are fixed
 * sets and hard syntax, never free parsing. See docs/superpowers/specs/
 * 2026-09-13-chat-terminal-commands-design.md for the full rule set and its
 * known trade-offs.
 *
 * Pure, sync, DOM-free. Loaded in the chat window BEFORE chat.js via
 * <script src="terminal-detect.js"></script>; the node suite requires it.
 */
'use strict';

var ADE_TERMINAL_DETECT = (function () {
  /* Step 1: conversational openers head to chat BEFORE any syntax rule --
     "hi; how are you" is a message with a semicolon, not a background job.
     `please` is here on purpose: "please run git status" is conversation. */
  var STOP = "hi hey hello good morning good afternoon good evening nice thanks thank you please what why how who when where maybe sure ok okay yes no is are am was were will can could should would did does do have has had i you we they he she it".split(" ");

  /* Step 3: cmdlet families. The dash is load-bearing -- `get-process` and
     Get-ChildItem match; a bare `get` / `set` / `new` / `remove` / `start`
     does NOT (those are prose). */
  var FAMILY = /^(?:get|set|new|remove|copy|move|start|stop|restart|invoke|test|format|select|where|out|read|write|export|import|convert|sort|measure|foreach|add|clear|enable|disable|find|group|join|split|compare|resolve|push|pop|show|open|close|enter|wait|receive|trace|debug)-/i;

  /* Step 4a: unambiguous aliases. Deliberately TIGHT: no `copy` ("copy
     that"), no `move` ("move on"), no `select` ("select the option"), no
     `echo` / `start` / `where` / `help` / `man` / `clear` (prose words that
     share a command's name -- those need an explicit `!`). */
  var ALIAS = "ls dir cat type cd pwd cls clr mv rm del md mkdir rd rmdir gc gci gi ri sl set-location psh".split(" ");

  /* Step 4b: the CLIs that live on this machine. Exact first token. */
  var CLI = "git npm npx node python py pip pip3 cargo docker kubectl rg curl wget winget choco ssh scp taskkill tasklist netstat ipconfig tracert whoami hostname ver systeminfo".split(" ");

  var RE_FLAG = /(?:^|\s)-{1,2}[A-Za-z0-9]/;
  var RE_ANGLE = /[<>]/;
  var RE_PIPE = /\|/;
  var RE_SEMI = /;/;
  var RE_STAR = /\*/;
  var RE_ASSIGN = /\$[A-Za-z_][A-Za-z0-9_]*\s*=/;
  var RE_CALLOP = /^&\s/;
  var RE_OPEN = /^[(\[]/;
  var RE_EXT = /\.(?:ps1|bat|cmd|exe|jar|py|js)$/i;

  function first(tok) {
    var m = tok.match(/^\S+/);
    return m ? m[0] : "";
  }

  function detect(raw) {
    var v = String(raw == null ? "" : raw).trim();
    if (!v) return { command: false, reason: "empty" };
    var tok = first(v).toLowerCase();

    /* Step 1 -- conversational openers, before anything else. Compare the
       token with trailing punctuation stripped ("hi;" must find "hi", not
       come back as hard syntax). Everything after this keeps the RAW token:
       "git;" is still a command via the semicolon rule. */
    var stopTok = tok.replace(/[^a-z0-9-]+$/, "");
    if (STOP.indexOf(stopTok) >= 0) return { command: false, reason: "conversation" };

    /* Step 2 -- hard syntax a bare command line cannot be missing. */
    if (RE_FLAG.test(v) || RE_ANGLE.test(v) || RE_PIPE.test(v) || RE_SEMI.test(v)
        || RE_STAR.test(v) || RE_ASSIGN.test(v) || RE_CALLOP.test(v)
        || RE_OPEN.test(v)) {
      return { command: true, reason: "syntax" };
    }

    /* Step 3 -- cmdlet families (dash required). */
    if (FAMILY.test(tok)) return { command: true, reason: "cmdlet" };

    /* Step 4 -- exact-token alias / CLI names. */
    if (ALIAS.indexOf(tok) >= 0 || CLI.indexOf(tok) >= 0) {
      return { command: true, reason: "name" };
    }

    /* Step 5 -- program / path shapes. */
    if (v.indexOf("\\") >= 0 || v.indexOf("/") >= 0
        || RE_EXT.test(tok) || /^\.{1,2}$/.test(tok)) {
      return { command: true, reason: "path" };
    }

    /* Step 6 -- everything else is Ade's. */
    return { command: false, reason: "prose" };
  }

  return { detect: detect };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = ADE_TERMINAL_DETECT;
}
if (typeof window !== "undefined") {
  window.DetectCommandLine = ADE_TERMINAL_DETECT.detect;
}