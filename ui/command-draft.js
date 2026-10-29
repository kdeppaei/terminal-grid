(function (root) {
  'use strict';

  var MAX_LENGTH = 16000;
  var CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

  function isSingleLine(value) {
    return typeof value === 'string' && value.length <= MAX_LENGTH && !CONTROL_CHARACTERS.test(value);
  }

  function create(options) {
    if (!options || !options.container || typeof options.onSend !== 'function') {
      throw new TypeError('Command draft requires a container and onSend callback.');
    }
    var container = options.container;
    var doc = container.ownerDocument;
    var selection = null;
    var dragging = false;
    var busy = false;
    var section = doc.createElement('section');
    section.className = 'command-draft';
    section.hidden = true;
    section.setAttribute('aria-label', '指令草稿');

    function element(tag, className, text) {
      var node = doc.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    }

    function status(message, error) {
      if (typeof options.onStatus === 'function') options.onStatus(message, !!error);
    }

    var heading = element('div', 'command-draft-heading');
    var title = element('label', 'command-draft-title', '指令草稿');
    title.htmlFor = 'commandDraftText';
    var target = element('span', 'command-draft-target');
    target.id = 'commandDraftTarget';
    heading.appendChild(title);
    heading.appendChild(target);
    var closeButton = element('button', 'icon-button', '×');
    closeButton.type = 'button'; closeButton.setAttribute('aria-label', '收合指令草稿');
    closeButton.addEventListener('click', function () { closeMenu(); container.hidden = true; if (typeof options.onResize === 'function') options.onResize(); });
    heading.appendChild(closeButton);
    section.appendChild(heading);

    var input = element('textarea', 'command-draft-text');
    input.id = 'commandDraftText';
    input.rows = 3;
    input.maxLength = MAX_LENGTH;
    input.spellcheck = false;
    input.placeholder = '例如 ping A：先選取 A，再用暫存值取代。';
    input.setAttribute('aria-describedby', 'commandDraftHint');
    input.setAttribute('autocomplete', 'off');
    section.appendChild(input);

    var hint = element('p', 'command-draft-hint', '選取要替換的文字，再拖入暫存值，或按右鍵選擇。只編輯此份草稿；貼到終端後請自行按 Enter 執行。');
    hint.id = 'commandDraftHint';
    section.appendChild(hint);

    var actions = element('div', 'command-draft-actions');
    var valuesButton = element('button', 'button', '用暫存值替換');
    valuesButton.id = 'draftValuesButton';
    valuesButton.type = 'button';
    valuesButton.setAttribute('aria-haspopup', 'menu');
    valuesButton.setAttribute('aria-expanded', 'false');
    valuesButton.setAttribute('aria-controls', 'commandDraftValues');
    var sendButton = element('button', 'button primary', '貼到終端，不執行');
    sendButton.id = 'sendDraftButton';
    sendButton.type = 'button';
    actions.appendChild(valuesButton);
    actions.appendChild(sendButton);
    section.appendChild(actions);

    var menu = element('div', 'command-draft-menu');
    menu.id = 'commandDraftValues';
    menu.hidden = true;
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', '用暫存值替換選取文字');
    section.appendChild(menu);
    container.appendChild(section);

    function closeMenu() {
      menu.hidden = true;
      valuesButton.setAttribute('aria-expanded', 'false');
    }

    function rememberSelection() {
      if (dragging) return;
      selection = input.selectionEnd > input.selectionStart ? {
        start: input.selectionStart,
        end: input.selectionEnd,
        value: input.value
      } : null;
    }

    function hasSelection() {
      if (doc.activeElement === input && !dragging) rememberSelection();
      return !!selection && selection.value === input.value && selection.end <= input.value.length && selection.start < selection.end;
    }

    function updateSendState() {
      sendButton.disabled = busy || !input.value.trim() || !isSingleLine(input.value);
    }

    function replaceSelection(value) {
      if (!isSingleLine(value) || !value.length) {
        status('替換值必須是單行文字，不能含控制字元，且最多 16,000 個字元。', true);
        return false;
      }
      if (!hasSelection()) {
        status('請先在指令草稿中選取要替換的文字，例如 ping 後面的 A。', true);
        return false;
      }
      var start = selection.start;
      var end = selection.end;
      var next = input.value.slice(0, start) + value + input.value.slice(end);
      if (next.length > MAX_LENGTH) {
        status('替換後的指令超過 16,000 個字元，請縮短草稿。', true);
        return false;
      }
      closeMenu();
      input.value = next;
      input.focus();
      input.setSelectionRange(start, start + value.length);
      selection = { start: start, end: start + value.length, value: next };
      updateSendState();
      status('已替換選取文字；確認草稿後可貼到終端。');
      return true;
    }

    function openMenu() {
      hasSelection();
      menu.replaceChildren();
      var values = [];
      try { values = typeof options.getValues === 'function' ? options.getValues() : []; }
      catch (_) { status('無法讀取暫存值，請稍後再試。', true); }
      if (!Array.isArray(values)) values = [];
      values = values.filter(function (item) {
        return item && isSingleLine(item.address) && item.address.length;
      }).slice(0, 128);
      if (!values.length) {
        menu.appendChild(element('p', 'command-draft-menu-empty', '暫存區目前沒有可替換的值。'));
      }
      values.forEach(function (item) {
        var button = element('button', 'command-draft-value');
        button.type = 'button';
        button.setAttribute('role', 'menuitem');
        button.appendChild(element('span', 'command-draft-value-text', item.address));
        if (typeof item.source === 'string' && item.source) {
          button.appendChild(element('span', 'command-draft-value-source', item.source.slice(0, 300)));
        }
        button.title = '替換選取文字：' + item.address;
        button.addEventListener('click', function () { replaceSelection(item.address); });
        menu.appendChild(button);
      });
      menu.hidden = false;
      valuesButton.setAttribute('aria-expanded', 'true');
      var first = menu.querySelector('button');
      if (first) first.focus();
    }

    input.addEventListener('select', function () { if (doc.activeElement === input) rememberSelection(); });
    input.addEventListener('keyup', rememberSelection);
    input.addEventListener('mouseup', rememberSelection);
    input.addEventListener('blur', rememberSelection);
    input.addEventListener('input', function () {
      rememberSelection();
      closeMenu();
      updateSendState();
    });
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') closeMenu();
      if (event.key === 'Enter') {
        event.preventDefault();
        status('草稿只接受單行指令；請使用「貼到終端，不執行」。');
      }
    });
    input.addEventListener('mousedown', function (event) {
      if (event.button === 2 && hasSelection()) event.preventDefault();
    });
    input.addEventListener('contextmenu', function (event) {
      event.preventDefault();
      event.stopPropagation();
      openMenu();
    });
    input.addEventListener('paste', function (event) {
      if (!event.clipboardData) return;
      var value = event.clipboardData.getData('text/plain');
      if (!isSingleLine(value)) {
        event.preventDefault();
        status('請只貼上單行指令；草稿不接受換行或控制字元。', true);
      }
    });
    input.addEventListener('dragenter', function (event) {
      event.preventDefault();
      event.stopPropagation();
      if (!dragging) rememberSelection();
      dragging = true;
      input.classList.add('is-value-drop');
    });
    input.addEventListener('dragover', function (event) {
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    });
    input.addEventListener('dragleave', function () {
      dragging = false;
      input.classList.remove('is-value-drop');
    });
    input.addEventListener('drop', function (event) {
      event.preventDefault();
      event.stopPropagation();
      input.classList.remove('is-value-drop');
      // The browser may move its caret to the pointer position during a drop.
      // Keep using the selection captured before dragenter, including while focused.
      dragging = true;
      var transfer = event.dataTransfer;
      var value = transfer ? transfer.getData('application/x-terminalgrid-value') || transfer.getData('text/plain') : '';
      if (transfer && transfer.files && transfer.files.length) {
        status('請拖入暫存值文字；這裡不接受檔案。', true);
      } else {
        replaceSelection(value);
      }
      dragging = false;
    });
    valuesButton.addEventListener('click', function () {
      if (menu.hidden) openMenu(); else closeMenu();
    });
    menu.addEventListener('keydown', function (event) {
      var buttons = Array.prototype.slice.call(menu.querySelectorAll('button'));
      var index = buttons.indexOf(doc.activeElement);
      if (event.key === 'Escape') {
        event.preventDefault();
        closeMenu();
        valuesButton.focus();
      } else if (buttons.length && ['ArrowDown', 'ArrowUp', 'Home', 'End'].indexOf(event.key) >= 0) {
        event.preventDefault();
        if (event.key === 'Home') index = 0;
        else if (event.key === 'End') index = buttons.length - 1;
        else index = (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[index].focus();
      }
    });
    section.addEventListener('focusout', function (event) {
      if (event.relatedTarget && !section.contains(event.relatedTarget)) closeMenu();
    });
    sendButton.addEventListener('click', function () {
      var command = input.value;
      if (busy || !command.trim() || !isSingleLine(command)) {
        status('請提供單行指令，不可含換行或控制字元，且最多 16,000 個字元。', true);
        return;
      }
      busy = true;
      updateSendState();
      Promise.resolve().then(function () { return options.onSend(command); }).catch(function (error) {
        status(error && error.message ? error.message : '無法貼到終端，請確認終端仍在執行。', true);
      }).finally(function () {
        busy = false;
        updateSendState();
      });
    });

    return {
      open: function (text, targetLabel) {
        closeMenu();
        selection = null;
        dragging = false;
        input.value = typeof text === 'string' ? text.slice(0, MAX_LENGTH) : '';
        target.textContent = typeof targetLabel === 'string' ? targetLabel : '';
        target.title = target.textContent;
        section.hidden = false;
        updateSendState();
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
        if (typeof text === 'string' && text.length > MAX_LENGTH) status('草稿最多保留前 16,000 個字元，請檢查內容。', true);
        else if (!isSingleLine(input.value)) status('選取內容包含換行或控制字元，請先編輯為單行指令再貼到終端。', true);
      },
      replaceSelection: replaceSelection,
      hasSelection: hasSelection,
      focus: function () { input.focus(); }
    };
  }

  root.TerminalGridDraft = { create: create };
}(window));
