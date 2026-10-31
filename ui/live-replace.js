(function (root) {
  'use strict';
  // Screen coordinates are only editable within the current standard shell
  // prompt. Historical output, alternate screens and stale snapshots never
  // become a sequence of terminal editing keys.
  function create(terminal, options) {
    var revision = 0, pending = 0, waitingEcho = false;
    function reset() { revision++; pending = 0; waitingEcho = false; }
    function read() {
      var buffer = terminal.buffer.active;
      if (buffer.type !== 'normal' || pending || waitingEcho || !options.isRunning()) return null;
      if (['CMD', 'PowerShell', 'PowerShell 7'].indexOf(options.getShell()) < 0) return null;
      var cursorRow = buffer.baseY + buffer.cursorY, first = cursorRow, last = cursorRow;
      while (first > 0 && buffer.getLine(first).isWrapped) first--;
      while (last + 1 < buffer.length && buffer.getLine(last + 1).isWrapped) last++;
      if ((last - first + 1) * terminal.cols > 20000) return null;
      var text = '', points = Object.create(null);
      for (var row = first; row <= last; row++) {
        var line = buffer.getLine(row);
        if (!line) return null;
        for (var x = 0; x < terminal.cols; x++) {
          var cell = line.getCell(x);
          if (!cell || cell.getWidth() === 0) continue;
          points[row + ':' + x] = text.length;
          text += cell.getChars() || ' ';
        }
        points[row + ':' + terminal.cols] = text.length;
      }
      var cursor = points[cursorRow + ':' + buffer.cursorX];
      if (cursor === undefined) return null;
      text = text.replace(/ +$/, '');
      if (text.length < cursor) text += ' '.repeat(cursor - text.length);
      // Windows paths cannot contain >. Keep the actual prompt out of the
      // editable range, including CJK/wide characters in a folder name.
      var prompt = /^(?:PS )?(?:[A-Za-z]:\\|\\\\)[^>\r\n]*>/.exec(text);
      if (!prompt) return null;
      var prefix = prompt[0];
      if (prefix.indexOf('PS ') === 0 && text[prefix.length] === ' ') prefix += ' ';
      var command = text.slice(prefix.length), offset = cursor - prefix.length;
      // Cursor movement in CMD/PSReadLine differs for grapheme clusters. This
      // path deliberately supports ASCII commands; native editor stays Unicode.
      if (!command || command.length > 16000 || /[^\x20-\x7e]/.test(command) || offset < 0 || offset > command.length) return null;
      return { command: command, cursor: offset, prefix: prefix, first: first, cols: terminal.cols, points: points };
    }
    function capture() {
      var screen = read(), range = terminal.getSelectionPosition();
      if (!screen || !range || !terminal.hasSelection()) return null;
      var start = screen.points[range.start.y + ':' + range.start.x];
      var end = screen.points[range.end.y + ':' + range.end.x];
      if (start === undefined || end === undefined) return null;
      start -= screen.prefix.length; end -= screen.prefix.length;
      if (start < 0 || end <= start || end > screen.command.length) return null;
      return { revision: revision, generation: options.getGeneration(), command: screen.command,
        cursor: screen.cursor, prefix: screen.prefix, first: screen.first, cols: screen.cols,
        start: start, end: end, selected: screen.command.slice(start, end) };
    }
    function replace(saved, value) {
      if (typeof value !== 'string' || /[^\x20-\x7e]/.test(value) || value.length > 16000) {
        return { ok: false, message: '原位替換目前支援單行英文、數字及符號；其他文字請先在輸入列編輯。' };
      }
      var current = read();
      if (!saved || !current || saved.revision !== revision || saved.generation !== options.getGeneration() ||
          ['command', 'cursor', 'prefix', 'first', 'cols'].some(function (key) { return saved[key] !== current[key]; })) {
        return { ok: false, message: '目前指令或游標已變更，請重新框選要替換的文字。' };
      }
      if (current.command.length - (saved.end - saved.start) + value.length > 16000) return { ok: false, message: '替換後指令超過 16,000 字元。' };
      var movement = saved.end - current.cursor;
      var data = (movement < 0 ? '\x1b[D' : '\x1b[C').repeat(Math.abs(movement)) + '\x7f'.repeat(saved.end - saved.start) + value;
      if (options.send(data) === false) return { ok: false, message: '無法連接終端引擎，文字尚未替換。' };
      terminal.clearSelection(); terminal.focus();
      return { ok: true, command: current.command.slice(0, saved.start) + value + current.command.slice(saved.end) };
    }
    return { capture: capture, replace: replace, reset: reset,
      input: function () { revision++; waitingEcho = true; },
      output: function () { revision++; pending++; },
      parsed: function () { pending = Math.max(0, pending - 1); waitingEcho = false; },
      resize: function () { revision++; },
      invalidate: function () { revision++; }
    };
  }
  root.TerminalGridLiveReplace = { create: create };
}(window));
