(function (root) {
  'use strict';

  var MAX_LENGTH = 16000;
  var CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
  var nextMenuId = 0;

  function isSingleLine(value) {
    return typeof value === 'string' && value.length <= MAX_LENGTH && !CONTROL_CHARACTERS.test(value);
  }

  function valueType(value) {
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value) && value.split('.').every(function (part) { return Number(part) <= 255; })) return 'ipv4';
    if (/^[0-9a-f:.]+(?:%[a-z0-9_.-]+)?$/i.test(value) && (value.match(/:/g) || []).length >= 2) return 'ipv6';
    return 'text';
  }

  function attach(input, options) {
    options = options || {};
    if (!input || typeof input.setSelectionRange !== 'function') throw new TypeError('Text editing requires a text input or textarea.');
    var doc = input.ownerDocument;
    var selection = null, dragging = false, disposed = false, revision = 0;
    var listeners = [];
    input.maxLength = MAX_LENGTH;
    var menu = doc.createElement('div');
    menu.id = options.menuId || 'text-edit-menu-' + (++nextMenuId);
    menu.className = 'text-edit-menu';
    menu.hidden = true;
    menu.setAttribute('role', 'dialog');
    menu.setAttribute('aria-label', '編輯文字與替換');
    doc.body.appendChild(menu);

    function status(message, error) {
      if (typeof options.onStatus === 'function') options.onStatus(message, !!error);
    }
    function listen(target, type, action, capture) {
      target.addEventListener(type, action, !!capture);
      listeners.push(function () { target.removeEventListener(type, action, !!capture); });
    }
    function element(tag, className, text) {
      var node = doc.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    }
    function rememberSelection() {
      if (disposed || dragging) return;
      selection = { start: input.selectionStart, end: input.selectionEnd, value: input.value, revision: revision };
    }
    function currentSelection() {
      if (doc.activeElement === input && !dragging) rememberSelection();
      if (!selection || selection.value !== input.value || selection.end > input.value.length) rememberSelection();
      return selection;
    }
    function hasSelection() {
      var saved = currentSelection();
      return !!saved && saved.end > saved.start;
    }
    function closeMenu() {
      menu.hidden = true;
      if (typeof options.onMenuChange === 'function') options.onMenuChange(false);
    }
    function isCurrent(saved) {
      return !disposed && input.isConnected && !input.disabled && !input.readOnly && input.getClientRects().length > 0 &&
        saved && saved.value === input.value && saved.revision === revision;
    }
    function snapshot() {
      if (disposed || !input.isConnected || input.disabled || input.readOnly) return null;
      var saved = currentSelection();
      return saved && { start: saved.start, end: saved.end, value: saved.value, revision: revision };
    }
    function validInsertion(value, saved) {
      if (!isSingleLine(value)) {
        status('請只使用單行文字，不可含換行或控制字元，且最多 16,000 個字元。', true);
        return false;
      }
      if (saved.value.length - (saved.end - saved.start) + value.length > MAX_LENGTH) {
        status('編輯後超過 16,000 個字元，請縮短文字。', true);
        return false;
      }
      return true;
    }
    function applyInsertion(value, saved, selectInserted) {
      if (!isCurrent(saved)) {
        status('內容已變更，請重新選取位置後再貼上。', true);
        return false;
      }
      if (!validInsertion(value, saved)) return false;
      var expected = saved.value.slice(0, saved.start) + value + saved.value.slice(saved.end);
      closeMenu();
      input.focus();
      if (doc.activeElement !== input) { status('輸入列目前無法編輯，請切回原本的終端再操作。', true); return false; }
      input.setSelectionRange(saved.start, saved.end);
      var beforeRevision = revision;
      // WebView2 supports insertText and keeps the native undo history. The
      // fallback also notifies consumers when a browser does not support it.
      try { doc.execCommand('insertText', false, value); } catch (_) { }
      if (input.value !== expected) {
        input.value = saved.value;
        input.setSelectionRange(saved.start, saved.end);
        input.setRangeText(value, saved.start, saved.end, 'end');
      }
      if (revision === beforeRevision) input.dispatchEvent(new Event('input', { bubbles: true }));
      input.setSelectionRange(selectInserted ? saved.start : saved.start + value.length, saved.start + value.length);
      rememberSelection();
      return true;
    }
    function insert(value, requireSelection) {
      var saved = snapshot();
      if (!saved) return false;
      if (requireSelection && saved.start === saved.end) {
        status('請先在指令中選取要替換的文字，例如 ping 後面的 A。', true);
        return false;
      }
      return applyInsertion(value, saved, saved.end > saved.start);
    }
    async function copy(cut) {
      var saved = snapshot();
      if (!saved || saved.start === saved.end) { status('請先選取要複製的文字。'); return; }
      try {
        await root.navigator.clipboard.writeText(saved.value.slice(saved.start, saved.end));
        if (cut) applyInsertion('', saved, false);
        else { closeMenu(); status('已複製選取文字。'); }
      } catch (_) { status('無法使用剪貼簿，請檢查系統權限。', true); }
    }
    async function paste() {
      var saved = snapshot();
      if (!saved) return;
      try {
        var value = await root.navigator.clipboard.readText();
        applyInsertion(value, saved, false);
      } catch (_) { status('無法讀取剪貼簿，請檢查系統權限。', true); }
    }
    function addAction(parent, label, action, disabled) {
      var button = element('button', 'text-edit-action', label);
      button.type = 'button'; button.disabled = !!disabled;
      button.addEventListener('click', action);
      parent.appendChild(button);
      return button;
    }
    function openMenu(event) {
      if (disposed) return;
      var saved = snapshot();
      if (!saved) return;
      menu.replaceChildren();
      var actions = element('div', 'text-edit-actions');
      var selected = saved.end > saved.start;
      addAction(actions, '複製', function () { copy(false); }, !selected);
      addAction(actions, '剪下', function () { copy(true); }, !selected);
      addAction(actions, '貼上', paste);
      addAction(actions, '全選', function () { closeMenu(); input.focus(); input.select(); rememberSelection(); });
      menu.appendChild(actions);
      var label = element('label', 'text-edit-label', selected ? '將選取文字替換成' : '在游標位置插入');
      var replacement = element('input', 'text-edit-replacement');
      replacement.type = 'text'; replacement.maxLength = MAX_LENGTH;
      replacement.placeholder = selected ? '輸入新的文字' : '輸入要插入的文字';
      replacement.setAttribute('aria-label', selected ? '替換文字' : '插入文字');
      replacement.spellcheck = false;
      label.appendChild(replacement);
      menu.appendChild(label);
      var apply = addAction(menu, selected ? '取代選取文字' : '插入文字', function () { insert(replacement.value, false); });
      apply.classList.add('text-edit-apply');
      replacement.addEventListener('keydown', function (keyEvent) {
        if (keyEvent.key === 'Enter') { keyEvent.preventDefault(); keyEvent.stopPropagation(); if (!keyEvent.isComposing && !keyEvent.repeat) insert(replacement.value, false); }
      });
      var type = selected ? valueType(saved.value.slice(saved.start, saved.end)) : null;
      var values = [];
      try { values = typeof options.getValues === 'function' ? options.getValues() : []; }
      catch (_) { status('無法讀取暫存值，請稍後再試。', true); }
      if (!Array.isArray(values)) values = [];
      var seen = Object.create(null);
      values = values.filter(function (item) {
        if (!item || !isSingleLine(item.address) || !item.address || seen[item.address]) return false;
        seen[item.address] = true; return true;
      }).slice(0, 128).map(function (item, index) { return { item: item, index: index }; }).sort(function (a, b) {
        var aMatch = type && valueType(a.item.address) === type ? 0 : 1;
        var bMatch = type && valueType(b.item.address) === type ? 0 : 1;
        return aMatch - bMatch || a.index - b.index;
      }).map(function (entry) { return entry.item; });
      menu.appendChild(element('p', 'text-edit-label', selected ? '最近暫存值 · 同類型優先' : '最近暫存值'));
      if (!values.length) menu.appendChild(element('p', 'text-edit-empty', '目前沒有暫存值，可在上方直接輸入。'));
      values.forEach(function (item) {
        var button = element('button', 'text-edit-suggestion');
        button.type = 'button';
        button.appendChild(element('span', 'text-edit-value', item.address));
        if (typeof item.source === 'string' && item.source) button.appendChild(element('span', 'text-edit-source', item.source.slice(0, 300)));
        button.addEventListener('click', function () { insert(item.address, false); });
        menu.appendChild(button);
      });
      menu.hidden = false;
      var rect = input.getBoundingClientRect();
      var width = Math.max(180, Math.min(370, root.innerWidth - 16));
      menu.style.width = width + 'px';
      menu.style.left = Math.max(8, Math.min(event ? event.clientX : rect.left, root.innerWidth - width - 8)) + 'px';
      menu.style.top = '8px';
      var height = menu.getBoundingClientRect().height;
      menu.style.top = Math.max(8, Math.min(event ? event.clientY : rect.bottom + 4, root.innerHeight - height - 8)) + 'px';
      if (typeof options.onMenuChange === 'function') options.onMenuChange(true);
      replacement.focus();
    }

    listen(input, 'select', function () { if (doc.activeElement === input) rememberSelection(); });
    listen(input, 'keyup', rememberSelection);
    listen(input, 'mouseup', rememberSelection);
    listen(input, 'blur', rememberSelection);
    listen(input, 'input', function () { revision++; rememberSelection(); closeMenu(); });
    listen(input, 'keydown', function (event) {
      var code = event.code || (event.key && 'Key' + event.key.toUpperCase());
      var copyKey = event.ctrlKey && event.shiftKey && !event.altKey && code === 'KeyC';
      var pasteKey = event.ctrlKey && event.shiftKey && !event.altKey && code === 'KeyV';
      var insertKey = event.shiftKey && !event.ctrlKey && !event.altKey && event.key === 'Insert';
      if (copyKey || pasteKey || insertKey) {
        event.preventDefault(); event.stopImmediatePropagation();
        if (!event.repeat && !event.isComposing) { if (copyKey) copy(false); else paste(); }
      } else if (event.key === 'Escape') closeMenu();
    });
    listen(input, 'beforeinput', function (event) {
      if (event.inputType === 'insertLineBreak' || event.inputType === 'insertParagraph') event.preventDefault();
    });
    listen(input, 'paste', function (event) {
      var saved = snapshot();
      if (!event.clipboardData) { event.preventDefault(); event.stopImmediatePropagation(); paste(); return; }
      var value = event.clipboardData.getData('text/plain');
      if (!saved || !validInsertion(value, saved)) event.preventDefault();
      // Valid native paste is intentionally handled only by the browser, with
      // its own selection, composition and undo behavior.
      event.stopPropagation();
    });
    listen(input, 'mousedown', function (event) { if (event.button === 2) { rememberSelection(); event.preventDefault(); } });
    listen(input, 'contextmenu', function (event) { event.preventDefault(); event.stopPropagation(); openMenu(event); });
    listen(input, 'dragenter', function (event) {
      event.preventDefault(); event.stopPropagation();
      if (!dragging) rememberSelection();
      dragging = true; input.classList.add('is-value-drop');
    });
    listen(input, 'dragover', function (event) { event.preventDefault(); event.stopPropagation(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'; });
    listen(input, 'dragleave', function () { dragging = false; input.classList.remove('is-value-drop'); });
    listen(input, 'drop', function (event) {
      event.preventDefault(); event.stopPropagation();
      input.classList.remove('is-value-drop'); dragging = true;
      var transfer = event.dataTransfer;
      if (transfer && transfer.files && transfer.files.length) status('請拖入暫存文字；輸入列不接受檔案。', true);
      else {
        var value = transfer ? transfer.getData('application/x-terminalgrid-value') || transfer.getData('application/x-terminalgrid-command') || transfer.getData('text/plain') : '';
        if (value) insert(value, false);
      }
      dragging = false; rememberSelection();
    });
    listen(doc, 'dragend', function () { dragging = false; input.classList.remove('is-value-drop'); });
    listen(doc, 'pointerdown', function (event) {
      if (!menu.hidden && !menu.contains(event.target) && event.target !== input &&
          !(options.menuToggle && options.menuToggle.contains(event.target))) closeMenu();
    });
    listen(doc, 'keydown', function (event) {
      if (!menu.hidden && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenu(); input.focus(); }
    });
    listen(menu, 'keydown', function (event) {
      if (event.target.tagName === 'INPUT' || ['ArrowDown', 'ArrowUp', 'Home', 'End'].indexOf(event.key) < 0) return;
      var buttons = Array.prototype.slice.call(menu.querySelectorAll('button:not(:disabled)'));
      if (!buttons.length) return;
      var index = buttons.indexOf(doc.activeElement);
      event.preventDefault();
      if (event.key === 'Home') index = 0;
      else if (event.key === 'End') index = buttons.length - 1;
      else index = (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[index].focus();
    });
    rememberSelection();
    return {
      insert: insert, hasSelection: hasSelection, openMenu: openMenu, closeMenu: closeMenu,
      isMenuOpen: function () { return !menu.hidden; }, rememberSelection: rememberSelection,
      dispose: function () { disposed = true; listeners.forEach(function (remove) { remove(); }); listeners = []; menu.remove(); }
    };
  }

  root.TerminalGridTextEdit = { attach: attach, isSingleLine: isSingleLine };
}(window));
