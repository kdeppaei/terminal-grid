(function (root) {
  'use strict';
  // Screen coordinates are only editable within the current standard shell
  // prompt. Historical output, alternate screens and stale snapshots never
  // become a sequence of terminal editing keys.
  function create(terminal, options) {
    var revision = 0, pending = 0, waitingEcho = false, epoch = 0, inputRevision = 0, unavailableMessage = '', expectedEdit = null;
    function reset() { revision++; epoch++; pending = 0; waitingEcho = false; expectedEdit = null; }
    function read() {
      unavailableMessage = '';
      var buffer = terminal.buffer.active;
      if (buffer.type !== 'normal' || pending || waitingEcho || !options.isRunning()) return null;
      if (['CMD', 'PowerShell', 'PowerShell 7'].indexOf(options.getShell()) < 0) return null;
      var cursorRow = buffer.baseY + buffer.cursorY, first = cursorRow, last = cursorRow;
      while (first > 0 && buffer.getLine(first).isWrapped) first--;
      while (last + 1 < buffer.length && buffer.getLine(last + 1).isWrapped) last++;
      if ((last - first + 1) * terminal.cols > 20000) return null;
      var text = '', occupiedEnd = 0, points = Object.create(null), cells = [];
      for (var row = first; row <= last; row++) {
        var line = buffer.getLine(row);
        if (!line) return null;
        for (var x = 0; x < terminal.cols; x++) {
          var cell = line.getCell(x);
          if (!cell || cell.getWidth() === 0) continue;
          points[row + ':' + x] = text.length;
          var chars = cell.getChars();
          cells.push({ offset: text.length, chars: chars, prediction: !!(cell.isDim && cell.isItalic && cell.isDim() && cell.isItalic()) });
          text += chars || ' ';
          if (chars) occupiedEnd = text.length;
        }
        points[row + ':' + terminal.cols] = text.length;
      }
      var cursor = points[cursorRow + ':' + buffer.cursorX];
      if (cursor === undefined) return null;
      // PSReadLine's inline suggestion is rendered after the caret using dim
      // italic cells. It is not part of the command and must never be rebuilt
      // into real input (or accepted as a selected editable range).
      if (options.getShell() !== 'CMD' || text.indexOf('PS ') === 0) {
        var ghost = cells.findIndex(function (c) { return c.offset >= cursor && c.chars && c.prediction; });
        if (ghost >= 0 && cells.slice(ghost).every(function (c) { return !c.chars || c.chars === ' ' || c.prediction; })) {
          text = text.slice(0, cells[ghost].offset); occupiedEnd = Math.min(occupiedEnd, text.length);
        }
      }
      text = text.replace(/ +$/, '');
      if (text.length < cursor) text += ' '.repeat(cursor - text.length);
      // ConPTY uses literal spaces both for typed whitespace and for clearing
      // deleted characters. Beyond the cursor these have no reliable extent.
      // Never infer a longer/shorter command and risk deleting other text.
      var verifiedEdit = expectedEdit && expectedEdit.first === first && expectedEdit.cols === terminal.cols && expectedEdit.values.some(function (v) { return v.text === text && v.cursor === cursor; });
      if (verifiedEdit) expectedEdit.values = [{ text: text, cursor: cursor }];
      if (occupiedEnd > text.length && !verifiedEdit) {
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
      // ConPTY leaves literal erase-spaces after a shorter edit. Accept them
      // only when the full text AND caret match this exact edit's expected echo.
      var edited = current.command.slice(0, saved.start) + value + suffix;
      expectedEdit = { values: [{ text: current.prefix + edited, cursor: current.prefix.length + saved.start + value.length }], first: current.first, cols: current.cols, prefix: current.prefix.length };
      terminal.clearSelection(); terminal.focus();
      return { ok: true, command: current.command.slice(0, saved.start) + value + current.command.slice(saved.end) };
    }
    return { capture: capture, replace: replace, reset: reset,
      getUnavailableMessage: function () { return unavailableMessage; },
      input: function (data) {
        var known = read();
        if (known) expectedEdit = { values: [{ text: known.prefix + known.command, cursor: known.prefix.length + known.cursor }], first: known.first, cols: known.cols, prefix: known.prefix.length };
        // Follow ordinary ASCII typing after our edit. Both insert and overwrite
        // modes are possible; the next screen read must match an exact candidate.
        if (expectedEdit) {
          var values = [], prefix = expectedEdit.prefix;
          expectedEdit.values.forEach(function (v) {
            var c = v.cursor, t = v.text;
            if (typeof data === 'string' && /^[\x20-\x7e]+$/.test(data)) {
              values.push({ text: t.slice(0, c) + data + t.slice(c), cursor: c + data.length });
              values.push({ text: t.slice(0, c) + data + t.slice(c + data.length), cursor: c + data.length });
            } else if (data === '\x1b[D') values.push({ text: t, cursor: Math.max(prefix, c - 1) });
            else if (data === '\x1b[C') values.push({ text: t, cursor: Math.min(t.length, c + 1) });
            else if (data === '\x7f' && c > prefix) values.push({ text: t.slice(0, c - 1) + t.slice(c), cursor: c - 1 });
            else if (data === '\x1b[3~') values.push({ text: t.slice(0, c) + t.slice(c + 1), cursor: c });
          });
          values = values.filter(function (v, i) { return values.findIndex(function (other) { return other.text === v.text && other.cursor === v.cursor; }) === i; });
          if (values.length && values.length <= 16) expectedEdit.values = values; else expectedEdit = null;
        }
        revision++; inputRevision++; waitingEcho = true;
      },
      output: function () { revision++; pending++; return { epoch: epoch, input: inputRevision, done: false }; },
      parsed: function (token) {
        if (!token || token.epoch !== epoch || token.done) return;
        token.done = true; pending = Math.max(0, pending - 1);
        // An older queued write cannot acknowledge input that happened after it.
        if (token.input === inputRevision) waitingEcho = false;
      },
      resize: function () { revision++; expectedEdit = null; },
      invalidate: function () { revision++; }
    };
  }
  root.TerminalGridLiveReplace = { create: create };
}(window));
