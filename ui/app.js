(function () {
  'use strict';

  var MAX_SLOTS = 16, MAX_TABS = 8, SHELLS = ['CMD', 'PowerShell', 'PowerShell 7', 'Custom'];
  var host = window.chrome && window.chrome.webview, hostReady = false;
  var capabilities = { pwsh: false }, appConfig = normalizeAppConfig(null), views = [];
  var activeView = null, focused = null, settingsRef = null, settingsSession = 0;
  var pendingFolderRequest = null, folderRequestSequence = 0, saveTimer = null, fitFrame = null;
  var toastTimer = null, confirmation = null, currentFlowId = null, flowRunning = false;
  var workspaceEditingId = null, packEditingId = null, commandEditingRef = null, flowPauseResolve = null;
  var capturedValues = [], captureRenderTimer = null, captureAutoOpened = false, captureDragging = false;
  var commandDraft = null, draftTarget = null;
  var $ = function (id) { return document.getElementById(id); };
  var workspaceHost = $('workspaceHost');

  function uid(prefix) { return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9); }
  function hasDataType(dataTransfer, type) { return !!(dataTransfer && dataTransfer.types && Array.prototype.indexOf.call(dataTransfer.types, type) >= 0); }
  function limitNumber(value, fallback, min, max) {
    var number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
  }
  function str(value, maximum) { return typeof value === 'string' ? value.slice(0, maximum) : ''; }
  function defaultTab(index, id) {
    return { id: id || 'tab-' + (index + 1), name: '終端 ' + String(index + 1), shell: 'CMD', command: '', cwd: '', exe: '', args: '' };
  }
  function normalizeTab(raw, index) {
    raw = raw && typeof raw === 'object' ? raw : {};
    var tab = defaultTab(index, str(raw.id, 64) || uid('tab'));
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(tab.id)) tab.id = uid('tab');
    tab.name = str(raw.name, 48).trim() || '終端 ' + String(index + 1);
    tab.shell = SHELLS.indexOf(raw.shell) >= 0 ? raw.shell : 'CMD';
    tab.command = str(raw.command, 16000); tab.cwd = str(raw.cwd, 4096);
    tab.exe = str(raw.exe, 4096); tab.args = str(raw.args, 16000);
    return tab;
  }
  function normalizeWorkspace(raw, index) {
    raw = raw && typeof raw === 'object' ? raw : {};
    var id = str(raw.id, 64) || (index === 0 ? 'workspace-1' : uid('workspace'));
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) id = uid('workspace');
    var workspace = { id: id, name: str(raw.name, 48).trim() || '工作區 ' + String(index + 1),
      rows: limitNumber(raw.rows, 2, 1, 4), cols: limitNumber(raw.cols, 2, 1, 4),
      fontSize: limitNumber(raw.fontSize, 13, 10, 24), slots: [] };
    for (var i = 0; i < MAX_SLOTS; i++) {
      var supplied = Array.isArray(raw.slots) && raw.slots[i] && typeof raw.slots[i] === 'object' ? raw.slots[i] : {};
      var tabs = Array.isArray(supplied.tabs) ? supplied.tabs.slice(0, MAX_TABS).map(normalizeTab) : [];
      if (!tabs.length) {
        var legacy = Object.assign({}, supplied);
        if (!legacy.name) legacy.name = '終端 ' + String(i + 1).padStart(2, '0');
        tabs = [normalizeTab(legacy, 0)];
      }
      var ids = {};
      tabs.forEach(function (tab, ti) { if (ids[tab.id]) tab.id = uid('tab'); ids[tab.id] = true; });
      var active = tabs.some(function (tab) { return tab.id === supplied.activeTabId; }) ? supplied.activeTabId : tabs[0].id;
      workspace.slots.push({ name: tabs.find(function (tab) { return tab.id === active; }).name,
        shell: tabs.find(function (tab) { return tab.id === active; }).shell,
        command: tabs.find(function (tab) { return tab.id === active; }).command,
        cwd: tabs.find(function (tab) { return tab.id === active; }).cwd,
        exe: tabs.find(function (tab) { return tab.id === active; }).exe,
        args: tabs.find(function (tab) { return tab.id === active; }).args, activeTabId: active, tabs: tabs });
    }
    return workspace;
  }
  function normalizeAppConfig(raw) {
    raw = raw && typeof raw === 'object' ? raw : {};
    var source = Array.isArray(raw.workspaces) ? raw.workspaces : [raw];
    var workspaces = source.slice(0, 12).map(normalizeWorkspace);
    if (!workspaces.length) workspaces = [normalizeWorkspace({ id: 'workspace-1', name: '工作區 1' }, 0)];
    var ids = {};
    workspaces.forEach(function (w) { if (ids[w.id]) w.id = uid('workspace'); ids[w.id] = true; });
    var activeId = workspaces.some(function (w) { return w.id === raw.activeWorkspaceId; }) ? raw.activeWorkspaceId : workspaces[0].id;
    var automations = Array.isArray(raw.automations) ? raw.automations.slice(0, 32).map(function (f) {
      f = f && typeof f === 'object' ? f : {};
      return { id: str(f.id, 64) || uid('flow'), name: str(f.name, 64).trim() || '自動化流程',
        workspaceId: str(f.workspaceId, 64) || activeId,
        steps: (Array.isArray(f.steps) ? f.steps : []).slice(0, 100).map(function (step) {
          step = step || {};
          return { action: ['start', 'send', 'wait', 'pause', 'stop'].indexOf(step.action) >= 0 ? step.action : 'send',
            slot: limitNumber(step.slot, 0, 0, 15), tabId: str(step.tabId, 64), text: str(step.text, 16000),
            delayMs: limitNumber(step.delayMs, 500, 100, 30000), enter: step.enter !== false };
        }) };
    }).filter(function (f) { return workspaces.some(function (w) { return w.id === f.workspaceId; }); }) : [];
    var packs = Array.isArray(raw.commandPacks) ? raw.commandPacks.slice(0, 32).map(function (p) {
      p = p || {};
      return { id: str(p.id, 64) || uid('pack'), name: str(p.name, 64).trim() || '指令集',
        commands: (Array.isArray(p.commands) ? p.commands : []).slice(0, 128).map(function (c) {
          c = c || {};
          return { id: str(c.id, 64) || uid('cmd'), name: str(c.name, 80).trim() || '常用指令',
            description: str(c.description, 240), command: str(c.command, 16000) };
        }) };
    }) : [];
    if (!packs.length) packs.push({ id: uid('pack'), name: '網路測試常用指令', commands: [
      { id: uid('cmd'), name: 'IP 設定', description: '查看本機網路介面', command: 'ipconfig /all' },
      { id: uid('cmd'), name: '路由表', description: '查看 IPv4 路由', command: 'route print -4' },
      { id: uid('cmd'), name: '持續 Ping', description: '將位址改成目標主機', command: 'ping -t 192.168.1.1' },
      { id: uid('cmd'), name: 'TCP 連線測試', description: 'PowerShell Test-NetConnection 範例', command: 'Test-NetConnection 192.168.1.1 -Port 5201' },
      { id: uid('cmd'), name: 'iperf3 伺服器', description: '在此終端啟動 iperf3 server', command: 'iperf3 -s' },
      { id: uid('cmd'), name: 'iperf3 用戶端', description: '改成伺服器位址後執行', command: 'iperf3 -c 192.168.1.1' }
    ] });
    return { version: 2, activeWorkspaceId: activeId, workspaces: workspaces, automations: automations, commandPacks: packs };
  }
  function getWorkspace(id) { return appConfig.workspaces.find(function (w) { return w.id === id; }) || null; }
  function getView(id) { return views.find(function (v) { return v.config.id === id; }) || null; }
  function getTabConfig(workspace, slot, tabId) {
    var cell = workspace && workspace.slots[slot];
    return cell && cell.tabs.find(function (t) { return t.id === tabId; }) || null;
  }
  function getState(workspaceId, slot, tabId) {
    var view = getView(workspaceId), cell = view && view.panes[slot];
    return cell && cell.tabs.find(function (t) { return t.tabId === tabId; }) || null;
  }
  function activeState(view, slot) {
    var cell = view.panes[slot];
    return cell.tabs.find(function (state) { return state.tabId === cell.config.activeTabId; }) || cell.tabs[0];
  }
  function send(message) {
    if (!host) return false;
    try { host.postMessage(message); return true; }
    catch (error) { showToast('無法連接終端引擎：' + error.message, true); return false; }
  }
  function withGeneration(state, message) {
    message.workspaceId = state.workspaceId; message.slot = state.slot; message.tabId = state.tabId;
    if (state.generation !== null) message.generation = state.generation;
    return message;
  }
  function saveConfig(announce) {
    window.clearTimeout(saveTimer);
    appConfig.activeWorkspaceId = activeView ? activeView.config.id : appConfig.activeWorkspaceId;
    if (hostReady) { send({ type: 'save', config: appConfig }); if (announce) setStatus('正在儲存配置…'); }
  }
  function queueSave() { window.clearTimeout(saveTimer); saveTimer = window.setTimeout(function () { saveConfig(false); }, 500); }
  function setStatus(message) { $('statusMessage').textContent = message || ''; }
  function showToast(message, isError) {
    var toast = $('toast'); window.clearTimeout(toastTimer);
    toast.textContent = message; toast.classList.toggle('error', !!isError); toast.hidden = false; setStatus(message);
    toastTimer = window.setTimeout(function () { toast.hidden = true; }, isError ? 6500 : 3500);
  }
  function delay(ms) { return new Promise(function (resolve) { window.setTimeout(resolve, ms); }); }
  function setCapturePanel(open) {
    $('capturePanel').hidden = !open; $('captureButton').setAttribute('aria-expanded', String(open)); scheduleFit();
  }
  function resetCaptureScanner(state) {
    state.captureDecoder = new TextDecoder('utf-8');
    state.captureScanner = window.TerminalGridIPv6.createScanner(function (entry) { recordCapture(state, entry); });
  }
  function recordCapture(state, entry) {
    if (!$('captureEnabled').checked || getState(state.workspaceId, state.slot, state.tabId) !== state) return;
    var workspace = getWorkspace(state.workspaceId), tab = getTabConfig(workspace, state.slot, state.tabId);
    if (!workspace || !tab) return;
    var key = [state.workspaceId, state.slot, state.tabId, entry.interfaceName, entry.address.toLowerCase()].join('|');
    capturedValues = capturedValues.filter(function (item) { return item.key !== key; });
    capturedValues.unshift({ key: key, address: entry.address, interfaceName: entry.interfaceName,
      workspaceId: state.workspaceId, slot: state.slot, tabId: state.tabId, generation: state.generation,
      source: workspace.name + ' · ' + String(state.slot + 1).padStart(2, '0') + ' · ' + tab.name,
      seen: new Date() });
    capturedValues.length = Math.min(80, capturedValues.length);
    if (!captureAutoOpened) { captureAutoOpened = true; setCapturePanel(true); }
    queueCaptureRender();
  }
  function queueCaptureRender() {
    if (captureRenderTimer !== null) return;
    captureRenderTimer = window.setTimeout(function () { captureRenderTimer = null; if (!captureDragging) renderCaptures(); }, 100);
  }
  function pruneCaptures(state) {
    capturedValues = capturedValues.filter(function (item) {
      return item.workspaceId !== state.workspaceId || item.slot !== state.slot || item.tabId !== state.tabId;
    });
    queueCaptureRender();
  }
  async function copyCapture(item) {
    try { await navigator.clipboard.writeText(item.address); showToast('已複製：' + item.address); }
    catch (_) { showToast('無法使用剪貼簿，請檢查系統權限。', true); }
  }
  function validCaptureText(text) { return typeof text === 'string' && text.trim().length > 0 && text.length <= 4096 && !/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(text); }
  function saveCaptureText(text, state) {
    if (!validCaptureText(text)) { showToast('請選取或輸入單行文字，最多 4,096 字元。', true); return false; }
    var workspace = state && getWorkspace(state.workspaceId), tab = workspace && getTabConfig(workspace, state.slot, state.tabId);
    var key = 'manual|' + text;
    capturedValues = capturedValues.filter(function (item) { return item.key !== key; });
    capturedValues.unshift({ key: key, address: text, source: tab ? workspace.name + ' · ' + String(state.slot + 1).padStart(2, '0') + ' · ' + tab.name + ' · 手動暫存' : '手動暫存', seen: new Date() });
    capturedValues.length = Math.min(80, capturedValues.length); captureAutoOpened = true; setCapturePanel(true); renderCaptures(); return true;
  }
  function openCommandDraft(state) {
    if (!state || getState(state.workspaceId, state.slot, state.tabId) !== state) { showToast('請先選取要使用的終端分頁。'); return; }
    var workspace = getWorkspace(state.workspaceId), tab = getTabConfig(workspace, state.slot, state.tabId);
    var selection = state.terminal.getSelection(), existing = $('commandDraftText');
    draftTarget = { state: state, generation: state.generation };
    setCapturePanel(true); $('commandDraftHost').hidden = false;
    commandDraft.open(selection || (existing ? existing.value : ''), workspace.name + ' · ' + String(state.slot + 1).padStart(2, '0') + ' · ' + tab.name);
  }
  function showCaptureMenu(event, item) {
    event.preventDefault();
    var menu = $('terminalContextMenu'); menu.textContent = '';
    var copy = document.createElement('button'); copy.type = 'button'; copy.textContent = '複製暫存文字';
    copy.addEventListener('click', function () { menu.hidden = true; copyCapture(item); });
    var replace = document.createElement('button'); replace.type = 'button'; replace.textContent = '替換草稿中的選取文字';
    replace.addEventListener('click', function () { menu.hidden = true; commandDraft.replaceSelection(item.address); });
    menu.append(copy, replace); positionContextMenu(menu, event.clientX, event.clientY);
  }
  function positionContextMenu(menu, x, y) {
    x = Number.isFinite(x) ? x : 8; y = Number.isFinite(y) ? y : 8;
    menu.hidden = false; menu.style.left = Math.max(8, Math.min(x, window.innerWidth - menu.offsetWidth - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(y, window.innerHeight - menu.offsetHeight - 8)) + 'px';
  }
  function renderCaptures() {
    var list = $('captureList'); list.textContent = '';
    $('captureCount').textContent = String(capturedValues.length);
    $('captureEmpty').hidden = capturedValues.length > 0; $('clearCapturesButton').disabled = capturedValues.length === 0;
    capturedValues.forEach(function (item, index) {
      var row = document.createElement('article'); row.className = 'capture-item'; row.draggable = true; row.dataset.address = item.address;
      var top = document.createElement('div'); top.className = 'capture-item-heading';
      var label = document.createElement('span'); label.textContent = index === 0 ? '最新擷取' : '擷取紀錄';
      var time = document.createElement('time'); time.dateTime = item.seen.toISOString(); time.textContent = item.seen.toLocaleTimeString('zh-TW', { hour12: false }); time.title = item.seen.toLocaleString('zh-TW');
      top.append(label, time);
      var address = document.createElement('code'); address.className = 'capture-address'; address.textContent = item.address;
      var source = document.createElement('p'); source.className = 'capture-source'; source.textContent = item.source + (item.interfaceName ? ' · ' + item.interfaceName : ''); source.title = source.textContent;
      var copy = document.createElement('button'); copy.type = 'button'; copy.className = 'button quiet capture-copy'; copy.textContent = '複製'; copy.setAttribute('aria-label', '複製 ' + item.address);
      copy.addEventListener('click', function () { copyCapture(item); });
      var replace = document.createElement('button'); replace.type = 'button'; replace.className = 'button quiet capture-replace'; replace.textContent = '替換'; replace.title = '替換指令草稿中框選的文字';
      replace.addEventListener('click', function () { commandDraft.replaceSelection(item.address); });
      var remove = document.createElement('button'); remove.type = 'button'; remove.className = 'icon-button capture-remove'; remove.textContent = '×'; remove.setAttribute('aria-label', '移除 ' + item.address);
      remove.addEventListener('click', function () { capturedValues = capturedValues.filter(function (value) { return value !== item; }); renderCaptures(); });
      row.addEventListener('contextmenu', function (event) { showCaptureMenu(event, item); });
      row.addEventListener('dragstart', function (event) {
        captureDragging = true;
        event.dataTransfer.setData('application/x-terminalgrid-value', item.address); event.dataTransfer.setData('text/plain', item.address); event.dataTransfer.effectAllowed = 'copy';
      });
      row.append(top, address, source, copy, replace, remove); list.appendChild(row);
    });
  }
  function isBusy(state) { return state.status === 'starting' || state.status === 'stopping'; }
  function isActive(state) { return state.status === 'running' || isBusy(state); }
  function stateLabel(state) {
    if (state.status === 'running') return state.pid ? 'PID ' + state.pid : '執行中';
    if (state.status === 'starting') return '啟動中…';
    if (state.status === 'stopping') return '結束中…';
    if (state.status === 'exited') return '已結束 · ' + (state.exitCode === null ? '—' : state.exitCode);
    if (state.status === 'error') return '啟動失敗';
    return '尚未啟動';
  }
  function defaultWorkspace(index) {
    var w = normalizeWorkspace({ id: uid('workspace'), name: '工作區 ' + (index + 1) }, index);
    return w;
  }
  function makeTerminal(view, slot, tabConfig) {
    var mount = document.createElement('div');
    mount.className = 'terminal-layer';
    mount.innerHTML = '<div class="terminal-mount"></div><div class="pane-empty"><span class="empty-symbol" aria-hidden="true">&gt;_</span><p class="empty-name"></p><p class="empty-command"></p><button class="button empty-start" data-action="start">啟動終端</button></div><div class="exit-notice" hidden></div>';
    view.panes[slot].container.appendChild(mount);
    var terminal = new window.Terminal({
      cursorBlink: true, cursorStyle: 'bar', fontFamily: '"Cascadia Mono", "Consolas", "Microsoft JhengHei", monospace',
      fontSize: view.config.fontSize, lineHeight: 1.1, letterSpacing: 0, scrollback: 5000,
      convertEol: false, allowTransparency: false, disableStdin: true, windowsMode: false,
      theme: { background: '#0c1119', foreground: '#d4dfed', cursor: '#7be0d4', cursorAccent: '#0c1119', selectionBackground: '#355a7c99', selectionInactiveBackground: '#2d435e88', black: '#263143', red: '#f1848d', green: '#8accab', yellow: '#e3c27e', blue: '#81a9ef', magenta: '#ba9de8', cyan: '#72c7d1', white: '#c7d4e5', brightBlack: '#63758f', brightRed: '#ff9da6', brightGreen: '#abe3c2', brightYellow: '#f4dc9e', brightBlue: '#a1c3ff', brightMagenta: '#d0b7f9', brightCyan: '#9fe2e5', brightWhite: '#f1f5fc' }
    });
    var fit = new window.FitAddon.FitAddon(); terminal.loadAddon(fit); terminal.open(mount.querySelector('.terminal-mount'));
    var state = { workspaceId: view.config.id, slot: slot, tabId: tabConfig.id, layer: mount, terminal: terminal, fit: fit,
      status: 'idle', generation: null, pid: null, exitCode: null, hasOutput: false, clearOnStarted: false };
    resetCaptureScanner(state);
    view.panes[slot].tabs.push(state);
    terminal.onData(function (data) { if (state.status === 'running' && hostReady) send(withGeneration(state, { type: 'input', data: data })); });
    terminal.onResize(function (size) { if (isActive(state) && hostReady) send(withGeneration(state, { type: 'resize', cols: size.cols, rows: size.rows })); });
    terminal.attachCustomKeyEventHandler(function (event) {
      if (event.ctrlKey && event.shiftKey && !event.altKey && (event.code === 'KeyC' || event.code === 'KeyV')) {
        if (event.type === 'keydown') { if (event.code === 'KeyC') copySelection(state); else pasteClipboard(state); }
        return false;
      }
      return true;
    });
    mount.querySelector('.terminal-mount').addEventListener('paste', function (event) {
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.clipboardData) pasteText(state, event.clipboardData.getData('text/plain')); else pasteClipboard(state);
    }, true);
    mount.addEventListener('contextmenu', function (event) {
      event.preventDefault(); markFocused(view, slot, state.tabId); showTerminalMenu(event.clientX, event.clientY, state);
    });
    mount.addEventListener('click', function (event) {
      if (event.target.closest('button')) { startSlot(view, slot, state.tabId, false); return; }
      markFocused(view, slot, state.tabId);
    });
    mount.addEventListener('dragover', function (event) { if (hasDataType(event.dataTransfer, 'application/x-terminalgrid-command') || hasDataType(event.dataTransfer, 'application/x-terminalgrid-value')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } });
    mount.addEventListener('drop', function (event) {
      var captured = hasDataType(event.dataTransfer, 'application/x-terminalgrid-value');
      var value = event.dataTransfer && event.dataTransfer.getData(captured ? 'application/x-terminalgrid-value' : 'application/x-terminalgrid-command');
      if (!value || (!captured && !hasDataType(event.dataTransfer, 'application/x-terminalgrid-command'))) return;
      event.preventDefault(); event.stopPropagation();
      if (captured && !validCaptureText(value)) return;
      markFocused(view, slot, state.tabId); insertCommand(state, value, captured);
    });
    if (terminal.textarea) terminal.textarea.setAttribute('aria-label', '第 ' + (slot + 1) + ' 格 ' + tabConfig.name + ' 可操作終端');
    return state;
  }
  function createPane(view, index) {
    var element = document.createElement('section'); element.className = 'pane'; element.dataset.slot = index; element.dataset.status = 'idle';
    element.innerHTML = '<header class="pane-header"><div class="pane-title-row"><span class="slot-number">' + String(index + 1).padStart(2, '0') + '</span><span class="state-dot" aria-hidden="true"></span><h2 class="pane-name"></h2><div class="pane-controls"><button class="icon-button" data-action="configure" title="終端設定" aria-label="終端設定">⚙</button><button class="icon-button" data-action="zoom" title="放大終端" aria-label="放大終端">⛶</button><button class="icon-button close-button" data-action="stop" title="結束終端" aria-label="結束終端">×</button></div></div><div class="pane-tabs" role="tablist"></div><div class="pane-toolbar"><select class="pane-shell" aria-label="終端類型"><option value="CMD">CMD</option><option value="PowerShell">PowerShell</option><option value="PowerShell 7">PowerShell 7</option><option value="Custom">自訂程式</option></select><span class="pane-state"></span><button class="icon-button pane-folder" data-action="folder" title="選擇啟動資料夾" aria-label="選擇啟動資料夾">📁</button><button class="icon-button pane-restart" data-action="restart" title="重新啟動終端" aria-label="重新啟動終端">↻</button><button class="button pane-start" data-action="start">啟動</button></div><div class="pane-directory"><span class="pane-folder-path"></span></div></header><div class="terminal-container"></div>';
    view.grid.appendChild(element);
    var cell = { element: element, container: element.querySelector('.terminal-container'), tabs: [], config: view.config.slots[index] };
    view.panes[index] = cell;
    cell.config.tabs.forEach(function (tab) { makeTerminal(view, index, tab); });
    element.querySelector('.pane-tabs').addEventListener('click', function (event) {
      var button = event.target.closest('[data-tab-id]');
      if (button) { cell.config.activeTabId = button.dataset.tabId; renderPane(view, index); queueSave(); markFocused(view, index, button.dataset.tabId); scheduleFit(); return; }
      if (event.target.closest('[data-add-tab]')) addTerminalTab(view, index);
    });
    element.addEventListener('focusin', function () { var s = activeState(view, index); markFocused(view, index, s.tabId); });
    element.addEventListener('pointerdown', function (event) { if (!event.target.closest('button')) { var s = activeState(view, index); markFocused(view, index, s.tabId); } });
    element.addEventListener('click', function (event) {
      var button = event.target.closest('button[data-action]'); if (!button || button.disabled) return;
      var state = activeState(view, index);
      if (button.dataset.action === 'configure') openSettings(view, index, state.tabId);
      if (button.dataset.action === 'zoom') toggleZoom(view, index);
      if (button.dataset.action === 'start') startSlot(view, index, state.tabId, false);
      if (button.dataset.action === 'stop') requestStop(state);
      if (button.dataset.action === 'restart') requestRestart(view, index, state.tabId);
      if (button.dataset.action === 'folder') choosePaneFolder(view, index, state.tabId);
    });
    element.querySelector('.pane-shell').addEventListener('change', function (event) {
      var state = activeState(view, index), tab = getTabConfig(view.config, index, state.tabId);
      tab.shell = event.target.value; renderPane(view, index); queueSave();
      if (tab.shell === 'Custom' && !tab.exe.trim()) openSettings(view, index, state.tabId);
    });
    element.querySelector('.terminal-container').addEventListener('click', function (event) {
      if (!event.target.closest('button')) { var state = activeState(view, index); if (state.status === 'running') state.terminal.focus(); }
    });
    renderPane(view, index);
  }
  function createView(workspace) {
    var grid = document.createElement('main'); grid.className = 'terminal-grid'; grid.setAttribute('aria-label', workspace.name + ' 終端網格');
    grid.dataset.workspaceId = workspace.id; workspaceHost.appendChild(grid);
    var view = { config: workspace, grid: grid, panes: [], zoomedSlot: null };
    views.push(view);
    for (var i = 0; i < MAX_SLOTS; i++) createPane(view, i);
    return view;
  }
  function destroyViews() {
    draftTarget = null;
    capturedValues = []; queueCaptureRender();
    views.forEach(function (view) {
      view.panes.forEach(function (cell) { cell.tabs.forEach(function (state) { try { state.terminal.dispose(); } catch (_) { } }); });
      view.grid.remove();
    });
    views = []; activeView = null; focused = null;
  }
  function renderWorkspaces() {
    var strip = $('workspaceTabs'); strip.textContent = '';
    appConfig.workspaces.forEach(function (workspace) {
      var button = document.createElement('button'); button.type = 'button'; button.className = 'workspace-tab';
      button.setAttribute('role', 'tab'); button.setAttribute('aria-selected', String(activeView && activeView.config.id === workspace.id));
      button.textContent = workspace.name; button.title = '左鍵切換；右鍵編輯或刪除'; button.dataset.workspaceId = workspace.id;
      button.addEventListener('click', function () { activateWorkspace(workspace.id); });
      button.addEventListener('contextmenu', function (event) { event.preventDefault(); openWorkspaceDialog(workspace.id); });
      strip.appendChild(button);
    });
    $('addWorkspaceButton').disabled = appConfig.workspaces.length >= 12;
  }
  function openWorkspaceDialog(id) {
    var workspace = id ? getWorkspace(id) : null;
    workspaceEditingId = workspace ? workspace.id : null;
    $('workspaceDialogTitle').textContent = workspace ? '工作區設定' : '新增工作區';
    $('workspaceNameInput').value = workspace ? workspace.name : '工作區 ' + String(appConfig.workspaces.length + 1);
    $('deleteWorkspaceButton').hidden = !workspace || appConfig.workspaces.length < 2;
    $('duplicateWorkspaceButton').hidden = !workspace || appConfig.workspaces.length >= 12;
    $('workspaceDialog').showModal(); $('workspaceNameInput').focus(); $('workspaceNameInput').select();
  }
  function saveWorkspaceDialog(event) {
    event.preventDefault();
    var name = $('workspaceNameInput').value.trim();
    if (!name) { $('workspaceNameInput').focus(); return; }
    if (workspaceEditingId) {
      var existing = getWorkspace(workspaceEditingId), view = getView(workspaceEditingId);
      if (!existing) { $('workspaceDialog').close(); return; }
      existing.name = name.slice(0, 48); if (view) view.grid.setAttribute('aria-label', existing.name + ' 終端網格');
      $('workspaceDialog').close(); renderWorkspaces(); queueSave(); showToast('工作區名稱已更新。'); return;
    }
    if (appConfig.workspaces.length >= 12) { $('workspaceDialog').close(); showToast('最多可建立 12 個工作區。', true); return; }
    var created = defaultWorkspace(appConfig.workspaces.length); created.name = name.slice(0, 48);
    appConfig.workspaces.push(created); createView(created); $('workspaceDialog').close(); activateWorkspace(created.id); saveConfig(false);
  }
  function activateWorkspace(id) {
    var view = getView(id); if (!view) return;
    if (activeView) activeView.grid.hidden = true;
    activeView = view; activeView.grid.hidden = false; appConfig.activeWorkspaceId = id;
    renderWorkspaces(); applyLayout(view); updateCounts(); scheduleFit(); updateClipboardButtons();
  }
  function addWorkspace() {
    if (appConfig.workspaces.length >= 12) { showToast('最多可建立 12 個工作區。', true); return; }
    openWorkspaceDialog(null);
  }
  function deleteWorkspace(id) {
    if (appConfig.workspaces.length < 2) { showToast('至少需要保留一個工作區。'); return; }
    var view = getView(id), activeCount = view ? view.panes.reduce(function (n, cell) { return n + cell.tabs.filter(isActive).length; }, 0) : 0;
    askConfirmation('刪除工作區？', '刪除工作區會結束其 ' + activeCount + ' 個執行中終端，並刪除該工作區的自動化流程。', '刪除工作區').then(function (accepted) {
      if (!accepted) return;
      if (view) {
        view.panes.forEach(function (cell) { cell.tabs.forEach(function (state) { if (isActive(state)) send(withGeneration(state, { type: 'stop' })); }); });
        view.panes.forEach(function (cell) { cell.tabs.forEach(function (state) { pruneCaptures(state); try { state.terminal.dispose(); } catch (_) { } }); });
        view.grid.remove(); views = views.filter(function (x) { return x !== view; });
      }
      appConfig.workspaces = appConfig.workspaces.filter(function (w) { return w.id !== id; });
      appConfig.automations = appConfig.automations.filter(function (f) { return f.workspaceId !== id; });
      activateWorkspace(appConfig.workspaces[0].id); queueSave();
    });
  }
  function duplicateWorkspace(id) {
    var source = getWorkspace(id); if (!source) return;
    if (appConfig.workspaces.length >= 12) { showToast('最多可建立 12 個工作區。', true); return; }
    var copy = JSON.parse(JSON.stringify(source)); copy.id = uid('workspace'); copy.name = (source.name + ' 副本').slice(0, 48);
    copy.slots.forEach(function (cell, slot) {
      var activeIndex = Math.max(0, cell.tabs.findIndex(function (tab) { return tab.id === cell.activeTabId; }));
      cell.tabs.forEach(function (tab, index) { tab.id = uid('tab'); if (!tab.name) tab.name = '終端 ' + String(index + 1); });
      cell.activeTabId = cell.tabs[activeIndex] ? cell.tabs[activeIndex].id : cell.tabs[0].id;
    });
    appConfig.workspaces.push(copy); createView(copy); renderWorkspaces(); activateWorkspace(copy.id); saveConfig(false);
    showToast('工作區已複製；新的終端不會自動啟動。');
  }
  function addTerminalTab(view, slot) {
    var cell = view.panes[slot];
    if (cell.config.tabs.length >= MAX_TABS) { showToast('每格最多可建立 8 個終端分頁。', true); return; }
    var tab = defaultTab(cell.config.tabs.length, uid('tab'));
    tab.name = '終端 ' + String(cell.config.tabs.length + 1);
    cell.config.tabs.push(tab); cell.config.activeTabId = tab.id;
    makeTerminal(view, slot, tab); renderPane(view, slot); saveConfig(false); markFocused(view, slot, tab.id); scheduleFit();
  }
  function markFocused(view, slot, tabId) {
    if (focused && focused.cell) focused.cell.element.classList.remove('is-focused');
    var state = getState(view.config.id, slot, tabId);
    if (!state) return;
    focused = { view: view, slot: slot, tabId: tabId, cell: view.panes[slot], state: state };
    focused.cell.element.classList.add('is-focused'); updateClipboardButtons();
  }
  function renderPane(view, slot) {
    var cell = view.panes[slot], element = cell.element, tab = getTabConfig(view.config, slot, cell.config.activeTabId);
    var state = activeState(view, slot);
    if (!tab || !state) return;
    element.dataset.status = state.status; element.querySelector('.pane-name').textContent = tab.name;
    element.querySelector('.pane-name').title = tab.name; element.querySelector('.pane-shell').value = tab.shell;
    element.querySelector('.pane-shell').disabled = !hostReady;
    var pwsh = element.querySelector('.pane-shell option[value="PowerShell 7"]');
    pwsh.disabled = !capabilities.pwsh && tab.shell !== 'PowerShell 7';
    pwsh.title = capabilities.pwsh ? '' : '未偵測到 PowerShell 7；可在自訂程式指定路徑';
    element.querySelector('.pane-state').textContent = stateLabel(state);
    element.querySelector('.pane-state').title = stateLabel(state);
    element.querySelector('[data-action="stop"]').disabled = !hostReady || state.status !== 'running';
    element.querySelector('[data-action="restart"]').disabled = !hostReady || isBusy(state);
    element.querySelector('[data-action="folder"]').disabled = !hostReady || isBusy(state) || pendingFolderRequest !== null;
    element.querySelector('[data-action="folder"]').title = isActive(state) ? '選擇下次啟動資料夾，不中斷目前測試' : '選擇資料夾並啟動此終端';
    element.querySelector('.pane-folder-path').textContent = tab.cwd || '工作目錄：預設';
    element.querySelector('.pane-folder-path').title = tab.cwd || '使用預設工作目錄';
    element.querySelector('.pane-start').textContent = state.status === 'starting' ? '啟動中' : '啟動';
    element.querySelectorAll('[data-action="start"]').forEach(function (button) { button.disabled = !hostReady || isActive(state); });
    var strip = element.querySelector('.pane-tabs'); strip.textContent = '';
    cell.config.tabs.forEach(function (item) {
      var button = document.createElement('button'); button.type = 'button'; button.className = 'terminal-tab';
      button.dataset.tabId = item.id; button.setAttribute('role', 'tab'); button.setAttribute('aria-selected', String(item.id === cell.config.activeTabId));
      button.title = item.name + ' · ' + stateLabel(getState(view.config.id, slot, item.id)); button.textContent = item.name;
      var remove = document.createElement('span'); remove.className = 'terminal-tab-close'; remove.textContent = '×'; remove.title = '移除此終端分頁';
      remove.addEventListener('click', function (event) { event.stopPropagation(); removeTerminalTab(view, slot, item.id); });
      button.appendChild(remove); strip.appendChild(button);
    });
    var plus = document.createElement('button'); plus.type = 'button'; plus.className = 'terminal-tab-add'; plus.dataset.addTab = 'true'; plus.textContent = '＋'; plus.title = '在此格新增終端分頁'; plus.disabled = cell.config.tabs.length >= MAX_TABS; strip.appendChild(plus);
    cell.tabs.forEach(function (child) {
      var selected = child.tabId === cell.config.activeTabId;
      child.layer.hidden = !selected; child.layer.querySelector('.empty-name').textContent = child.status === 'starting' ? '正在建立終端…' : child.status === 'error' ? '請檢查設定後重試' : '準備開始新的測試';
      child.layer.querySelector('.empty-command').textContent = child.status === 'error' ? '啟動失敗' : (getTabConfig(view.config, slot, child.tabId).command || getTabConfig(view.config, slot, child.tabId).shell + ' · 可直接輸入指令');
      child.layer.querySelector('.pane-empty').hidden = child.hasOutput || child.status === 'running' || child.status === 'stopping';
      var exit = child.layer.querySelector('.exit-notice'); exit.hidden = child.status !== 'exited' || !child.hasOutput;
      exit.textContent = '已結束 · 結束碼 ' + (child.exitCode === null ? '—' : child.exitCode) + ' · 輸出已保留';
      child.terminal.options.disableStdin = child.status !== 'running';
      child.terminal.options.fontSize = view.config.fontSize;
    });
  }
  function removeTerminalTab(view, slot, tabId) {
    var cell = view.panes[slot], state = getState(view.config.id, slot, tabId);
    if (!state || cell.config.tabs.length <= 1) { showToast('每格至少保留一個終端分頁。'); return; }
    askConfirmation('移除終端分頁？', '「' + (getTabConfig(view.config, slot, tabId).name) + '」中的執行中程序也會結束。', '移除分頁').then(function (accepted) {
      if (!accepted) return;
      if (isActive(state)) send(withGeneration(state, { type: 'stop' }));
      pruneCaptures(state); state.terminal.dispose(); state.layer.remove();
      cell.tabs = cell.tabs.filter(function (s) { return s !== state; });
      cell.config.tabs = cell.config.tabs.filter(function (t) { return t.id !== tabId; });
      if (cell.config.activeTabId === tabId) cell.config.activeTabId = cell.config.tabs[0].id;
      renderPane(view, slot); queueSave(); updateCounts();
    });
  }
  function applyLayout(view) {
    if (!view) return;
    var config = view.config, count = config.rows * config.cols, grid = view.grid;
    grid.style.setProperty('--grid-rows', String(config.rows)); grid.style.setProperty('--grid-cols', String(config.cols));
    if (view === activeView) {
      $('rowSelect').value = String(config.rows); $('colSelect').value = String(config.cols);
      var preset = config.rows + 'x' + config.cols;
      $('presetSelect').value = ['2x2', '2x3', '3x3', '3x4'].indexOf(preset) >= 0 ? preset : 'custom';
      $('fontSizeLabel').textContent = config.fontSize; $('fontMinus').disabled = config.fontSize <= 10;
      $('fontPlus').disabled = config.fontSize >= 24; $('layoutStatus').textContent = config.rows + ' × ' + config.cols;
      $('unzoomButton').hidden = view.zoomedSlot === null;
    }
    if (view.zoomedSlot !== null && view.zoomedSlot >= count) view.zoomedSlot = null;
    grid.classList.toggle('is-zoomed', view.zoomedSlot !== null);
    view.panes.forEach(function (cell, i) {
      cell.element.hidden = i >= count; cell.element.classList.toggle('zoom-target', i === view.zoomedSlot);
      cell.element.querySelector('[data-action="zoom"]').title = i === view.zoomedSlot ? '返回網格' : '放大終端';
      renderPane(view, i);
    });
    scheduleFit(); updateCounts();
  }
  function updateCounts() {
    var active = 0, hidden = 0;
    views.forEach(function (view) {
      var count = view.config.rows * view.config.cols;
      view.panes.forEach(function (cell, slot) {
        cell.tabs.forEach(function (state) {
          if (!isActive(state)) return;
          active++;
          if (view === activeView && (slot >= count || (view.zoomedSlot !== null && slot !== view.zoomedSlot) || cell.config.activeTabId !== state.tabId)) hidden++;
        });
      });
    });
    $('sessionCount').textContent = active + ' 個執行中';
    $('hiddenButton').hidden = hidden === 0;
    $('hiddenButton').textContent = hidden + ' 個執行中終端已隱藏';
    $('hiddenButton').title = '顯示目前工作區全部 16 格；其他工作區的終端會繼續執行。';
    $('startAllButton').disabled = !hostReady || !activeView;
    updateClipboardButtons();
  }
  function updateClipboardButtons() {
    $('copyButton').disabled = !focused;
    $('pasteButton').disabled = !hostReady || !focused || focused.state.status !== 'running';
  }
  function scheduleFit() {
    if (fitFrame !== null) return;
    fitFrame = window.requestAnimationFrame(function () {
      fitFrame = null;
      views.forEach(function (view) {
        if (view !== activeView) return;
        view.panes.forEach(function (cell, slot) {
          if (cell.element.hidden || (view.zoomedSlot !== null && slot !== view.zoomedSlot)) return;
          var state = activeState(view, slot);
          if (state && !state.layer.hidden && cell.element.clientWidth > 20 && cell.element.clientHeight > 80) {
            try { state.fit.fit(); } catch (_) { }
          }
        });
      });
    });
  }
  function toggleZoom(view, slot) {
    view.zoomedSlot = view.zoomedSlot === slot ? null : slot; applyLayout(view); markFocused(view, slot, activeState(view, slot).tabId);
    window.requestAnimationFrame(function () { activeState(view, slot).terminal.focus(); });
  }
  function validateState(view, slot, tabId) {
    var setting = getTabConfig(view.config, slot, tabId);
    if (!setting) return false;
    if (setting.shell === 'Custom' && !setting.exe.trim()) { showToast('請先設定自訂程式。', true); openSettings(view, slot, tabId); return false; }
    if (setting.shell === 'PowerShell 7' && !capabilities.pwsh) { showToast('未偵測到 PowerShell 7；請選自訂程式指定 pwsh.exe。', true); return false; }
    return true;
  }
  function startSlot(view, slot, tabId, clear) {
    var state = getState(view.config.id, slot, tabId), setting = getTabConfig(view.config, slot, tabId);
    if (!hostReady || !state || isActive(state) || !validateState(view, slot, tabId)) return false;
    state.clearOnStarted = !!clear; state.status = 'starting'; state.exitCode = null;
    try { state.fit.fit(); } catch (_) { }
    var sent = send({ type: 'start', workspaceId: view.config.id, slot: slot, tabId: tabId,
      config: Object.assign({}, setting), cols: Math.max(2, state.terminal.cols), rows: Math.max(1, state.terminal.rows) });
    if (!sent) state.status = 'error';
    renderPane(view, slot); updateCounts(); markFocused(view, slot, tabId); state.terminal.focus();
    return sent;
  }
  function requestStop(state) {
    if (!hostReady || !state || state.status !== 'running') return;
    askConfirmation('結束此終端？', '這會結束此分頁中的終端與測試。畫面輸出會保留。', '結束終端').then(function (ok) {
      if (!ok || state.status !== 'running') return;
      state.status = 'stopping'; renderPane(getView(state.workspaceId), state.slot); updateCounts();
      send(withGeneration(state, { type: 'stop' }));
    });
  }
  function requestRestart(view, slot, tabId) {
    var state = getState(view.config.id, slot, tabId);
    if (!hostReady || !state || isBusy(state) || !validateState(view, slot, tabId)) return;
    var confirm = isActive(state) ? askConfirmation('重新啟動終端？', '這會結束目前測試、清除輸出，再依目前設定啟動。', '重新啟動') : Promise.resolve(true);
    confirm.then(function (ok) {
      if (!ok || isBusy(state)) return;
      state.clearOnStarted = true; state.status = 'starting'; state.exitCode = null;
      send(withGeneration(state, { type: 'restart', config: Object.assign({}, getTabConfig(view.config, slot, tabId)),
        cols: Math.max(2, state.terminal.cols), rows: Math.max(1, state.terminal.rows) }));
      renderPane(view, slot); updateCounts(); markFocused(view, slot, tabId);
    });
  }
  function choosePaneFolder(view, slot, tabId) {
    var state = getState(view.config.id, slot, tabId);
    if (!hostReady || pendingFolderRequest || isBusy(state)) return;
    requestFolder(view, slot, tabId, 'pane', getTabConfig(view.config, slot, tabId).cwd, !isActive(state));
  }
  function requestFolder(view, slot, tabId, purpose, initialPath, autoStart) {
    if (!hostReady || pendingFolderRequest) return;
    var requestId = 'folder-' + (++folderRequestSequence) + '-' + Date.now();
    pendingFolderRequest = { requestId: requestId, workspaceId: view.config.id, slot: slot, tabId: tabId,
      purpose: purpose, autoStart: !!autoStart, settingsSession: settingsSession, valid: true };
    refreshFolderControls();
    if (!send({ type: 'pickFolder', workspaceId: view.config.id, slot: slot, tabId: tabId, requestId: requestId, initialPath: initialPath || '' })) {
      pendingFolderRequest = null; refreshFolderControls();
    }
  }
  function refreshFolderControls() {
    views.forEach(function (view) { view.panes.forEach(function (_, slot) { renderPane(view, slot); }); });
    $('settingBrowse').disabled = !hostReady || pendingFolderRequest !== null;
  }
  function handleFolderResult(message) {
    var request = pendingFolderRequest;
    if (!request || message.requestId !== request.requestId || message.workspaceId !== request.workspaceId || message.slot !== request.slot || message.tabId !== request.tabId) return;
    pendingFolderRequest = null; refreshFolderControls();
    if (!request.valid) return;
    if (request.purpose === 'settings' && (request.settingsSession !== settingsSession || !settingsRef || !$('settingsDialog').open)) return;
    if (message.type === 'folderPickError') { showToast('無法選擇資料夾：' + (message.message || '請稍後重試。'), true); return; }
    if (message.cancelled) return;
    if (typeof message.path !== 'string' || !message.path.trim() || message.path.length > 4096) { showToast('未取得有效資料夾路徑。', true); return; }
    if (request.purpose === 'settings') { $('settingCwd').value = message.path; $('settingCwd').focus(); return; }
    var view = getView(request.workspaceId), tab = getTabConfig(view.config, request.slot, request.tabId);
    tab.cwd = message.path; renderPane(view, request.slot); queueSave();
    var state = getState(request.workspaceId, request.slot, request.tabId);
    if (request.autoStart && !isActive(state)) startSlot(view, request.slot, request.tabId, false);
    else showToast('已設定「' + tab.name + '」下次啟動資料夾。');
  }
  function closeSettings() {
    if (pendingFolderRequest && pendingFolderRequest.purpose === 'settings') pendingFolderRequest.valid = false;
    settingsSession++; settingsRef = null; $('settingExe').setCustomValidity(''); $('settingsDialog').close();
  }
  function openSettings(view, slot, tabId) {
    if ($('settingsDialog').open || $('confirmDialog').open) return;
    settingsSession++; settingsRef = { workspaceId: view.config.id, slot: slot, tabId: tabId };
    var setting = getTabConfig(view.config, slot, tabId);
    $('settingsTitle').textContent = '第 ' + String(slot + 1).padStart(2, '0') + ' 格 · ' + setting.name;
    $('settingName').value = setting.name; $('settingShell').value = setting.shell; $('settingCwd').value = setting.cwd;
    $('settingExe').value = setting.exe; $('settingArgs').value = setting.args; $('settingCommand').value = setting.command;
    $('settingShell').querySelector('option[value="PowerShell 7"]').disabled = !capabilities.pwsh && setting.shell !== 'PowerShell 7';
    $('settingBrowse').disabled = !hostReady || pendingFolderRequest !== null; updateCustomFields(); $('settingsDialog').showModal();
    $('settingName').focus(); $('settingName').select();
  }
  function updateCustomFields() {
    var custom = $('settingShell').value === 'Custom'; $('customFields').hidden = !custom; $('settingCommand').disabled = custom;
    $('commandHint').textContent = custom ? '自訂程式請使用上方的啟動參數。此欄指令不會傳送給自訂程式。' : '儲存設定不會執行指令；修改會在下次啟動生效。';
    $('settingExe').setCustomValidity('');
  }
  function askConfirmation(title, message, acceptLabel) {
    if (confirmation) return Promise.resolve(false);
    return new Promise(function (resolve) {
      confirmation = resolve; $('confirmTitle').textContent = title; $('confirmMessage').textContent = message;
      $('confirmAccept').textContent = acceptLabel; $('confirmDialog').showModal(); $('confirmCancel').focus();
    });
  }
  function finishConfirmation(accepted) {
    var resolve = confirmation; confirmation = null; $('confirmDialog').close(); if (resolve) resolve(accepted);
  }
  async function copySelection(state) {
    var selection = state.terminal.getSelection();
    if (!selection) { showToast('請先選取要複製的文字。'); return; }
    try { await navigator.clipboard.writeText(selection); showToast('已複製終端文字。'); }
    catch (_) { showToast('無法使用剪貼簿，請檢查系統權限。', true); }
  }
  async function pasteClipboard(state) {
    if (state.status !== 'running') { showToast('請先啟動這個終端分頁。'); return; }
    try { await pasteText(state, await navigator.clipboard.readText()); }
    catch (_) { showToast('無法讀取剪貼簿，請檢查系統權限。', true); }
  }
  async function pasteText(state, value) {
    if (!value || state.status !== 'running') return;
    if (value.length > 1048576) { showToast('剪貼簿文字超過 1 MB。', true); return; }
    if (/[\r\n]/.test(value)) {
      var preview = value.length > 500 ? value.slice(0, 500) + '\n…（僅顯示前 500 字）' : value;
      if (!(await askConfirmation('貼上多行文字？', '多行貼上可能執行指令，請先檢查內容。\n\n' + preview, '確認貼上'))) return;
    }
    if (state.status !== 'running') return;
    state.terminal.paste(value); state.terminal.focus();
  }
  async function insertCommand(state, value, captured) {
    if (!state || state.status !== 'running') { showToast('請先啟動要插入指令的終端分頁。'); return; }
    if (/[\r\n]/.test(value)) { showToast('指令包只接受單行指令；請編輯指令內容後重試。', true); return; }
    if (value.length > 16000) { showToast('指令超過 16,000 字元。', true); return; }
    state.terminal.paste(value); state.terminal.focus();
    showToast((captured ? '暫存文字已插入' : '指令已插入') + '，請檢查後自行按 Enter 執行。');
  }
  function isStale(state, message, allowNew) {
    if (typeof message.generation !== 'number' || state.generation === null) return false;
    return allowNew ? message.generation < state.generation : message.generation !== state.generation;
  }
  function handleHostMessage(message) {
    if (!message || typeof message !== 'object' || typeof message.type !== 'string') return;
    if (message.type === 'folderPicked' || message.type === 'folderPickError') { handleFolderResult(message); return; }
    if (message.type === 'init') {
      invalidateFolderRequests(); destroyViews(); appConfig = normalizeAppConfig(message.config);
      capabilities = Object.assign({ pwsh: false }, message.capabilities || {}); hostReady = true;
      appConfig.workspaces.forEach(createView); activateWorkspace(appConfig.activeWorkspaceId);
      $('connectionDot').className = 'connection-dot connected'; $('connectionText').textContent = '終端引擎已就緒';
      $('connectionText').title = 'Terminal Grid ' + (message.version || '3.0') + ' · Windows ConPTY';
      $('saveButton').disabled = false; $('exportButton').disabled = false; $('importButton').disabled = false;
      renderFlowOptions(); renderCommandLibrary(); applyLayout(activeView); setStatus('選工作區，再在格子右上角按 ＋ 加終端分頁。'); return;
    }
    if (message.type === 'imported') {
      invalidateFolderRequests();
      if ($('settingsDialog').open) closeSettings();
      destroyViews(); appConfig = normalizeAppConfig(message.config);
      appConfig.workspaces.forEach(createView); activateWorkspace(appConfig.activeWorkspaceId);
      renderFlowOptions(); renderCommandLibrary(); showToast('配置已匯入。終端指令不會自動執行。'); return;
    }
    if (message.type === 'flowLoaded') { loadFlowFile(message.text, message.fileName); return; }
    if (message.type === 'commandPackLoaded') { loadCommandPackFile(message.text, message.fileName); return; }
    if (message.type === 'fileError') { showToast(message.message || '檔案操作失敗。', true); return; }
    if (message.type === 'status') { setStatus(message.message); return; }
    var state = getState(String(message.workspaceId || appConfig.activeWorkspaceId), Number(message.slot), String(message.tabId || ''));
    if (!state) return;
    var view = getView(state.workspaceId);
    if (message.type === 'error') {
      if (isStale(state, message, true)) return;
      if (typeof message.generation === 'number') state.generation = message.generation;
      if (state.status === 'starting' || state.status === 'stopping') state.status = 'error';
      renderPane(view, state.slot); updateCounts(); showToast(getTabConfig(view.config, state.slot, state.tabId).name + '：' + (message.message || '終端發生錯誤。'), true); return;
    }
    if (message.type === 'started') {
      if (isStale(state, message, true)) return;
      pruneCaptures(state); resetCaptureScanner(state);
      if (typeof message.generation === 'number') state.generation = message.generation;
      if (state.clearOnStarted) { state.terminal.reset(); state.hasOutput = false; }
      state.clearOnStarted = false; state.status = 'running'; state.pid = message.pid || null; state.exitCode = null;
      renderPane(view, state.slot); updateCounts(); scheduleFit();
      window.requestAnimationFrame(function () {
        if (state.status !== 'running' || view !== activeView || view.panes[state.slot].config.activeTabId !== state.tabId) return;
        try { state.fit.fit(); } catch (_) { }
        send(withGeneration(state, { type: 'resize', cols: Math.max(2, state.terminal.cols), rows: Math.max(1, state.terminal.rows) }));
      });
      return;
    }
    if (isStale(state, message, false)) return;
    if (message.type === 'output') {
      if (typeof message.data !== 'string' || !message.data) return;
      try {
        var binary = window.atob(message.data), bytes = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        var gen = message.generation, size = bytes.length;
        state.terminal.write(bytes, function () { send({ type: 'ack', workspaceId: state.workspaceId, slot: state.slot, tabId: state.tabId, bytes: size, generation: gen }); });
        try { if ($('captureEnabled').checked) state.captureScanner.feed(state.captureDecoder.decode(bytes, { stream: true })); }
        catch (_) { resetCaptureScanner(state); setStatus('IPv6 擷取已重設；終端輸出繼續顯示。'); }
        if (!state.hasOutput) { state.hasOutput = true; renderPane(view, state.slot); }
      } catch (_) { setStatus('無法解碼終端輸出。'); }
      return;
    }
    if (message.type === 'exited') {
      try { if ($('captureEnabled').checked) { state.captureScanner.feed(state.captureDecoder.decode()); state.captureScanner.flush(); } } catch (_) { resetCaptureScanner(state); }
      state.status = 'exited'; state.pid = null; state.exitCode = typeof message.exitCode === 'number' ? message.exitCode : null;
      renderPane(view, state.slot); updateCounts(); return;
    }
  }
  function invalidateFolderRequests() { if (pendingFolderRequest) pendingFolderRequest.valid = false; }

  function renderFlowOptions() {
    var select = $('flowSelect'); if (!select) return;
    select.textContent = '';
    appConfig.automations.forEach(function (flow) { var option = document.createElement('option'); option.value = flow.id; option.textContent = flow.name; select.appendChild(option); });
    if (currentFlowId && appConfig.automations.some(function (f) { return f.id === currentFlowId; })) select.value = currentFlowId;
    if (!appConfig.automations.length) select.appendChild(new Option('（尚無已儲存流程）', ''));
    currentFlowId = select.value || null; renderFlowEditor();
  }
  function currentFlow() { return appConfig.automations.find(function (f) { return f.id === currentFlowId; }) || null; }
  function newFlow() {
    var flow = { id: uid('flow'), name: '新自動化流程', workspaceId: (activeView || { config: appConfig.workspaces[0] }).config.id, steps: [] };
    appConfig.automations.push(flow); currentFlowId = flow.id; renderFlowOptions(); queueSave();
    $('flowName').focus(); $('flowName').select();
  }
  function flowWorkspace(flow) { return getWorkspace(flow && flow.workspaceId); }
  function renderFlowEditor() {
    var flow = currentFlow(), stepsHost = $('flowSteps');
    if (!stepsHost) return;
    stepsHost.textContent = '';
    $('flowName').disabled = !flow || flowRunning; $('flowName').value = flow ? flow.name : '';
    $('flowSelect').disabled = flowRunning;
    $('flowWorkspaceLabel').textContent = flow && flowWorkspace(flow) ? '目標工作區：' + flowWorkspace(flow).name : '';
    $('addFlowStepButton').disabled = !flow || flowRunning; $('runFlowButton').disabled = !flow || !flow.steps.length || flowRunning;
    $('saveFlowFileButton').disabled = !flow || flowRunning; $('deleteFlowButton').disabled = !flow || flowRunning;
    if (!flow) { stepsHost.innerHTML = '<p class="help-note">新增流程，逐步安排啟動、輸入指令、等待或結束終端。</p>'; return; }
    var workspace = flowWorkspace(flow);
    if (!workspace) { stepsHost.textContent = '找不到此流程的工作區。'; return; }
    flow.steps.forEach(function (step, index) {
      var row = document.createElement('div'); row.className = 'flow-step';
      var action = document.createElement('select');
      [['start', '啟動終端'], ['send', '輸入指令'], ['wait', '等待時間'], ['pause', '等待操作後繼續'], ['stop', '結束終端']].forEach(function (item) { var o = new Option(item[1], item[0]); action.add(o); });
      action.value = step.action;
      var slot = document.createElement('select'); slot.className = 'flow-slot flow-target';
      for (var i = 0; i < MAX_SLOTS; i++) slot.add(new Option(String(i + 1).padStart(2, '0') + ' 格', String(i)));
      slot.value = String(step.slot);
      var tab = document.createElement('select'); tab.className = 'flow-tab flow-target'; fillFlowTabs(tab, workspace, step.slot, step.tabId);
      var textInput = document.createElement('input'); textInput.className = 'flow-step-text'; textInput.value = step.action === 'wait' ? String(step.delayMs) : (step.text || ''); textInput.placeholder = step.action === 'wait' ? '毫秒（100–30000）' : step.action === 'pause' ? '提示使用者要完成的操作' : '指令內容';
      var enterLabel = document.createElement('label'); enterLabel.className = 'flow-enter'; var enter = document.createElement('input'); enter.type = 'checkbox'; enter.checked = step.enter !== false; enterLabel.append(enter, document.createTextNode('Enter'));
      var moveUp = document.createElement('button'); moveUp.type = 'button'; moveUp.className = 'icon-button flow-move'; moveUp.textContent = '↑'; moveUp.title = '上移步驟'; moveUp.disabled = index === 0;
      var moveDown = document.createElement('button'); moveDown.type = 'button'; moveDown.className = 'icon-button flow-move'; moveDown.textContent = '↓'; moveDown.title = '下移步驟'; moveDown.disabled = index === flow.steps.length - 1;
      var remove = document.createElement('button'); remove.type = 'button'; remove.className = 'icon-button'; remove.textContent = '×'; remove.title = '移除此步驟';
      action.disabled = slot.disabled = tab.disabled = textInput.disabled = enter.disabled = flowRunning;
      moveUp.disabled = moveUp.disabled || flowRunning; moveDown.disabled = moveDown.disabled || flowRunning; remove.disabled = flowRunning;
      row.dataset.action = step.action;
      row.append(action, slot, tab, textInput, enterLabel, moveUp, moveDown, remove); stepsHost.appendChild(row);
      action.addEventListener('change', function () { step.action = action.value; row.dataset.action = step.action; textInput.placeholder = step.action === 'wait' ? '毫秒（100–30000）' : step.action === 'pause' ? '提示使用者要完成的操作' : '指令內容'; textInput.value = step.action === 'wait' ? String(step.delayMs) : step.text; textInput.hidden = step.action === 'start' || step.action === 'stop'; enterLabel.hidden = step.action !== 'send'; slot.hidden = tab.hidden = step.action === 'wait' || step.action === 'pause'; queueSave(); });
      slot.addEventListener('change', function () { step.slot = Number(slot.value); step.tabId = ''; fillFlowTabs(tab, workspace, step.slot, ''); queueSave(); });
      tab.addEventListener('change', function () { step.tabId = tab.value; queueSave(); });
      textInput.addEventListener('input', function () { if (step.action === 'wait') step.delayMs = limitNumber(textInput.value, 500, 100, 30000); else step.text = textInput.value.slice(0, 16000); queueSave(); });
      enter.addEventListener('change', function () { step.enter = enter.checked; queueSave(); });
      moveUp.addEventListener('click', function () { var item = flow.steps.splice(index, 1)[0]; flow.steps.splice(index - 1, 0, item); renderFlowEditor(); queueSave(); });
      moveDown.addEventListener('click', function () { var item = flow.steps.splice(index, 1)[0]; flow.steps.splice(index + 1, 0, item); renderFlowEditor(); queueSave(); });
      remove.addEventListener('click', function () { flow.steps.splice(index, 1); renderFlowEditor(); queueSave(); });
      textInput.hidden = step.action === 'start' || step.action === 'stop'; enterLabel.hidden = step.action !== 'send'; slot.hidden = tab.hidden = step.action === 'wait' || step.action === 'pause';
    });
  }
  function fillFlowTabs(select, workspace, slot, selectedId) {
    select.textContent = '';
    var cell = workspace.slots[slot];
    cell.tabs.forEach(function (tab) { select.add(new Option(tab.name, tab.id)); });
    select.value = cell.tabs.some(function (t) { return t.id === selectedId; }) ? selectedId : cell.activeTabId;
  }
  function addFlowStep() {
    var flow = currentFlow(); if (!flow || flow.steps.length >= 100) return;
    var workspace = flowWorkspace(flow); flow.steps.push({ action: 'send', slot: 0, tabId: workspace.slots[0].activeTabId, text: '', delayMs: 500, enter: true });
    renderFlowEditor(); queueSave();
  }
  function flowFileObject(flow) {
    var workspace = flowWorkspace(flow);
    return { format: 'terminal-grid-flow', version: 1, name: flow.name,
      workspace: JSON.parse(JSON.stringify(workspace)), steps: JSON.parse(JSON.stringify(flow.steps)) };
  }
  function saveFlowFile() {
    var flow = currentFlow(); if (!flow || !hostReady) return;
    send({ type: 'flowSave', text: JSON.stringify(flowFileObject(flow), null, 2) });
  }
  function loadFlowFile(text, fileName) {
    try {
      if (typeof text !== 'string' || text.length > 1024 * 1024) throw new Error('流程檔超過 1 MB。');
      var data = JSON.parse(text);
      if (data.format !== 'terminal-grid-flow' || !data.workspace || !Array.isArray(data.steps) || data.steps.length > 100) throw new Error('檔案格式不正確。');
      var workspace = normalizeWorkspace(data.workspace, appConfig.workspaces.length);
      workspace.id = uid('workspace'); workspace.name = (data.workspace.name || '匯入工作區').slice(0, 40) + ' · 匯入';
      if (appConfig.workspaces.length >= 12) throw new Error('工作區已達 12 個上限，請先刪除一個工作區。');
      var steps = data.steps.map(function (s) {
        var slot = limitNumber(s.slot, 0, 0, 15), cell = workspace.slots[slot];
        var tabId = cell.tabs.some(function (t) { return t.id === s.tabId; }) ? s.tabId : cell.activeTabId;
        return { action: ['start', 'send', 'wait', 'pause', 'stop'].indexOf(s.action) >= 0 ? s.action : 'send',
          slot: slot, tabId: tabId, text: str(s.text, 16000), delayMs: limitNumber(s.delayMs, 500, 100, 30000), enter: s.enter !== false };
      });
      var flow = { id: uid('flow'), name: str(data.name, 64).trim() || (fileName || '匯入流程').replace(/\.tgridflow$/i, ''),
        workspaceId: workspace.id, steps: steps };
      if (appConfig.automations.length >= 32) throw new Error('已達 32 個流程上限。');
      appConfig.workspaces.push(workspace); appConfig.automations.push(flow);
      if (!getView(workspace.id)) createView(workspace);
      currentFlowId = flow.id; renderWorkspaces(); renderFlowOptions(); activateWorkspace(workspace.id); saveConfig(false);
      showToast('流程已匯入並保存；檢視步驟後按「執行流程」才會送出指令。');
      if (!$('flowDialog').open) $('flowDialog').showModal();
    } catch (error) { showToast('匯入流程失敗：' + error.message, true); }
  }
  function waitForUserContinue(instruction, stepNumber) {
    if (flowPauseResolve) return Promise.resolve(false);
    $('flowPauseTitle').textContent = '流程暫停 · 第 ' + stepNumber + ' 步';
    $('flowPauseMessage').textContent = instruction || '請完成需要的手動操作，完成後按「繼續」。';
    return new Promise(function (resolve) { flowPauseResolve = resolve; $('flowPauseDialog').showModal(); $('continuePausedFlowButton').focus(); });
  }
  function finishFlowPause(continueFlow) {
    var resolve = flowPauseResolve; flowPauseResolve = null;
    if ($('flowPauseDialog').open) $('flowPauseDialog').close();
    if (resolve) resolve(continueFlow);
  }
  async function runFlow() {
    var flow = currentFlow(); if (!flow || flowRunning) return;
    var workspace = flowWorkspace(flow);
    var summary = flow.steps.map(function (step, i) {
      var tab = workspace.slots[step.slot].tabs.find(function (t) { return t.id === step.tabId; }) || workspace.slots[step.slot].tabs[0];
      var verb = step.action === 'send' ? ((step.text || '（空指令）') + (step.enter ? '  ↵' : '')) : step.action === 'wait' ? '等待 ' + step.delayMs + ' ms' : step.action === 'pause' ? '等待使用者：' + (step.text || '完成操作後按繼續') : step.action === 'start' ? ('啟動 ' + tab.shell + (tab.exe ? ' · ' + tab.exe + ' ' + tab.args : '') + (tab.cwd ? ' · 目錄 ' + tab.cwd : '') + (tab.command ? '\n啟動指令：' + tab.command : '')) : '結束終端';
      return step.action === 'pause' || step.action === 'wait' ? (i + 1) + '. ' + verb : (i + 1) + '. ' + String(step.slot + 1).padStart(2, '0') + ' 格 / ' + tab.name + ' · ' + verb;
    }).join('\n');
    if (!(await askConfirmation('執行「' + flow.name + '」？', '以下步驟會依序送到本機終端：\n\n' + summary + '\n\n請確認目標與指令正確。', '確認執行'))) return;
    flowRunning = true; renderFlowEditor();
    try {
      for (var i = 0; i < flow.steps.length; i++) {
        var step = flow.steps[i];
        if (step.action === 'wait') { await delay(limitNumber(step.delayMs, 500, 100, 30000)); continue; }
        if (step.action === 'pause') {
          if (!(await waitForUserContinue(step.text, i + 1))) throw new Error('已停止後續自動化步驟。');
          continue;
        }
        var view = getView(flow.workspaceId), state = getState(flow.workspaceId, step.slot, step.tabId);
        if (!view || !state) throw new Error('第 ' + (i + 1) + ' 步找不到目標終端。');
        activateWorkspace(flow.workspaceId); view.panes[step.slot].config.activeTabId = step.tabId; renderPane(view, step.slot); markFocused(view, step.slot, step.tabId);
        if (step.action === 'start') {
          if (!isActive(state) && !startSlot(view, step.slot, step.tabId, false)) throw new Error('第 ' + (i + 1) + ' 步無法啟動終端。');
          var startDeadline = Date.now() + 30000;
          while (state.status === 'starting' && Date.now() < startDeadline) await delay(100);
          if (state.status !== 'running') throw new Error('第 ' + (i + 1) + ' 步啟動失敗或逾時。');
        } else if (step.action === 'send') {
          if (state.status !== 'running') throw new Error('第 ' + (i + 1) + ' 步目標尚未執行；請先加入「啟動終端」步驟。');
          if (step.text) send(withGeneration(state, { type: 'input', data: step.text + (step.enter ? '\r' : '') }));
        } else if (step.action === 'stop') {
          if (state.status === 'running') { state.status = 'stopping'; renderPane(view, step.slot); send(withGeneration(state, { type: 'stop' })); }
          var stopDeadline = Date.now() + 10000;
          while (state.status === 'stopping' && Date.now() < stopDeadline) await delay(100);
        }
        if (step.delayMs > 0) await delay(limitNumber(step.delayMs, 500, 100, 30000));
      }
      showToast('流程「' + flow.name + '」已完成。');
    } catch (error) { showToast('流程已停止：' + error.message, true); }
    finally { flowRunning = false; renderFlowEditor(); updateCounts(); }
  }
  function deleteFlow() {
    var flow = currentFlow(); if (!flow) return;
    appConfig.automations = appConfig.automations.filter(function (f) { return f !== flow; }); currentFlowId = null;
    renderFlowOptions(); queueSave();
  }
  function renderCommandLibrary() {
    if (!$('commandPackSelect')) return;
    var select = $('commandPackSelect'), previous = select.value; select.textContent = '';
    appConfig.commandPacks.forEach(function (pack) { select.add(new Option(pack.name, pack.id)); });
    if (!appConfig.commandPacks.length) select.add(new Option('（無指令包）', ''));
    if (appConfig.commandPacks.some(function (p) { return p.id === previous; })) select.value = previous;
    var pack = appConfig.commandPacks.find(function (p) { return p.id === select.value; });
    $('renamePackButton').disabled = !pack; $('duplicatePackButton').disabled = !pack || appConfig.commandPacks.length >= 32;
    $('deletePackButton').disabled = !pack || appConfig.commandPacks.length <= 1;
    $('addCommandButton').disabled = !pack || pack.commands.length >= 128; $('exportPackButton').disabled = !pack;
    var list = $('commandList'); list.textContent = '';
    if (!pack || !pack.commands.length) { list.innerHTML = '<p class="help-note">此指令包目前是空的。可新增指令或匯入 .tgridcmd。</p>'; return; }
    pack.commands.forEach(function (command) {
      var item = document.createElement('div'); item.className = 'command-item'; item.draggable = true;
      var details = document.createElement('div'); details.className = 'command-details';
      var title = document.createElement('strong'); title.textContent = command.name;
      var desc = document.createElement('span'); desc.textContent = command.description || command.command;
      var code = document.createElement('code'); code.textContent = command.command;
      details.append(title, desc, code);
      var insert = document.createElement('button'); insert.type = 'button'; insert.className = 'button'; insert.textContent = '插入';
      insert.addEventListener('click', function () { if (focused) insertCommand(focused.state, command.command); else showToast('請先選取一個終端分頁。'); });
      var edit = document.createElement('button'); edit.type = 'button'; edit.className = 'icon-button'; edit.textContent = '⋯'; edit.title = '編輯／刪除';
      edit.addEventListener('click', function () { openCommandEditor(pack, command); });
      item.append(details, insert, edit);
      item.addEventListener('dragstart', function (event) { event.dataTransfer.setData('application/x-terminalgrid-command', command.command); event.dataTransfer.setData('text/plain', command.command); event.dataTransfer.effectAllowed = 'copy'; });
      list.appendChild(item);
    });
  }
  function selectedCommandPack() { return appConfig.commandPacks.find(function (p) { return p.id === $('commandPackSelect').value; }) || null; }
  function openPackDialog(pack) {
    packEditingId = pack ? pack.id : null; $('packDialogTitle').textContent = pack ? '重新命名指令包' : '新增指令包';
    $('packNameInput').value = pack ? pack.name : '我的指令包'; $('packDialog').showModal(); $('packNameInput').focus(); $('packNameInput').select();
  }
  function savePackDialog(event) {
    event.preventDefault(); var name = $('packNameInput').value.trim(); if (!name) { $('packNameInput').focus(); return; }
    var pack = packEditingId ? appConfig.commandPacks.find(function (p) { return p.id === packEditingId; }) : null;
    if (pack) pack.name = name.slice(0, 64);
    else {
      if (appConfig.commandPacks.length >= 32) { $('packDialog').close(); showToast('最多可建立 32 個指令包。', true); return; }
      pack = { id: uid('pack'), name: name.slice(0, 64), commands: [] }; appConfig.commandPacks.push(pack);
    }
    $('packDialog').close(); renderCommandLibrary(); $('commandPackSelect').value = pack.id; renderCommandLibrary(); queueSave();
  }
  function duplicateCommandPack() {
    var source = selectedCommandPack(); if (!source) return;
    if (appConfig.commandPacks.length >= 32) { showToast('最多可建立 32 個指令包。', true); return; }
    var pack = { id: uid('pack'), name: (source.name + ' 副本').slice(0, 64), commands: source.commands.map(function (command) {
      return { id: uid('cmd'), name: command.name, description: command.description, command: command.command };
    }) };
    appConfig.commandPacks.push(pack); renderCommandLibrary(); $('commandPackSelect').value = pack.id; renderCommandLibrary(); queueSave(); showToast('指令包已複製。');
  }
  function deleteCommandPack() {
    var pack = selectedCommandPack(); if (!pack) return;
    if (appConfig.commandPacks.length <= 1) { showToast('至少需要保留一個指令包。'); return; }
    askConfirmation('刪除指令包？', '將刪除「' + pack.name + '」及其中 ' + pack.commands.length + ' 個常用指令。', '刪除指令包').then(function (accepted) {
      if (!accepted) return;
      appConfig.commandPacks = appConfig.commandPacks.filter(function (item) { return item !== pack; });
      renderCommandLibrary(); queueSave();
    });
  }
  function openCommandEditor(pack, command) {
    commandEditingRef = { packId: pack.id, commandId: command ? command.id : null };
    $('commandEditTitle').textContent = command ? '編輯常用指令' : '新增常用指令';
    $('commandNameInput').value = command ? command.name : '';
    $('commandDescriptionInput').value = command ? command.description : '';
    $('commandTextInput').value = command ? command.command : '';
    $('deleteCommandButton').hidden = !command;
    $('commandEditDialog').showModal(); $('commandNameInput').focus();
  }
  function saveCommandEditor(event) {
    event.preventDefault(); var ref = commandEditingRef; if (!ref) return;
    var pack = appConfig.commandPacks.find(function (item) { return item.id === ref.packId; });
    if (!pack) { $('commandEditDialog').close(); return; }
    var name = $('commandNameInput').value.trim(), value = $('commandTextInput').value;
    if (!name || !value.trim()) { (name ? $('commandTextInput') : $('commandNameInput')).focus(); return; }
    var command = ref.commandId ? pack.commands.find(function (item) { return item.id === ref.commandId; }) : null;
    if (command) { command.name = name.slice(0, 80); command.description = $('commandDescriptionInput').value.slice(0, 240); command.command = value.slice(0, 16000); }
    else {
      if (pack.commands.length >= 128) { $('commandEditDialog').close(); showToast('每個指令包最多 128 個指令。', true); return; }
      pack.commands.push({ id: uid('cmd'), name: name.slice(0, 80), description: $('commandDescriptionInput').value.slice(0, 240), command: value.slice(0, 16000) });
    }
    $('commandEditDialog').close(); renderCommandLibrary(); queueSave();
  }
  function deleteCommandSnippet() {
    var ref = commandEditingRef, pack = ref && appConfig.commandPacks.find(function (item) { return item.id === ref.packId; });
    var command = pack && pack.commands.find(function (item) { return item.id === ref.commandId; }); if (!command) return;
    askConfirmation('刪除常用指令？', '將刪除「' + command.name + '」。', '刪除指令').then(function (accepted) {
      if (!accepted) return;
      pack.commands = pack.commands.filter(function (item) { return item !== command; });
      $('commandEditDialog').close(); renderCommandLibrary(); queueSave();
    });
  }
  function addCommand() {
    var pack = selectedCommandPack(); if (!pack) { showToast('請先建立或匯入指令包。', true); return; }
    if (pack.commands.length >= 128) { showToast('每個指令包最多 128 個指令。', true); return; }
    openCommandEditor(pack, null);
  }
  function newCommandPack() {
    if (appConfig.commandPacks.length >= 32) { showToast('最多可建立 32 個指令包。', true); return; }
    openPackDialog(null);
  }
  function commandFileObject(pack) { return { format: 'terminal-grid-command-pack', version: 1, name: pack.name, commands: pack.commands }; }
  function exportCommandPack() {
    var pack = appConfig.commandPacks.find(function (p) { return p.id === $('commandPackSelect').value; });
    if (pack) send({ type: 'commandPackSave', text: JSON.stringify(commandFileObject(pack), null, 2) });
  }
  function loadCommandPackFile(text, fileName) {
    try {
      if (typeof text !== 'string' || text.length > 1024 * 1024) throw new Error('指令包超過 1 MB。');
      var data = JSON.parse(text);
      if (data.format !== 'terminal-grid-command-pack' || !Array.isArray(data.commands) || data.commands.length > 128) throw new Error('檔案格式不正確。');
      if (appConfig.commandPacks.length >= 32) throw new Error('已達 32 個指令包上限。');
      var pack = { id: uid('pack'), name: str(data.name, 64).trim() || (fileName || '匯入指令包').replace(/\.tgridcmd$/i, ''),
        commands: data.commands.map(function (c) {
          if (!c || typeof c.command !== 'string') throw new Error('指令項目格式不正確。');
          return { id: uid('cmd'), name: str(c.name, 80).trim() || '常用指令', description: str(c.description, 240), command: str(c.command, 16000) };
        }) };
      appConfig.commandPacks.push(pack); renderCommandLibrary(); $('commandPackSelect').value = pack.id; queueSave();
      showToast('指令包已匯入；指令只會在選取終端並按插入時填入文字。');
    } catch (error) { showToast('匯入指令包失敗：' + error.message, true); }
  }
  function showTerminalMenu(x, y, state) {
    var menu = $('terminalContextMenu'); menu.textContent = '';
    function add(label, action) { var button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.addEventListener('click', function () { menu.hidden = true; action(); }); menu.appendChild(button); }
    add('複製選取文字', function () { copySelection(state); });
    add('貼上剪貼簿', function () { pasteClipboard(state); });
    add('暫存選取文字', function () { saveCaptureText(state.terminal.getSelection(), state); });
    add('編輯選取指令', function () { openCommandDraft(state); });
    add('開啟資料暫存區…', function () { setCapturePanel(true); });
    var separator = document.createElement('div'); separator.className = 'context-separator'; menu.appendChild(separator);
    add('開啟指令庫…', function () { $('commandDialog').showModal(); });
    var menuItems = 0;
    appConfig.commandPacks.forEach(function (pack) {
      pack.commands.forEach(function (command) {
        if (menuItems >= 15) return;
        menuItems++;
        add('插入：' + command.name, function () { insertCommand(state, command.command); });
      });
    });
    positionContextMenu(menu, x, y);
  }
  function importDroppedFiles(files) {
    var queue = Array.prototype.slice.call(files || []);
    function next() { if (queue.length) importDroppedFile(queue.shift(), next); }
    next();
  }
  function importDroppedFile(file, done) {
    done = typeof done === 'function' ? done : function () {};
    if (!file) { done(); return; }
    var name = file.name || '';
    if (!/\.(tgridflow|tgridcmd)$/i.test(name)) { showToast('可拖入 .tgridflow 或 .tgridcmd 檔案。', true); done(); return; }
    if (file.size > 1024 * 1024) { showToast('檔案超過 1 MB。', true); done(); return; }
    var reader = new FileReader();
    reader.onload = function () { if (/\.tgridflow$/i.test(name)) loadFlowFile(String(reader.result), name); else loadCommandPackFile(String(reader.result), name); done(); };
    reader.onerror = function () { showToast('無法讀取拖入的檔案。', true); done(); };
    reader.readAsText(file, 'UTF-8');
  }

  function initialize() {
    if (typeof window.Terminal !== 'function' || !window.FitAddon || !window.TerminalGridIPv6 || !window.TerminalGridDraft) {
      $('connectionDot').className = 'connection-dot failed'; $('connectionText').textContent = '終端元件載入失敗';
      showToast('缺少本機終端元件。請完整解壓縮套件，再啟動 TerminalGridIntegrated.exe。', true); return;
    }
    var initial = normalizeAppConfig(null); initial.workspaces.forEach(createView); activateWorkspace(initial.activeWorkspaceId);
    commandDraft = window.TerminalGridDraft.create({ container: $('commandDraftHost'), getValues: function () { return capturedValues; }, onStatus: showToast, onResize: scheduleFit,
      onSend: function (text) {
        var state = draftTarget && draftTarget.state;
        if (!state || getState(state.workspaceId, state.slot, state.tabId) !== state || state.generation !== draftTarget.generation || state.status !== 'running') {
          showToast('草稿目標已結束或重新啟動；請選取終端後重新開啟草稿以指定目標。', true); return;
        }
        activateWorkspace(state.workspaceId); var view = getView(state.workspaceId); view.panes[state.slot].config.activeTabId = state.tabId;
        renderPane(view, state.slot); markFocused(view, state.slot, state.tabId); scheduleFit(); insertCommand(state, text);
      } });
    $('draftButton').addEventListener('click', function () { openCommandDraft(focused && focused.state); });
    $('captureValueForm').addEventListener('submit', function (event) { event.preventDefault(); if (saveCaptureText($('captureValueInput').value)) $('captureValueInput').value = ''; });
    $('captureButton').addEventListener('click', function () { setCapturePanel($('capturePanel').hidden); });
    $('closeCaptureButton').addEventListener('click', function () { setCapturePanel(false); });
    $('clearCapturesButton').addEventListener('click', function () { capturedValues = []; renderCaptures(); });
    $('captureEnabled').addEventListener('change', function () {
      views.forEach(function (view) { view.panes.forEach(function (cell) { cell.tabs.forEach(resetCaptureScanner); }); });
      showToast(this.checked ? '已啟用 IPv6 自動擷取。' : '已暫停 IPv6 擷取；現有紀錄會保留。');
    });
    renderCaptures();
    document.addEventListener('dragend', function () { if (captureDragging) { captureDragging = false; renderCaptures(); } });
    $('saveButton').disabled = true; $('exportButton').disabled = true; $('importButton').disabled = true;
    $('presetSelect').addEventListener('change', function (event) { if (event.target.value === 'custom') return; var d = event.target.value.split('x'); activeView.config.rows = Number(d[0]); activeView.config.cols = Number(d[1]); activeView.zoomedSlot = null; applyLayout(activeView); queueSave(); });
    ['rowSelect', 'colSelect'].forEach(function (id) { $(id).addEventListener('change', function () {
      activeView.config.rows = limitNumber($('rowSelect').value, 2, 1, 4); activeView.config.cols = limitNumber($('colSelect').value, 2, 1, 4);
      activeView.zoomedSlot = null; applyLayout(activeView); queueSave();
    }); });
    $('fontMinus').addEventListener('click', function () { activeView.config.fontSize = Math.max(10, activeView.config.fontSize - 1); applyLayout(activeView); queueSave(); });
    $('fontPlus').addEventListener('click', function () { activeView.config.fontSize = Math.min(24, activeView.config.fontSize + 1); applyLayout(activeView); queueSave(); });
    $('startAllButton').addEventListener('click', function () {
      var count = activeView.config.rows * activeView.config.cols;
      for (var i = 0; i < count; i++) if (activeView.zoomedSlot === null || activeView.zoomedSlot === i) {
        var state = activeState(activeView, i); if (!isActive(state)) startSlot(activeView, i, state.tabId, false);
      }
    });
    $('hiddenButton').addEventListener('click', function () { activeView.config.rows = 4; activeView.config.cols = 4; activeView.zoomedSlot = null; applyLayout(activeView); queueSave(); });
    $('unzoomButton').addEventListener('click', function () { activeView.zoomedSlot = null; applyLayout(activeView); });
    $('addWorkspaceButton').addEventListener('click', addWorkspace);
    $('workspaceForm').addEventListener('submit', saveWorkspaceDialog);
    $('deleteWorkspaceButton').addEventListener('click', function () { var id = workspaceEditingId; $('workspaceDialog').close(); if (id) deleteWorkspace(id); });
    $('duplicateWorkspaceButton').addEventListener('click', function () { var id = workspaceEditingId; $('workspaceDialog').close(); if (id) duplicateWorkspace(id); });
    $('saveButton').addEventListener('click', function () { saveConfig(true); });
    $('exportButton').addEventListener('click', function () { if (hostReady) send({ type: 'export', config: appConfig }); });
    $('importButton').addEventListener('click', function () { if (hostReady) { invalidateFolderRequests(); send({ type: 'import' }); } });
    $('helpButton').addEventListener('click', function () { $('helpDialog').showModal(); });
    $('flowButton').addEventListener('click', function () { renderFlowOptions(); $('flowDialog').showModal(); });
    $('commandButton').addEventListener('click', function () { renderCommandLibrary(); $('commandDialog').showModal(); });
    $('copyButton').addEventListener('click', function () { if (focused) copySelection(focused.state); });
    $('pasteButton').addEventListener('click', function () { if (focused) pasteClipboard(focused.state); });
    $('settingShell').addEventListener('change', updateCustomFields);
    $('settingBrowse').addEventListener('click', function () {
      if (settingsRef) { var view = getView(settingsRef.workspaceId); requestFolder(view, settingsRef.slot, settingsRef.tabId, 'settings', $('settingCwd').value, false); }
    });
    $('settingsForm').addEventListener('submit', function (event) {
      event.preventDefault(); if (!settingsRef) return;
      if ($('settingShell').value === 'Custom' && !$('settingExe').value.trim()) { $('settingExe').setCustomValidity('請輸入要啟動的可執行程式。'); $('settingExe').reportValidity(); return; }
      var ref = settingsRef, tab = getTabConfig(getWorkspace(ref.workspaceId), ref.slot, ref.tabId);
      Object.assign(tab, { name: $('settingName').value.trim() || defaultTab(0).name, shell: $('settingShell').value,
        cwd: $('settingCwd').value.trim(), command: $('settingCommand').value, exe: $('settingExe').value.trim(), args: $('settingArgs').value });
      closeSettings(); var view = getView(ref.workspaceId); renderPane(view, ref.slot); queueSave();
      showToast('已儲存終端設定；執行中程序會在下次啟動時套用。');
    });
    $('settingExe').addEventListener('input', function () { this.setCustomValidity(''); });
    $('settingsDialog').addEventListener('cancel', function (event) { event.preventDefault(); closeSettings(); });
    $('settingsDialog').addEventListener('close', function () { if (!$('settingsDialog').open && settingsRef) closeSettings(); });
    $('confirmAccept').addEventListener('click', function () { finishConfirmation(true); });
    $('confirmCancel').addEventListener('click', function () { finishConfirmation(false); });
    $('confirmDialog').addEventListener('cancel', function (event) { event.preventDefault(); finishConfirmation(false); });
    document.querySelectorAll('[data-close]').forEach(function (button) { button.addEventListener('click', function () {
      if (button.dataset.close === 'settingsDialog') closeSettings(); else $(button.dataset.close).close();
    }); });
    $('flowSelect').addEventListener('change', function () { currentFlowId = this.value || null; renderFlowEditor(); });
    $('newFlowButton').addEventListener('click', newFlow);
    $('addFlowStepButton').addEventListener('click', addFlowStep);
    $('flowName').addEventListener('input', function () { var flow = currentFlow(); if (flow) { flow.name = this.value.slice(0, 64); var option = Array.from($('flowSelect').options).find(function (o) { return o.value === flow.id; }); if (option) option.textContent = flow.name; queueSave(); } });
    $('saveFlowFileButton').addEventListener('click', saveFlowFile);
    $('runFlowButton').addEventListener('click', runFlow);
    $('deleteFlowButton').addEventListener('click', deleteFlow);
    $('importFlowButton').addEventListener('click', function () { if (hostReady) send({ type: 'flowOpen' }); });
    $('continuePausedFlowButton').addEventListener('click', function () { finishFlowPause(true); });
    $('stopPausedFlowButton').addEventListener('click', function () { finishFlowPause(false); });
    $('flowPauseDialog').addEventListener('cancel', function (event) { event.preventDefault(); finishFlowPause(false); });
    $('commandPackSelect').addEventListener('change', renderCommandLibrary);
    $('newPackButton').addEventListener('click', newCommandPack);
    $('renamePackButton').addEventListener('click', function () { var pack = selectedCommandPack(); if (pack) openPackDialog(pack); });
    $('duplicatePackButton').addEventListener('click', duplicateCommandPack);
    $('deletePackButton').addEventListener('click', deleteCommandPack);
    $('packForm').addEventListener('submit', savePackDialog);
    $('addCommandButton').addEventListener('click', addCommand);
    $('commandEditForm').addEventListener('submit', saveCommandEditor);
    $('deleteCommandButton').addEventListener('click', deleteCommandSnippet);
    $('exportPackButton').addEventListener('click', exportCommandPack);
    $('importPackButton').addEventListener('click', function () { if (hostReady) send({ type: 'commandPackOpen' }); });
    document.addEventListener('dragover', function (event) { if (event.dataTransfer && (event.dataTransfer.files.length || hasDataType(event.dataTransfer, 'Files'))) event.preventDefault(); });
    document.addEventListener('drop', function (event) { if (event.dataTransfer && event.dataTransfer.files.length) { event.preventDefault(); importDroppedFiles(event.dataTransfer.files); } });
    document.addEventListener('click', function (event) { if (!event.target.closest('#terminalContextMenu')) $('terminalContextMenu').hidden = true; });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && activeView && activeView.zoomedSlot !== null && !document.querySelector('dialog[open]')) {
        event.preventDefault(); event.stopImmediatePropagation(); activeView.zoomedSlot = null; applyLayout(activeView);
      }
    }, true);
    window.addEventListener('resize', scheduleFit);
    if (window.ResizeObserver) new ResizeObserver(scheduleFit).observe(workspaceHost);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(scheduleFit);
    if (host) {
      host.addEventListener('message', function (event) { handleHostMessage(event.data); }); send({ type: 'ready' });
      window.setTimeout(function () { if (!hostReady) { $('connectionText').textContent = '等待終端引擎'; setStatus('終端引擎尚未回應。'); } }, 9000);
    } else {
      $('connectionDot').className = 'connection-dot failed'; $('connectionText').textContent = '靜態預覽';
      setStatus('請從 TerminalGridIntegrated.exe 啟動，才能使用本機終端。');
    }
  }
  initialize();
}());
