(function (root) {
  'use strict';
  var wordPattern = /[^\s"'&|<>;,]+/g;
  var eligibleCommand = /^[a-z\d][a-z\d_.-]{0,63}$/i;
  var examples = [
    ['iperf3 client', 'iperf3 -c {{HOST}} -t {{SECONDS}}', ['192.0.2.10', '30']],
    ['iperf client', 'iperf -c {{HOST}} -t {{SECONDS}}', ['192.0.2.10', '30']],
    ['ADB 裝置 Shell', 'adb -s {{SERIAL}} shell', ['DEVICE_SERIAL']],
    ['scrcpy 指定裝置', 'scrcpy -s {{SERIAL}}', ['DEVICE_SERIAL']],
    ['IPv6 Ping', 'ping -6 {{HOST}}', ['2001:db8::10']]
  ];

  function tokenize(text) { return Array.from(text.matchAll(wordPattern)); }
  function distance(a, b) {
    var previous, row = Array.from({ length: b.length + 1 }, function (_, j) { return j; });
    for (var i = 1; i <= a.length; i++) {
      var older = previous;
      previous = row; row = [i];
      for (var j = 1; j <= b.length; j++) {
        row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        if (older && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) row[j] = Math.min(row[j], older[j - 2] + 1);
      }
    }
    return row[b.length];
  }
  function rank(query, value, fuzzy) {
    var q = query.toLowerCase(), v = value.toLowerCase();
    if (v === q) return 0;
    if (v.startsWith(q)) return 10;
    if (!fuzzy || q.length < 3 || q.length > 40 || !/^[\p{L}\p{N}_-]+$/u.test(q) || !/^[\p{L}\p{N}_-]+$/u.test(v)) return Infinity;
    var max = q.length >= 6 ? 2 : 1;
    if (Math.abs(v.length - q.length) > max) return Infinity;
    var edits = distance(q, v);
    return edits <= max ? 30 + edits : Infinity;
  }
  function argumentsFrom(command) {
    var tokens = tokenize(command);
    return tokens.slice(1).map(function (t) { return t[0]; }).filter(function (word) {
      return /^--?[a-z][\w-]*$/i.test(word) || /^[a-z][a-z\d-]{1,30}$/i.test(word) && word === word.toLowerCase();
    });
  }
  function snippet(example) {
    var fields = [], value = '', prev = 0;
    for (var match of example[1].matchAll(/\{\{[A-Z]+\}\}/g)) {
      value += example[1].slice(prev, match.index);
      var field = example[2][fields.length];
      fields.push({ start: value.length, end: value.length + field.length });
      value += field; prev = match.index + match[0].length;
    }
    return { value: value + example[1].slice(prev), fields: fields };
  }
  function suggestions(context, sources, explicit) {
    var text = context.value, start = context.start, end = context.end, selected = start !== end;
    if (!selected) {
      var hit = tokenize(text).find(function (token) { return token.index < start && token.index + token[0].length >= start; });
      if (hit) { end = hit.index + hit[0].length; start = hit.index; }
    }
    if (!selected && !explicit && end !== context.start) return [];
    var query = context.query || (selected ? text.slice(start, end) : text.slice(start, context.start));
    if (!explicit && (query.length < 2 || query.length > 80)) return [];
    if (query.length > 128) return [];
    var before = text.slice(0, start), first = before.trim() === '';
    var command = (tokenize(before)[0] || [''])[0].toLowerCase();
    var results = [];
    function add(value, source, score, from, to, fields, label) {
      if (!Number.isFinite(score) || !value || /[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(value) ||
          value === text.slice(from, to) || text.length - (to - from) + value.length > 16000) return;
      results.push({ value: value, source: source, score: score, start: from, end: to, fields: fields, label: label || value });
    }
    if (first || context.replaceOnly) sources.commands.heads.forEach(function (head) {
      add(head, '指令庫', rank(query, head, true), start, end);
    });
    if (!first && !context.replaceOnly) (sources.commands.args.get(command) || []).forEach(function (word) {
      add(word, '指令庫', rank(query, word, true), start, end);
    });
    sources.history.forEach(function (line) {
      if (!context.replaceOnly && !selected && context.start === text.length && text.length &&
          line.toLowerCase().startsWith(text.trimStart().toLowerCase())) add(line, '歷史指令', 7, 0, text.length);
      if (!context.replaceOnly && first && !text.slice(end).trim() && explicit) {
        var head = (tokenize(line)[0] || [''])[0];
        add(line, '歷史指令', rank(query, head, true) + 4, start, end);
      }
      var tokens = tokenize(line);
      var words = context.replaceOnly || selected ? tokens : first ? tokens.slice(0, 1) :
        (tokens[0] && tokens[0][0].toLowerCase() === command ? tokens.slice(1) : []);
      words.forEach(function (word) { add(word[0], '歷史用詞', rank(query, word[0], true) - 1, start, end); });
    });
    if (!first || selected || context.replaceOnly || explicit) sources.values.forEach(function (item) {
      var score = rank(query, item.address, false) + 1;
      if (!Number.isFinite(score) && explicit && (selected || context.replaceOnly)) score = 80;
      add(item.address, '暫存值', score, start, end);
    });
    if (context.snippets && !selected && first && !text.slice(end).trim()) examples.forEach(function (example) {
      var item = snippet(example), head = tokenize(item.value)[0][0];
      add(item.value, '範本', rank(query, head, false) + 3, start, end, item.fields, example[0]);
    });
    var seen = new Set();
    return results.sort(function (a, b) { return a.score - b.score; }).filter(function (item) {
      var key = item.start + ':' + item.end + ':' + item.value;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    }).slice(0, 8);
  }
  function catalog(lines) {
    var heads = new Set(), args = new Map();
    lines.forEach(function (line) {
      var head = (tokenize(line)[0] || [''])[0];
      if (!eligibleCommand.test(head)) return;
      heads.add(head);
      var key = head.toLowerCase();
      if (!args.has(key)) args.set(key, new Set());
      argumentsFrom(line).forEach(function (word) { args.get(key).add(word); });
    });
    return { heads: heads, args: args };
  }

  function createMenu(doc) {
    var owner = null, items = [], active = 0, context = null, holding = '';
    var menu = doc.createElement('div');
    menu.id = 'completionMenu'; menu.className = 'completion-menu'; menu.hidden = true;
    var list = doc.createElement('ul');
    list.id = 'completionOptions'; list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', '指令建議');
    var hint = doc.createElement('p');
    menu.append(list, hint); doc.body.append(menu);
    function close(target) {
      if (target && owner !== target) return;
      if (owner) {
        owner.input.removeAttribute('aria-activedescendant');
        owner.input.removeAttribute('aria-controls');
      }
      owner = null; context = null; items = []; menu.hidden = true; list.replaceChildren();
    }
    function select(index) {
      active = (index + items.length) % items.length;
      Array.from(list.children).forEach(function (row, i) { row.setAttribute('aria-selected', String(i === active)); });
      owner.input.setAttribute('aria-activedescendant', list.children[active].id);
      list.children[active].scrollIntoView({ block: 'nearest' });
    }
    function accept(index) {
      var target = owner, snapshot = context, item = items[index];
      close();
      if (target && item) target.apply(item, snapshot);
    }
    function show(target, snapshot, choices) {
      close();
      if (!choices.length || doc.activeElement !== target.input || !target.input.getClientRects().length) return false;
      owner = target; context = snapshot; items = choices;
      hint.textContent = target.tabOnly && !target.explicit ? '↑ ↓ 選擇 · Tab 套用 · Esc 關閉' : '↑ ↓ 選擇 · Tab／Enter 套用 · Esc 關閉';
      target.input.setAttribute('aria-controls', list.id);
      choices.forEach(function (item, index) {
        var row = doc.createElement('li'), label = doc.createElement('span'), badge = doc.createElement('small');
        row.id = 'completion-option-' + index; row.setAttribute('role', 'option');
        label.textContent = item.label; badge.textContent = item.score >= 29 && item.score < 40 ? '拼字建議 · ' + item.source : item.source;
        row.title = item.value;
        row.append(label, badge);
        row.addEventListener('pointerdown', function (event) { event.preventDefault(); });
        row.addEventListener('click', function (event) { event.stopPropagation(); accept(index); });
        list.append(row);
      });
      var rect = target.anchor ? target.anchor() : target.input.getBoundingClientRect();
      menu.style.width = Math.min(420, Math.max(240, rect.width), root.innerWidth - 16) + 'px';
      menu.hidden = false;
      menu.style.left = Math.max(8, Math.min(rect.left, root.innerWidth - menu.offsetWidth - 8)) + 'px';
      var above = rect.bottom + menu.offsetHeight + 8 > root.innerHeight && rect.top >= menu.offsetHeight;
      menu.style.top = Math.max(8, Math.min(above ? rect.top - menu.offsetHeight - 4 : rect.bottom + 4, root.innerHeight - menu.offsetHeight - 8)) + 'px';
      select(0);
      return true;
    }
    function consume(event) { event.preventDefault(); event.stopImmediatePropagation(); }
    // Consume acceptance key repeats even after closing the list, so holding
    // Enter cannot submit the command that was just filled in.
    function key(event, target) {
      if (event.isComposing || event.keyCode === 229) return false;
      if (event.type === 'keyup') { if (holding === event.key) holding = ''; return false; }
      if (!event.repeat) holding = '';
      if (event.repeat && holding === event.key) { consume(event); return true; }
      if (owner !== target || event.type !== 'keydown') return false;
      var k = event.key;
      if (k === 'Escape') { consume(event); close(); return true; }
      if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return false;
      if (k === 'ArrowDown' || k === 'ArrowUp') { consume(event); select(active + (k === 'ArrowDown' ? 1 : -1)); return true; }
      if (k === 'Enter' && target.tabOnly && !target.explicit) { close(target); return false; }
      if (k === 'Enter' || k === 'Tab') { consume(event); holding = k; if (!event.repeat) accept(active); return true; }
      if (['Home', 'End', 'ArrowLeft', 'ArrowRight'].includes(k)) close(target);
      return false;
    }
    doc.addEventListener('pointerdown', function (event) { if (owner && owner.input !== event.target && !menu.contains(event.target)) close(); }, true);
    root.addEventListener('resize', function () { close(); });
    return { show: show, close: close, key: key,
      hasInput: function (input) { return !!owner && owner.input === input; }, contains: function (node) { return menu.contains(node); } };
  }
  function attachEditor(input, options) {
    var menu = options.menu, composing = false, applying = false, fields = [], fieldIndex = -1, before = null;
    function snapshot() {
      return { value: input.value, start: input.selectionStart, end: input.selectionEnd,
        replaceOnly: options.replaceOnly, snippets: options.snippets, query: !input.value ? options.initialQuery : '' };
    }
    var target = { input: input, apply: function (item, saved) {
      if (input.value !== saved.value || input.selectionStart !== saved.start || input.selectionEnd !== saved.end) return;
      fields = []; fieldIndex = -1; applying = true;
      var applied = options.apply(item.value, item.start, item.end);
      applying = false;
      if (!applied || !item.fields) return;
      fields = item.fields.map(function (field) { return { start: item.start + field.start, end: item.start + field.end }; });
      fieldIndex = 0;
      input.setSelectionRange(fields[0].start, fields[0].end);
    } };
    function offer(explicit) {
      if (composing || input.disabled || input.readOnly || !options.enabled() || options.isMenuOpen && options.isMenuOpen()) return;
      var saved = snapshot();
      menu.show(target, saved, suggestions(saved, options.sources(), explicit));
    }
    function onKey(event) {
      if (event.isComposing || composing || event.keyCode === 229) return;
      if (event.type === 'keydown' && event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey && event.code === 'Space') {
        event.preventDefault(); event.stopImmediatePropagation(); offer(true); return;
      }
      if (menu.key(event, target) || event.type !== 'keydown') return;
      if (fieldIndex >= 0 && event.key === 'Tab' && !event.ctrlKey && !event.altKey && !event.metaKey) {
        event.preventDefault(); event.stopImmediatePropagation();
        if (event.repeat) return;
        fieldIndex = Math.max(0, fieldIndex + (event.shiftKey ? -1 : 1));
        if (fieldIndex < fields.length) input.setSelectionRange(fields[fieldIndex].start, fields[fieldIndex].end);
        else {
          var end = fields[fields.length - 1].end;
          fields = []; fieldIndex = -1; input.setSelectionRange(end, end);
        }
      }
      if (event.key === 'Escape' && fieldIndex >= 0) {
        event.preventDefault(); event.stopImmediatePropagation(); fields = []; fieldIndex = -1;
      }
    }
    function onBeforeInput() { before = snapshot(); }
    function onInput(event) {
      menu.close(target);
      if (applying) return;
      if (fieldIndex >= 0) {
        var field = fields[fieldIndex];
        if (before && before.start >= field.start && before.end <= field.end &&
            input.value.startsWith(before.value.slice(0, field.start)) && input.value.endsWith(before.value.slice(field.end)) &&
            !/^history/i.test(event.inputType || '')) {
          var delta = input.value.length - before.value.length;
          field.end += delta;
          for (var i = fieldIndex + 1; i < fields.length; i++) { fields[i].start += delta; fields[i].end += delta; }
        } else { fields = []; fieldIndex = -1; }
        before = null;
        return;
      }
      if (event.isComposing || !['insertText', 'insertCompositionText', 'deleteContentBackward', 'deleteContentForward'].includes(event.inputType)) return;
      offer(false);
    }
    function onClick() {
      menu.close(target);
      if (fieldIndex >= 0 && (input.selectionStart < fields[fieldIndex].start || input.selectionEnd > fields[fieldIndex].end)) {
        fields = []; fieldIndex = -1;
      }
    }
    function onBlur() { menu.close(target); fields = []; fieldIndex = -1; composing = false; }
    function startComposition() { composing = true; menu.close(target); }
    function endComposition() { composing = false; if (fieldIndex < 0) offer(false); }
    var listeners = { keydown: onKey, keyup: onKey, beforeinput: onBeforeInput, input: onInput,
      click: onClick, blur: onBlur, compositionstart: startComposition, compositionend: endComposition };
    Object.keys(listeners).forEach(function (name) { input.addEventListener(name, listeners[name], true); });
    return { offer: offer, dispose: function () {
      onBlur();
      Object.keys(listeners).forEach(function (name) { input.removeEventListener(name, listeners[name], true); });
    } };
  }
  root.TerminalGridCompletion = { suggestions: suggestions, catalog: catalog, createMenu: createMenu, attachEditor: attachEditor };
}(typeof window === 'undefined' ? globalThis : window));
