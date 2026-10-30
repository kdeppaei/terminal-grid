(function (root) {
  'use strict';

  var MAX_LENGTH = 16000;

  function create(options) {
    if (!options || !options.container || typeof options.onSend !== 'function') {
      throw new TypeError('Command draft requires a container and onSend callback.');
    }
    var container = options.container;
    var doc = container.ownerDocument;
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
    function isSingleLine(value) { return root.TerminalGridTextEdit.isSingleLine(value); }

    var heading = element('div', 'command-draft-heading');
    var title = element('label', 'command-draft-title', '指令草稿');
    title.htmlFor = 'commandDraftText';
    var target = element('span', 'command-draft-target');
    target.id = 'commandDraftTarget';
    heading.appendChild(title); heading.appendChild(target);
    var closeButton = element('button', 'icon-button', '×');
    closeButton.type = 'button'; closeButton.setAttribute('aria-label', '收合指令草稿');
    heading.appendChild(closeButton); section.appendChild(heading);

    var input = element('textarea', 'command-draft-text');
    input.id = 'commandDraftText'; input.rows = 3; input.maxLength = MAX_LENGTH;
    input.spellcheck = false;
    input.placeholder = '例如 ping A：可用滑鼠選取 A 刪除或替換，也可點到任意位置貼上。';
    input.setAttribute('aria-describedby', 'commandDraftHint');
    input.setAttribute('autocomplete', 'off');
    section.appendChild(input);
    var hint = element('p', 'command-draft-hint', '可框選後刪除、剪下或貼上；拖入暫存值會替換選取文字，沒有選取則插入游標處。貼到終端後請自行按 Enter 執行。');
    hint.id = 'commandDraftHint'; section.appendChild(hint);

    var actions = element('div', 'command-draft-actions');
    var valuesButton = element('button', 'button', '用暫存值替換');
    valuesButton.id = 'draftValuesButton'; valuesButton.type = 'button';
    valuesButton.setAttribute('aria-haspopup', 'dialog');
    valuesButton.setAttribute('aria-expanded', 'false');
    valuesButton.setAttribute('aria-controls', 'commandDraftValues');
    var sendButton = element('button', 'button primary', '貼到終端，不執行');
    sendButton.id = 'sendDraftButton'; sendButton.type = 'button';
    actions.appendChild(valuesButton); actions.appendChild(sendButton);
    section.appendChild(actions); container.appendChild(section);

    var editor = root.TerminalGridTextEdit.attach(input, {
      menuId: 'commandDraftValues', menuToggle: valuesButton, getValues: options.getValues, onStatus: status,
      onMenuChange: function (open) { valuesButton.setAttribute('aria-expanded', String(open)); }
    });
    function updateSendState() {
      sendButton.disabled = busy || !input.value.trim() || !isSingleLine(input.value);
    }
    closeButton.addEventListener('click', function () {
      editor.closeMenu(); container.hidden = true;
      if (typeof options.onResize === 'function') options.onResize();
    });
    input.addEventListener('input', updateSendState);
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault();
        status('草稿只接受單行指令；請使用「貼到終端，不執行」。');
      }
    });
    valuesButton.addEventListener('click', function () {
      if (editor.isMenuOpen()) editor.closeMenu(); else editor.openMenu();
    });
    sendButton.addEventListener('click', function () {
      var command = input.value;
      if (busy || !command.trim() || !isSingleLine(command)) {
        status('請提供單行指令，不可含換行或控制字元，且最多 16,000 個字元。', true); return;
      }
      busy = true; updateSendState();
      Promise.resolve().then(function () { return options.onSend(command); }).catch(function (error) {
        status(error && error.message ? error.message : '無法貼到終端，請確認終端仍在執行。', true);
      }).finally(function () { busy = false; updateSendState(); });
    });

    return {
      open: function (text, targetLabel) {
        editor.closeMenu();
        input.value = typeof text === 'string' ? text.slice(0, MAX_LENGTH) : '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        target.textContent = typeof targetLabel === 'string' ? targetLabel : '';
        target.title = target.textContent;
        section.hidden = false; updateSendState();
        input.focus(); input.setSelectionRange(input.value.length, input.value.length); editor.rememberSelection();
        if (typeof text === 'string' && text.length > MAX_LENGTH) status('草稿最多保留前 16,000 個字元，請檢查內容。', true);
        else if (!isSingleLine(input.value)) status('選取內容包含換行或控制字元，請先編輯為單行指令再貼到終端。', true);
      },
      replaceSelection: function (value) { return editor.insert(value, true); },
      hasSelection: editor.hasSelection,
      focus: function () { input.focus(); },
      dispose: function () { editor.dispose(); section.remove(); }
    };
  }

  root.TerminalGridDraft = { create: create };
}(window));
