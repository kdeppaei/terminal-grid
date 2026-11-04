(function (root) {
  'use strict';
  // Screen coordinates are only editable within the current standard shell
  // prompt. Historical output, alternate screens and stale snapshots never
  // become a sequence of terminal editing keys.
  function create(terminal, options) {
    var revision = 0, pending = 0, waitingEcho = false, epoch = 0, inputRevision = 0, unavailableMessage = '';
    function reset() { revision++; epoch++; pending = 0; waitingEcho = false; }
    function read() {
      unavailableMessage = '';
      var buffer = terminal.buffer.active;
      if (buffer.type !== 'normal' || pending || waitingEcho || !options.isRunning()) return null;
      if (['CMD', 'PowerShell', 'PowerShell 7'].indexOf(options.getShell()) < 0) return null;
      var cursorRow = buffer.baseY + buffer.cursorY, first = cursorRow, last = cursorRow;
      while (first > 0 && buffer.getLine(first).isWrapped) first--;
      while (last + 1 < buffer.length && buffer.getLine(last + 1).isWrapped) last++;
      if ((last - first + 1) * terminal.cols > 20000) return null;
      var text = '', occupiedEnd = 0, points = Object.create(null);
      for (var row = first; row <= last; row++) {
        var line = buffer.getLine(row);
        if (!line) return null;
        for (var x = 0; x < terminal.cols; x++) {
          var cell = line.getCell(x);
          if (!cell || cell.getWidth() === 0) continue;
          points[row + ':' + x] = text.length;
          var chars = cell.getChars();
          text += chars || ' ';
          if (chars) occupiedEnd = text.length;
        }
        points[row + ':' + terminal.cols] = text.length;
      }
      var cursor = points[cursorRow + ':' + buffer.cursorX];
      if (cursor === undefined) return null;
      text = text.replace(/ +$/, '');
      if (text.length < cursor) text += ' '.repeat(cursor - text.length);
      // ConPTY uses literal spaces both for typed whitespace and for clearing
      // deleted characters. Beyond the cursor these have no reliable extent.
      // Never infer a longer/shorter command and risk deleting other text.
      if (occupiedEnd > text.length) {
        unavailableMessage = '無法確認指令尾端的空白範圍，請使用下方輸入列或草稿編輯。';
        return null;
      }
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
      // A rectangular selection can have the same bounds as a much larger
      // contiguous range. Only replace exactly the characters the user selected.
      if (terminal.getSelection() !== screen.command.slice(start, end)) return null;
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
        return { ok: false, message: unavailableMessage || '目前指令或游標已變更，請重新框選要替換的文字。' };
      }
      if (current.command.length - (saved.end - saved.start) + value.length > 16000) return { ok: false, message: '替換後指令超過 16,000 字元。' };
      // Rebuild the tail at the end of the input so CMD's Insert/overwrite mode
      // cannot overwrite the retained suffix. Restore the caret after the value.
      var suffix = current.command.slice(saved.end);
      var data = '\x1b[C'.repeat(current.command.length - current.cursor) +
        '\x7f'.repeat(current.command.length - saved.start) + value + suffix + '\x1b[D'.repeat(suffix.length);
      if (options.send(data) === false) return { ok: false, message: '無法連接終端引擎，文字尚未替換。' };
      terminal.clearSelection(); terminal.focus();
      return { ok: true, command: current.command.slice(0, saved.start) + value + current.command.slice(saved.end) };
    }
    return { capture: capture, replace: replace, reset: reset,
      getUnavailableMessage: function () { return unavailableMessage; },
      input: function () { revision++; inputRevision++; waitingEcho = true; },
      output: function () { revision++; pending++; return { epoch: epoch, input: inputRevision, done: false }; },
      parsed: function (token) {
        if (!token || token.epoch !== epoch || token.done) return;
        token.done = true; pending = Math.max(0, pending - 1);
        // An older queued write cannot acknowledge input that happened after it.
        if (token.input === inputRevision) waitingEcho = false;
      },
      resize: function () { revision++; },
      invalidate: function () { revision++; }
    };
  }
  root.TerminalGridLiveReplace = { create: create };
}(window));
