(function () {
  'use strict';

  var MAX_SLOTS = 16;
  var SHELLS = ['CMD', 'PowerShell', 'PowerShell 7', 'Custom'];
  var host = window.chrome && window.chrome.webview;
  var hostReady = false;
  var capabilities = { pwsh: false };
  var config = normalizeConfig(null);
  var panes = [];
  var zoomedSlot = null;
  var focusedSlot = null;
  var settingsSlot = null;
  var saveTimer = null;
  var fitFrame = null;
  var toastTimer = null;
  var confirmation = null;
  var $ = function (id) { return document.getElementById(id); };
  var grid = $('grid');

  function defaultSlot(index) {
    return { name: '終端 ' + String(index + 1).padStart(2, '0'), shell: 'CMD', command: '', cwd: '', exe: '', args: '' };
  }
  function limitNumber(value, fallback, min, max) {
    var number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
  }
  function stringValue(value, maximum) { return typeof value === 'string' ? value.slice(0, maximum) : ''; }
  function normalizeConfig(raw) {
    raw = raw && typeof raw === 'object' ? raw : {};
    var result = { version: 1, rows: limitNumber(raw.rows, 2, 1, 4), cols: limitNumber(raw.cols, 2, 1, 4), fontSize: limitNumber(raw.fontSize, 13, 10, 24), slots: [] };
    for (var i = 0; i < MAX_SLOTS; i++) {
      var supplied = Array.isArray(raw.slots) && raw.slots[i] && typeof raw.slots[i] === 'object' ? raw.slots[i] : {};
      var slot = defaultSlot(i);
      slot.name = stringValue(supplied.name, 48).trim() || slot.name;
      slot.shell = SHELLS.indexOf(supplied.shell) >= 0 ? supplied.shell : 'CMD';
      slot.command = stringValue(supplied.command, 16000);
      slot.cwd = stringValue(supplied.cwd, 4096);
      slot.exe = stringValue(supplied.exe, 4096);
      slot.args = stringValue(supplied.args, 16384);
      result.slots.push(slot);
    }
    return result;
  }
  function send(message) {
    if (!host) return false;
    try { host.postMessage(message); return true; }
    catch (error) { showToast('無法連接終端引擎：' + error.message, true); return false; }
  }
  function withGeneration(slot, message) {
    if (panes[slot].generation !== null) message.generation = panes[slot].generation;
    return message;
  }
  function saveConfig(announce) {
    window.clearTimeout(saveTimer);
    if (hostReady) {
      send({ type: 'save', config: config });
      if (announce) setStatus('正在儲存配置…');
    }
  }
  function queueSave() { window.clearTimeout(saveTimer); saveTimer = window.setTimeout(function () { saveConfig(false); }, 550); }
  function setStatus(message) { $('statusMessage').textContent = message || ''; }
  function showToast(message, isError) {
    var toast = $('toast');
    window.clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.toggle('error', !!isError);
    toast.hidden = false;
    setStatus(message);
    toastTimer = window.setTimeout(function () { toast.hidden = true; }, isError ? 6500 : 3600);
  }
  function isBusy(state) { return state.status === 'starting' || state.status === 'stopping'; }
  function isActive(state) { return state.status === 'running' || isBusy(state); }
  function slotLabel(slot) { return config.slots[slot].name; }

  function createPane(index) {
    var element = document.createElement('section');
    element.className = 'pane';
    element.dataset.slot = index;
    element.dataset.status = 'idle';
    element.setAttribute('aria-label', '第 ' + (index + 1) + ' 格終端');
    element.innerHTML = '<header class="pane-header"><div class="pane-title-row"><span class="slot-number">' + String(index + 1).padStart(2, '0') + '</span><span class="state-dot" aria-hidden="true"></span><h2 class="pane-name"></h2><div class="pane-controls"><button class="icon-button" data-action="configure" title="終端設定" aria-label="終端設定">⚙</button><button class="icon-button" data-action="zoom" title="放大終端" aria-label="放大終端">⛶</button><button class="icon-button close-button" data-action="stop" title="結束終端" aria-label="結束終端">×</button></div></div><div class="pane-toolbar"><select class="pane-shell" aria-label="終端類型"><option value="CMD">CMD</option><option value="PowerShell">PowerShell</option><option value="PowerShell 7">PowerShell 7</option><option value="Custom">自訂程式</option></select><span class="pane-state"></span><button class="icon-button pane-restart" data-action="restart" title="重新啟動終端" aria-label="重新啟動終端">↻</button><button class="button pane-start" data-action="start">啟動</button></div></header><div class="terminal-container"><div class="terminal-mount"></div><div class="pane-empty"><span class="empty-symbol" aria-hidden="true">&gt;_</span><p class="empty-name"></p><p class="empty-command"></p><button class="button empty-start" data-action="start">啟動終端</button></div><div class="exit-notice" hidden></div></div>';
    grid.appendChild(element);
    var terminal = new window.Terminal({
      cursorBlink: true, cursorStyle: 'bar', fontFamily: '"Cascadia Mono", "Consolas", "Microsoft JhengHei", monospace',
      fontSize: config.fontSize, lineHeight: 1.1, letterSpacing: 0, scrollback: 5000,
      convertEol: false, allowTransparency: false, disableStdin: true, windowsMode: false,
      theme: { background: '#0c1119', foreground: '#d4dfed', cursor: '#7be0d4', cursorAccent: '#0c1119', selectionBackground: '#355a7c99', selectionInactiveBackground: '#2d435e88', black: '#263143', red: '#f1848d', green: '#8accab', yellow: '#e3c27e', blue: '#81a9ef', magenta: '#ba9de8', cyan: '#72c7d1', white: '#c7d4e5', brightBlack: '#63758f', brightRed: '#ff9da6', brightGreen: '#abe3c2', brightYellow: '#f4dc9e', brightBlue: '#a1c3ff', brightMagenta: '#d0b7f9', brightCyan: '#9fe2e5', brightWhite: '#f1f5fc' }
    });
    var fit = new window.FitAddon.FitAddon();
    terminal.loadAddon(fit);
    terminal.open(element.querySelector('.terminal-mount'));
    var state = { element: element, terminal: terminal, fit: fit, status: 'idle', generation: null, pid: null, exitCode: null, hasOutput: false, clearOnStarted: false, lastCols: 0, lastRows: 0 };
    panes.push(state);
    terminal.onData(function (data) {
      if (state.status === 'running' && hostReady) send(withGeneration(index, { type: 'input', slot: index, data: data }));
    });
    terminal.onResize(function (size) {
      state.lastCols = size.cols; state.lastRows = size.rows;
      if (isActive(state) && hostReady) send(withGeneration(index, { type: 'resize', slot: index, cols: size.cols, rows: size.rows }));
    });
    terminal.attachCustomKeyEventHandler(function (event) {
      if (event.ctrlKey && event.shiftKey && !event.altKey && (event.code === 'KeyC' || event.code === 'KeyV')) {
        if (event.type === 'keydown') {
          if (event.code === 'KeyC') copySelection(index);
          else pasteClipboard(index);
        }
        return false;
      }
      return true;
    });
    element.querySelector('.terminal-mount').addEventListener('paste', function (event) {
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.clipboardData) pasteText(index, event.clipboardData.getData('text/plain'));
      else pasteClipboard(index);
    }, true);
    element.addEventListener('focusin', function () { markFocused(index); });
    element.addEventListener('pointerdown', function () { markFocused(index); });
    element.addEventListener('click', function (event) {
      var button = event.target.closest('button[data-action]');
      if (!button || button.disabled) return;
      var action = button.dataset.action;
      if (action === 'configure') openSettings(index);
      if (action === 'zoom') toggleZoom(index);
      if (action === 'start') startSlot(index, false);
      if (action === 'stop') requestStop(index);
      if (action === 'restart') requestRestart(index);
    });
    element.querySelector('.pane-shell').addEventListener('change', function (event) {
      config.slots[index].shell = event.target.value;
      renderPane(index); queueSave();
      if (event.target.value === 'Custom' && !config.slots[index].exe.trim()) openSettings(index);
      else if (isActive(state)) setStatus('終端類型將在「' + slotLabel(index) + '」下次啟動時生效。');
    });
    element.querySelector('.terminal-container').addEventListener('click', function (event) {
      if (!event.target.closest('button')) terminal.focus();
    });
    if (terminal.textarea) terminal.textarea.setAttribute('aria-label', '第 ' + (index + 1) + ' 格可操作終端');
    renderPane(index);
  }

  function markFocused(slot) {
    if (focusedSlot !== null && panes[focusedSlot]) panes[focusedSlot].element.classList.remove('is-focused');
    focusedSlot = slot;
    panes[slot].element.classList.add('is-focused');
    updateClipboardButtons();
  }
  function renderPane(slot) {
    var state = panes[slot], element = state.element, setting = config.slots[slot];
    element.dataset.status = state.status;
    element.querySelector('.pane-name').textContent = setting.name;
    element.querySelector('.pane-name').title = setting.name;
    element.querySelector('.pane-shell').value = setting.shell;
    element.querySelector('.pane-shell').disabled = !hostReady;
    var pwshOption = element.querySelector('.pane-shell option[value="PowerShell 7"]');
    pwshOption.disabled = !capabilities.pwsh && setting.shell !== 'PowerShell 7';
    pwshOption.title = capabilities.pwsh ? '' : '未偵測到 PowerShell 7；可在自訂程式指定路徑';
    var description = '尚未啟動';
    if (state.status === 'running') description = state.pid ? 'PID ' + state.pid : '執行中';
    if (state.status === 'starting') description = '啟動中…';
    if (state.status === 'stopping') description = '結束中…';
    if (state.status === 'exited') description = '已結束 · ' + (state.exitCode === null ? '—' : state.exitCode);
    if (state.status === 'error') description = '啟動失敗';
    element.querySelector('.pane-state').textContent = description;
    element.querySelector('.pane-state').title = description;
    element.querySelector('[data-action="stop"]').disabled = !hostReady || state.status !== 'running';
    element.querySelector('[data-action="restart"]').disabled = !hostReady || isBusy(state);
    var starts = element.querySelectorAll('[data-action="start"]');
    for (var i = 0; i < starts.length; i++) starts[i].disabled = !hostReady || isActive(state);
    element.querySelector('.pane-start').textContent = state.status === 'starting' ? '啟動中' : state.status === 'stopping' ? '結束中' : '啟動';
    element.querySelector('.pane-empty').hidden = state.hasOutput || state.status === 'running' || state.status === 'stopping';
    element.querySelector('.empty-name').textContent = state.status === 'starting' ? '正在建立終端…' : state.status === 'error' ? '請檢查設定後重試' : '準備開始新的測試';
    element.querySelector('.empty-command').textContent = setting.shell === 'Custom' ? ((setting.exe + ' ' + setting.args).trim() || '設定自訂程式') : (setting.command.trim() || setting.shell + ' · 可直接輸入指令');
    var exitNotice = element.querySelector('.exit-notice');
    exitNotice.hidden = state.status !== 'exited' || !state.hasOutput;
    exitNotice.textContent = '已結束 · 結束碼 ' + (state.exitCode === null ? '—' : state.exitCode) + ' · 輸出已保留';
    state.terminal.options.disableStdin = state.status !== 'running';
  }
  function renderAllPanes() { for (var i = 0; i < MAX_SLOTS; i++) renderPane(i); updateCounts(); }
  function applyLayout() {
    var count = config.rows * config.cols;
    grid.style.setProperty('--grid-rows', String(config.rows));
    grid.style.setProperty('--grid-cols', String(config.cols));
    $('rowSelect').value = String(config.rows); $('colSelect').value = String(config.cols);
    var preset = config.rows + 'x' + config.cols;
    $('presetSelect').value = ['2x2', '2x3', '3x3', '3x4'].indexOf(preset) >= 0 ? preset : 'custom';
    $('fontSizeLabel').textContent = config.fontSize;
    $('fontMinus').disabled = config.fontSize <= 10;
    $('fontPlus').disabled = config.fontSize >= 24;
    $('layoutStatus').textContent = config.rows + ' × ' + config.cols;
    if (zoomedSlot !== null && zoomedSlot >= count) zoomedSlot = null;
    grid.classList.toggle('is-zoomed', zoomedSlot !== null);
    $('unzoomButton').hidden = zoomedSlot === null;
    for (var i = 0; i < MAX_SLOTS; i++) {
      panes[i].element.hidden = i >= count;
      panes[i].element.classList.toggle('zoom-target', i === zoomedSlot);
      panes[i].element.querySelector('[data-action="zoom"]').title = i === zoomedSlot ? '返回網格' : '放大終端';
      panes[i].terminal.options.fontSize = config.fontSize;
    }
    scheduleFit(); updateCounts();
  }
  function updateCounts() {
    var active = 0, hidden = 0, count = config.rows * config.cols;
    for (var i = 0; i < MAX_SLOTS; i++) if (isActive(panes[i])) { active++; if (i >= count || (zoomedSlot !== null && i !== zoomedSlot)) hidden++; }
    $('sessionCount').textContent = active + ' 個執行中';
    $('hiddenButton').hidden = hidden === 0;
    $('hiddenButton').textContent = hidden + ' 個執行中終端已隱藏';
    $('hiddenButton').title = '顯示全部 16 格，讓隱藏的終端重新可見';
    var available = false;
    for (var j = 0; j < count; j++) if ((zoomedSlot === null || zoomedSlot === j) && !isActive(panes[j])) available = true;
    $('startAllButton').disabled = !hostReady || !available;
    $('startAllButton').textContent = zoomedSlot === null ? '▶ 啟動可見終端' : '▶ 啟動目前終端';
    updateClipboardButtons();
  }
  function updateClipboardButtons() {
    $('copyButton').disabled = focusedSlot === null;
    $('pasteButton').disabled = !hostReady || focusedSlot === null || panes[focusedSlot].status !== 'running';
  }
  function scheduleFit() {
    if (fitFrame !== null) return;
    fitFrame = window.requestAnimationFrame(function () {
      fitFrame = null;
      for (var i = 0; i < MAX_SLOTS; i++) {
        var state = panes[i];
        if (!state.element.hidden && (zoomedSlot === null || zoomedSlot === i) && state.element.clientWidth > 20 && state.element.clientHeight > 80) {
          try { state.fit.fit(); } catch (_) { /* A pane may temporarily have no measurable area. */ }
        }
      }
    });
  }
  function toggleZoom(slot) {
    zoomedSlot = zoomedSlot === slot ? null : slot;
    applyLayout(); markFocused(slot);
    window.requestAnimationFrame(function () { panes[slot].terminal.focus(); });
  }
  function validateSlot(slot) {
    var setting = config.slots[slot];
    if (setting.shell === 'Custom' && !setting.exe.trim()) {
      showToast('請先為「' + setting.name + '」設定可執行程式。', true);
      openSettings(slot); return false;
    }
    if (setting.shell === 'PowerShell 7' && !capabilities.pwsh) {
      showToast('未偵測到 PowerShell 7。請安裝後重新開啟，或選「自訂程式」指定 pwsh.exe。', true);
      return false;
    }
    return true;
  }
  function startSlot(slot, clear) {
    var state = panes[slot];
    if (!hostReady || isActive(state) || !validateSlot(slot)) return;
    state.clearOnStarted = !!clear;
    state.status = 'starting'; state.exitCode = null;
    try { state.fit.fit(); } catch (_) { }
    var sent = send({ type: 'start', slot: slot, config: Object.assign({}, config.slots[slot]), cols: Math.max(2, state.terminal.cols), rows: Math.max(1, state.terminal.rows) });
    if (!sent) state.status = 'error';
    renderPane(slot); updateCounts(); markFocused(slot); state.terminal.focus();
  }
  function requestStop(slot) {
    var state = panes[slot];
    if (!hostReady || state.status !== 'running') return;
    askConfirmation('結束「' + slotLabel(slot) + '」？', '這會結束此格的終端與其中執行的測試。畫面上的輸出會保留。', '結束終端').then(function (accepted) {
      if (!accepted || state.status !== 'running') return;
      state.status = 'stopping'; renderPane(slot); updateCounts();
      send(withGeneration(slot, { type: 'stop', slot: slot }));
    });
  }
  function requestRestart(slot) {
    var state = panes[slot];
    if (!hostReady || isBusy(state) || !validateSlot(slot)) return;
    var request = isActive(state) ? askConfirmation('重新啟動「' + slotLabel(slot) + '」？', '這會結束目前的測試、清除這格的輸出，並依照目前設定啟動新終端。', '重新啟動') : Promise.resolve(true);
    request.then(function (accepted) {
      if (!accepted || isBusy(state)) return;
      state.clearOnStarted = true;
      state.status = 'starting'; state.exitCode = null;
      send(withGeneration(slot, { type: 'restart', slot: slot, config: Object.assign({}, config.slots[slot]), cols: Math.max(2, state.terminal.cols), rows: Math.max(1, state.terminal.rows) }));
      renderPane(slot); updateCounts(); markFocused(slot); state.terminal.focus();
    });
  }

  function openSettings(slot) {
    if ($('settingsDialog').open || $('confirmDialog').open) return;
    settingsSlot = slot;
    var setting = config.slots[slot];
    $('settingsTitle').textContent = '第 ' + String(slot + 1).padStart(2, '0') + ' 格 · 終端設定';
    $('settingName').value = setting.name; $('settingShell').value = setting.shell;
    $('settingCwd').value = setting.cwd; $('settingExe').value = setting.exe;
    $('settingArgs').value = setting.args; $('settingCommand').value = setting.command;
    $('settingShell').querySelector('option[value="PowerShell 7"]').disabled = !capabilities.pwsh && setting.shell !== 'PowerShell 7';
    updateCustomFields(); $('settingsDialog').showModal();
    $('settingName').focus(); $('settingName').select();
  }
  function updateCustomFields() {
    var custom = $('settingShell').value === 'Custom';
    $('customFields').hidden = !custom;
    $('settingCommand').disabled = custom;
    $('commandHint').textContent = custom ? '自訂程式請使用上方的「啟動參數」。此欄指令不會傳送給自訂程式。' : '可留空，啟動後手動輸入。儲存設定不會執行指令；修改會在下次啟動生效。';
    $('settingExe').setCustomValidity('');
  }
  function askConfirmation(title, message, acceptLabel) {
    if (confirmation) return Promise.resolve(false);
    return new Promise(function (resolve) {
      confirmation = resolve;
      $('confirmTitle').textContent = title;
      $('confirmMessage').textContent = message;
      $('confirmAccept').textContent = acceptLabel;
      $('confirmDialog').showModal(); $('confirmCancel').focus();
    });
  }
  function finishConfirmation(accepted) {
    var resolve = confirmation;
    confirmation = null;
    $('confirmDialog').close();
    if (resolve) resolve(accepted);
  }
  async function copySelection(slot) {
    var selection = panes[slot].terminal.getSelection();
    if (!selection) { showToast('請先拖曳選取要複製的終端文字。'); return; }
    try { await navigator.clipboard.writeText(selection); showToast('已複製選取文字。'); }
    catch (_) { showToast('無法使用剪貼簿，請檢查系統權限後重試。', true); }
  }
  async function pasteClipboard(slot) {
    if (panes[slot].status !== 'running') return;
    var generation = panes[slot].generation;
    try {
      var value = await navigator.clipboard.readText();
      if (panes[slot].status !== 'running' || panes[slot].generation !== generation) { showToast('終端狀態已變更，請重新貼上。'); return; }
      await pasteText(slot, value);
    } catch (_) { showToast('無法讀取剪貼簿，請檢查系統權限後重試。', true); }
  }
  async function pasteText(slot, value) {
    var state = panes[slot];
    if (state.status !== 'running' || !value) return;
    var generation = state.generation;
    if (value.length > 1048576) { showToast('剪貼簿文字超過 1 MB，請分段貼上。', true); return; }
    if (/[\r\n]/.test(value)) {
      var preview = value.length > 500 ? value.slice(0, 500) + '\n…（僅顯示前 500 字）' : value;
      var accepted = await askConfirmation('貼上多行文字？', '剪貼簿含有換行，貼上後可能立即執行指令。請確認後再貼上。\n\n' + preview, '確認貼上');
      if (!accepted) return;
    }
    if (state.status !== 'running' || generation !== state.generation) { showToast('終端狀態已變更，請重新貼上。'); return; }
    state.terminal.paste(value); state.terminal.focus();
  }

  function isStaleMessage(state, message, allowNew) {
    if (typeof message.generation !== 'number' || state.generation === null) return false;
    return allowNew ? message.generation < state.generation : message.generation !== state.generation;
  }
  function handleHostMessage(message) {
    if (!message || typeof message !== 'object' || typeof message.type !== 'string') return;
    if (message.type === 'init') {
      config = normalizeConfig(message.config);
      capabilities = Object.assign({ pwsh: false }, message.capabilities || {});
      hostReady = true;
      $('connectionDot').className = 'connection-dot connected';
      $('connectionText').textContent = '終端引擎已就緒';
      $('connectionText').title = message.version ? 'Terminal Grid ' + message.version + ' · Windows ConPTY' : 'Windows ConPTY';
      $('saveButton').disabled = false; $('exportButton').disabled = false; $('importButton').disabled = false;
      applyLayout(); renderAllPanes(); setStatus('點選「啟動」開始；每格都有獨立的輸入與輸出。');
      return;
    }
    if (message.type === 'imported') {
      config = normalizeConfig(message.config);
      applyLayout(); renderAllPanes();
      showToast('已匯入配置。現有終端繼續執行；新設定在下次啟動時生效。');
      return;
    }
    if (message.type === 'status') { setStatus(message.message); return; }
    var slot = Number(message.slot);
    var state = Number.isInteger(slot) && slot >= 0 && slot < MAX_SLOTS ? panes[slot] : null;
    if (message.type === 'error') {
      if (state && !isStaleMessage(state, message, true)) {
        if (typeof message.generation === 'number') state.generation = message.generation;
        if (state.status === 'starting' || state.status === 'stopping') state.status = 'error';
        renderPane(slot); updateCounts();
      } else if (state) return;
      showToast((state ? slotLabel(slot) + '：' : '') + (message.message || '終端發生錯誤。'), true);
      return;
    }
    if (!state) return;
    if (message.type === 'started') {
      if (isStaleMessage(state, message, true)) return;
      if (typeof message.generation === 'number') state.generation = message.generation;
      if (state.clearOnStarted) { state.terminal.reset(); state.hasOutput = false; }
      state.clearOnStarted = false;
      state.status = 'running'; state.pid = message.pid || null; state.exitCode = null;
      renderPane(slot); updateCounts(); scheduleFit();
      var startedGeneration = state.generation;
      window.requestAnimationFrame(function () {
        if (state.status !== 'running' || state.generation !== startedGeneration) return;
        if (!state.element.hidden && (zoomedSlot === null || zoomedSlot === slot)) {
          try { state.fit.fit(); } catch (_) { }
        }
        send(withGeneration(slot, { type: 'resize', slot: slot, cols: Math.max(2, state.terminal.cols), rows: Math.max(1, state.terminal.rows) }));
      });
      if (focusedSlot === slot) state.terminal.focus();
      return;
    }
    if (isStaleMessage(state, message, false)) return;
    if (message.type === 'output') {
      if (typeof message.data !== 'string' || !message.data) return;
      try {
        var binary = window.atob(message.data);
        var bytes = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        var receivedGeneration = message.generation;
        var receivedBytes = bytes.length;
        state.terminal.write(bytes, function () {
          var ack = { type: 'ack', slot: slot, bytes: receivedBytes };
          if (typeof receivedGeneration === 'number') ack.generation = receivedGeneration;
          send(ack);
        });
        if (!state.hasOutput) { state.hasOutput = true; renderPane(slot); }
      } catch (_) { setStatus('無法解碼「' + slotLabel(slot) + '」的終端輸出。'); }
      return;
    }
    if (message.type === 'exited') {
      state.status = 'exited'; state.pid = null;
      state.exitCode = typeof message.exitCode === 'number' ? message.exitCode : null;
      renderPane(slot); updateCounts();
      setStatus('「' + slotLabel(slot) + '」已結束，輸出已保留。');
    }
  }

  function initialize() {
    if (typeof window.Terminal !== 'function' || !window.FitAddon) {
      $('connectionDot').className = 'connection-dot failed';
      $('connectionText').textContent = '終端元件載入失敗';
      showToast('缺少本機終端元件。請完整解壓縮套件，並從 TerminalGridIntegrated.exe 啟動。', true);
      return;
    }
    for (var i = 0; i < MAX_SLOTS; i++) createPane(i);
    applyLayout();
    $('saveButton').disabled = true; $('exportButton').disabled = true; $('importButton').disabled = true;
    $('presetSelect').addEventListener('change', function (event) {
      if (event.target.value === 'custom') return;
      var dimensions = event.target.value.split('x');
      config.rows = Number(dimensions[0]); config.cols = Number(dimensions[1]);
      zoomedSlot = null; applyLayout(); queueSave();
    });
    ['rowSelect', 'colSelect'].forEach(function (id) {
      $(id).addEventListener('change', function () {
        config.rows = limitNumber($('rowSelect').value, 2, 1, 4); config.cols = limitNumber($('colSelect').value, 2, 1, 4);
        zoomedSlot = null; applyLayout(); queueSave();
      });
    });
    $('fontMinus').addEventListener('click', function () { config.fontSize = Math.max(10, config.fontSize - 1); applyLayout(); queueSave(); });
    $('fontPlus').addEventListener('click', function () { config.fontSize = Math.min(24, config.fontSize + 1); applyLayout(); queueSave(); });
    $('startAllButton').addEventListener('click', function () {
      for (var i = 0; i < config.rows * config.cols; i++) if ((zoomedSlot === null || zoomedSlot === i) && !isActive(panes[i])) startSlot(i, false);
    });
    $('hiddenButton').addEventListener('click', function () { config.rows = 4; config.cols = 4; zoomedSlot = null; applyLayout(); queueSave(); showToast('已顯示全部 16 格。'); });
    $('unzoomButton').addEventListener('click', function () { zoomedSlot = null; applyLayout(); });
    $('saveButton').addEventListener('click', function () { saveConfig(true); });
    $('exportButton').addEventListener('click', function () { if (hostReady) send({ type: 'export', config: config }); });
    $('importButton').addEventListener('click', function () { if (hostReady) send({ type: 'import' }); });
    $('helpButton').addEventListener('click', function () { $('helpDialog').showModal(); });
    $('copyButton').addEventListener('click', function () { if (focusedSlot !== null) copySelection(focusedSlot); });
    $('pasteButton').addEventListener('click', function () { if (focusedSlot !== null) pasteClipboard(focusedSlot); });
    $('settingShell').addEventListener('change', updateCustomFields);
    $('settingsForm').addEventListener('submit', function (event) {
      event.preventDefault();
      if (settingsSlot === null) return;
      if ($('settingShell').value === 'Custom' && !$('settingExe').value.trim()) {
        $('settingExe').setCustomValidity('請輸入要啟動的可執行程式。'); $('settingExe').reportValidity(); return;
      }
      var slot = settingsSlot;
      config.slots[slot] = { name: $('settingName').value.trim() || defaultSlot(slot).name, shell: $('settingShell').value, cwd: $('settingCwd').value.trim(), command: $('settingCommand').value, exe: $('settingExe').value.trim(), args: $('settingArgs').value };
      $('settingsDialog').close(); renderPane(slot); queueSave();
      showToast('已儲存「' + slotLabel(slot) + '」設定' + (isActive(panes[slot]) ? '，下次啟動時生效。' : '。按「啟動」執行。'));
    });
    $('settingExe').addEventListener('input', function () { this.setCustomValidity(''); });
    $('settingsDialog').addEventListener('close', function () { settingsSlot = null; $('settingExe').setCustomValidity(''); });
    document.querySelectorAll('[data-close]').forEach(function (button) { button.addEventListener('click', function () { $(button.dataset.close).close(); }); });
    $('confirmAccept').addEventListener('click', function () { finishConfirmation(true); });
    $('confirmCancel').addEventListener('click', function () { finishConfirmation(false); });
    $('confirmDialog').addEventListener('cancel', function (event) { event.preventDefault(); finishConfirmation(false); });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && zoomedSlot !== null && !document.querySelector('dialog[open]')) {
        event.preventDefault(); event.stopImmediatePropagation(); zoomedSlot = null; applyLayout();
      }
    }, true);
    window.addEventListener('resize', scheduleFit);
    if (window.ResizeObserver) new ResizeObserver(scheduleFit).observe(grid);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(scheduleFit);
    if (host) {
      host.addEventListener('message', function (event) { handleHostMessage(event.data); });
      send({ type: 'ready' });
      window.setTimeout(function () {
        if (!hostReady) { $('connectionText').textContent = '等待終端引擎'; setStatus('終端引擎尚未回應。若持續等候，請重新開啟管理器。'); }
      }, 9000);
    } else {
      $('connectionDot').className = 'connection-dot failed';
      $('connectionText').textContent = '靜態預覽';
      setStatus('請從 TerminalGridIntegrated.exe 啟動，才能使用本機終端。');
    }
  }

  initialize();
}());
