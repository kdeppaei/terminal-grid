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
  var captureCommand = null;
  var commandDraft = null, draftTarget = null, focusedEditor = null;
  var rightClickMode = 'quick';
  var nanDiscoveryId = null, nanPathId = null;
  var testCaseId = '', testCaseCheck = null, testCasePathId = null, testCaseDirty = false;
  var testCaseQueue = new Set(), testCaseQueueRunning = false;
  var flowRecordingFolder = '', flowRecordingPick = null;
  var batchRequests = {};
  var transferPending = null, paneClipboard = null, paneDrag = null;
  var paneDragType = 'application/x-terminalgrid-pane';
  var activeRun = null, lastRun = null, failedFlowStep = null;
  var nanTransferResolve = null;
  var evidence = null, logState = null;
  var paneHistory = [], selectedPanes = new Map();
  var completionMenu, completionHistory = [], completionCatalog, completionCommands = [], completionLiterals = [];
  var personalPackId = 'personal-favorites';
  var commandDragType = 'application/x-terminalgrid-command', literalDragType = 'application/x-terminalgrid-literal';
  function discoverNanDevices() {
    if (!hostReady || !activeView) return;
    var state = focused ? focused.state : activeState(activeView, 0);
    nanDiscoveryId = uid('nan-devices');
    $('nanStatus').textContent = '正在偵測已授權的 ADB 手機…';
    send({ type: 'discoverCommandTargets', requestId: nanDiscoveryId, workspaceId: state.workspaceId, slot: state.slot, tabId: state.tabId, toolsFolder: $('nanFolder').value.trim() });
  }
  function openNanDialog() {
    if (flowRunning || flowPreparing) { showToast('請先完成或停止目前流程。'); return; }
    $('nanDialog').showModal(); discoverNanDevices();
  }
  var pathCommandTarget = null, pathPickPending = null, targetDiscoveryRequest = null, targetCandidates = [], flowPreparing = false;
  var adbToolsFolder = '', adbToolsPick = null, appsRequest = null, appsAdbPath = '', appComponents = [];
  var remoteBrowser = null;
  function refreshTargetOptions() {
    $('pathCommandFields').querySelectorAll('select[data-target-key]').forEach(function (select) {
      var key = select.dataset.targetKey, kind = window.TerminalGridDefaults.fields[key][1];
      var input = $('pathCommandFields').querySelector('[data-path-key="' + key + '"]');
      select.textContent = ''; select.add(new Option('選擇偵測結果，或在下方手動輸入', ''));
      var seen = new Set();
      var candidates = targetCandidates.concat(currentCaptures().map(function (v) { return { value: v.address, label: '暫存 · ' + v.address, kind: 'saved' }; }));
      var aware = targetCandidates.filter(function (c) { return c.kind === 'android' && /^aware[_-]data\d+$/i.test(c.interfaceName); });
      if (kind === 'scope') {
        var serialInput = $('pathCommandFields').querySelector('[data-path-key="SERIAL"]');
        candidates = aware.filter(function (c) { return !serialInput || !serialInput.value || c.serial === serialInput.value; })
          .map(function (c) { return { value: '%' + c.interfaceName, label: c.serial + ' · %' + c.interfaceName }; });
        currentCaptures().filter(function (item) { return item.kind === 'scope'; }).forEach(function (item) {
          candidates.push({ value: item.address, label: item.source + ' · ' + item.address });
        });
      }
      if (kind === 'interface') {
        var selectedDevice = $('pathCommandFields').querySelector('[data-path-key="SERIAL"]');
        candidates = aware.filter(function (c) { return !selectedDevice || !selectedDevice.value || c.serial === selectedDevice.value; })
          .map(function (c) { return { value: c.interfaceName, label: c.serial + ' · ' + c.interfaceName }; });
      }
      if (kind === 'aware') {
        // Sender scope belongs to the selected DUT2, not to the target IP owner.
        var serial = $('pathCommandFields').querySelector('[data-path-key="SERIAL"]');
        var scopes = Array.from(new Set(aware.filter(function (c) { return serial && serial.value === c.serial; }).map(function (c) { return c.interfaceName; })));
        candidates = scopes.length === 1 ? aware.filter(function (c) {
          return c.serial !== serial.value && window.TerminalGridIPv6.isIPv6(c.value);
        }).map(function (c) { return { value: c.value + '%' + scopes[0], label: c.label + ' → %' + scopes[0] }; }) : [];
      }
      candidates.forEach(function (candidate) {
        var value = candidate.value, ipv4 = /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value) && value.split('.').every(function (n) { return Number(n) <= 255; });
        var ipv6 = window.TerminalGridIPv6.isIPv6(value);
        if (kind === 'device' && candidate.kind !== 'device') return;
        if (kind === 'source' && !['file', 'folder', 'apk'].includes(candidate.kind)) return;
        if (['apk', 'folder'].includes(kind) && candidate.kind !== kind) return;
        if (['ip', 'ipv4', 'ipv6', 'local', 'local4'].includes(kind) &&
            ((!ipv4 && !ipv6) || (kind === 'local' || kind === 'local4') && candidate.kind !== 'local' ||
            (kind === 'ipv4' || kind === 'local4') && !ipv4 || kind === 'ipv6' && !ipv6 ||
            candidate.kind === 'android' && /^fe[89ab]/i.test(value))) return;
        if (seen.has(value)) return; seen.add(value); select.add(new Option(candidate.label, value));
      });
      if (seen.has(input.value)) select.value = input.value;
    });
  }
  function discoverTargets() {
    var target = pathCommandTarget; if (!target) return;
    target.adbPath = '';
    var id = uid('targets'); targetDiscoveryRequest = { id: id, target: target };
    $('targetDiscoveryStatus').textContent = '正在讀取本機網卡與 adb devices -l…';
    var android = !!$('pathCommandFields').querySelector('[data-target-key="TARGET_IP"], [data-target-key="TARGET_IPV4"], [data-target-key="TARGET_IPV6"], [data-target-key^="AWARE_"]');
    if (!send({ type: 'discoverCommandTargets', requestId: id, workspaceId: target.state.workspaceId, slot: target.state.slot, tabId: target.state.tabId, android: android, paths: true, toolsFolder: adbToolsFolder })) $('targetDiscoveryStatus').textContent = '偵測尚未就緒，可手動輸入。';
  }
  function allCommandPacks() { return window.TerminalGridDefaults.packs.concat(appConfig.commandPacks); }
  function pickAdbTools(dialog, refresh) {
    if (adbToolsPick || pathPickPending) return;
    var id = uid('adb-folder');
    adbToolsPick = { id: id, dialog: dialog, refresh: refresh };
    if (!send({ type: 'pickCommandPath', requestId: id, kind: 'folder' })) adbToolsPick = null;
  }
  function requestAndroid(type, extra) {
    var id = uid('adb-app'), serial = $('androidDevice').value;
    appsRequest = { id: id, type: type, serial: serial, sysdump: !!(extra && extra.sysdump) };
    $('androidAppsStatus').textContent = type === 'androidWake' ? '正在喚醒螢幕…' :
      type === 'androidLaunch' || type === 'androidMirror' ? '正在開啟…' : '正在偵測…';
    if (!send(Object.assign({ type: type, requestId: id, serial: serial }, extra))) {
      appsRequest = null; $('androidAppsStatus').textContent = '終端引擎尚未就緒。';
    }
    updateAndroidButtons();
  }
  function updateAndroidButtons() {
    var ready = !!$('androidDevice').value && !appsRequest;
    $('androidSysdump').disabled = !ready;
    $('openAndroidMirror').disabled = $('wakeAndroidScreen').disabled = !ready;
    $('launchAndroidApp').disabled = !ready || !$('androidApp').value;
    $('androidDevice').disabled = !!appsRequest;
  }
  function renderAndroidApps() {
    var select = $('androidApp'), query = $('androidAppSearch').value.trim().toLowerCase(), previous = select.value;
    select.replaceChildren();
    appComponents.filter(function (component) { return component.toLowerCase().includes(query); }).forEach(function (component) {
      select.add(new Option(component, component));
    });
    if (Array.from(select.options).some(function (option) { return option.value === previous; })) select.value = previous;
    updateAndroidButtons();
  }
  function discoverAndroidAppsDevices() {
    if (appsRequest && ['androidLaunch', 'androidMirror', 'androidWake'].includes(appsRequest.type)) return;
    var target = batchTarget(null), state = activeState(target.view, target.slot);
    appComponents = []; appsAdbPath = '';
    $('androidDevice').replaceChildren(new Option('選擇裝置', ''));
    renderAndroidApps();
    requestAndroid('discoverCommandTargets', { workspaceId: state.workspaceId, slot: state.slot, tabId: state.tabId, toolsFolder: adbToolsFolder });
  }
  function loadAndroidApps() {
    appComponents = []; renderAndroidApps();
    if (!$('androidDevice').value) return;
    requestAndroid('androidApps', { toolsFolder: appsAdbPath });
  }
  function openAdbLogs() {
    var target = batchTarget(null);
    markFocused(target.view, target.slot, activeState(target.view, target.slot).tabId);
    renderCommandLibrary();
    $('commandPackSelect').value = '@default-adb-logs';
    renderCommandLibrary();
    $('commandDialog').showModal();
  }
  function selectedRemoteEntry() {
    var selected = Number($('androidBrowseEntries').value);
    return remoteBrowser && $('androidBrowseEntries').selectedIndex >= 0 ? remoteBrowser.entries[selected] : null;
  }
  function requestRemoteDirectory(path) {
    var browser = remoteBrowser;
    if (!browser) return;
    path = path.trim().replace(/\/+$/, '') || '/';
    if (path[0] !== '/') { $('androidBrowseStatus').textContent = '請輸入手機的絕對路徑。'; return; }
    $('androidBrowsePath').value = path;
    browser.path = path;
    browser.loaded = false;
    browser.entries = [];
    browser.requestId = uid('remote-dir');
    $('androidBrowseEntries').replaceChildren();
    $('androidBrowseStatus').textContent = '正在讀取 ' + browser.serial + ' 的資料夾…';
    updateRemoteBrowserButtons();
    if (!send({ type: 'browseAndroidPath', requestId: browser.requestId, serial: browser.serial, path: path, toolsFolder: browser.folder }))
      $('androidBrowseStatus').textContent = '無法連接終端引擎，可關閉後手動輸入路徑。';
  }
  function openRemoteBrowser(input) {
    var serial = $('pathCommandFields').querySelector('[data-path-key="SERIAL"]').value.trim();
    if (!serial) { $('targetDiscoveryStatus').textContent = '請先選擇或填入要瀏覽的裝置序號。'; return; }
    var adbPath = pathCommandTarget.adbPath || '';
    remoteBrowser = { input: input, target: pathCommandTarget, serial: serial,
      folder: adbPath ? adbPath.replace(/[^\\/]+$/, '') : adbToolsFolder, entries: [] };
    $('androidBrowseTitle').textContent = '瀏覽手機來源 · ' + serial;
    $('androidBrowseDialog').showModal();
    var initial = input.value.trim();
    requestRemoteDirectory(initial.startsWith('/') ? initial : '/sdcard');
  }
  function updateRemoteBrowserButtons() {
    var entry = selectedRemoteEntry();
    var current = remoteBrowser && remoteBrowser.loaded && $('androidBrowsePath').value === remoteBrowser.path;
    $('androidBrowseEnter').disabled = !current || !entry || !entry.directory;
    $('androidBrowseUse').disabled = !current;
    $('androidBrowseUse').textContent = entry ? '使用選取的' + (entry.directory ? '資料夾' : '檔案') : '使用目前資料夾';
  }
  function remoteEntryPath(entry) { return remoteBrowser.path.replace(/\/$/, '') + '/' + entry.name; }
  function completionSources() {
    if (completionCatalog !== appConfig.commandPacks) {
      completionCatalog = appConfig.commandPacks;
      var items = allCommandPacks().flatMap(function (pack) { return pack.commands; });
      completionCommands = window.TerminalGridCompletion.catalog(items.filter(function (item) { return !item.literal; })
        .map(function (item) { return item.command.slice(0, 512); }));
      completionLiterals = items.filter(function (item) { return item.literal && validLineText(item.command); })
        .map(function (item) { return { address: item.command, kind: 'literal' }; });
    }
    return { commands: completionCommands, history: completionHistory, values: currentCaptures().concat(completionLiterals) };
  }
  function rememberCommand(command) {
    if (!completionEnabled()) return;
    command = command.trim();
    if (!command || command.length > 1024 || !validLineText(command)) return;
    completionHistory = [command].concat(completionHistory.filter(function (item) { return item !== command; })).slice(0, 120);
  }
  function completionEnabled() { return $('smartCompletion').checked; }
  function attachCommandCompletion(input, editor, state) {
    return window.TerminalGridCompletion.attachEditor(input, { menu: completionMenu, enabled: completionEnabled, sources: completionSources,
      snippets: true, terminal: state, apply: editor.replaceRange, isMenuOpen: editor.isMenuOpen });
  }
  function attachReplacementCompletion(input, selected) {
    var completion = window.TerminalGridCompletion.attachEditor(input, {
      menu: completionMenu, sources: completionSources, enabled: completionEnabled, replaceOnly: true, initialQuery: selected,
      apply: function (value, start, end) { input.setRangeText(value, start, end, 'end'); return true; }
    });
    completion.offer(false);
    return completion;
  }
  function pullLogCategory(path) {
    var match = /^\/(data\/debuglogger|sdcard\/log)(?:\/|$)/.exec(path.trim());
    return match ? match[1] : '';
  }
  function pullDestination(category, value) {
    if (!category) return '';
    var key = 'terminalGrid.pullDestination.' + category;
    try {
      if (value !== undefined) localStorage.setItem(key, value);
      var saved = localStorage.getItem(key) || '';
      return saved.length <= 4096 && validLineText(saved) ? saved : '';
    } catch (_) { return ''; }
  }
  function updatePullPreview(event) {
    var target = pathCommandTarget;
    if (!target || !target.pullRemoteKey) return;
    var fields = $('pathCommandFields'), remote = fields.querySelector('[data-path-key="' + target.pullRemoteKey + '"]');
    var local = fields.querySelector('[data-path-key="LOCAL_FOLDER"]'), serial = fields.querySelector('[data-path-key="SERIAL"]');
    if (!remote || !local) return;
    if (event && event.target === local) target.pullDestinationEdited = true;
    var category = pullLogCategory(remote.value);
    if (category !== target.pullCategory) {
      if (!target.pullDestinationEdited) local.value = pullDestination(category);
      target.pullCategory = category;
    }
    var preview = $('pullCommandPreview');
    preview.textContent = '裝置  ' + (serial && serial.value.trim() || '請選擇') +
      '\n手機來源  ' + (remote.value.trim() || '請輸入') +
      '\n本機目的地  ' + (local.value.trim() || '請選擇或輸入');
  }
  function openPathCommand(state, text, finish, shared) {
    if ($('pathCommandDialog').open) { showToast('請先完成目前參數選擇。'); if (finish) finish(null); return; }
    text = window.TerminalGridDefaults.prepare(text);
    pathCommandTarget = { state: state, generation: state.generation, text: text, id: uid('path-command'), finish: finish, shared: shared,
      replace: !!(state.terminal.hasSelection() || state.liveIntent), selection: state.liveSelection };
    targetCandidates = [];
    var fields = $('pathCommandFields'); fields.textContent = '';
    var remoteKey = window.TerminalGridDefaults.pullPathKey(text);
    pathCommandTarget.pullRemoteKey = remoteKey;
    pathCommandTarget.pullDestinationEdited = !!(shared && shared.LOCAL_FOLDER);
    $('shareFlowParamsLabel').hidden = !shared; $('shareFlowParams').checked = !!shared;
    window.TerminalGridDefaults.keys(text).forEach(function (key) {
      var spec = window.TerminalGridDefaults.fields[key], label = document.createElement('label'); label.className = 'field'; label.textContent = spec[0];
      var row = document.createElement('div'); row.className = 'folder-input-row';
      var input = document.createElement('input'); input.dataset.pathKey = key; input.required = true; input.value = shared && shared[key] || spec[2]; input.setAttribute('aria-label', spec[0]); row.appendChild(input);
      if (key === remoteKey) {
        label.firstChild.textContent = '手機來源路徑';
        input.placeholder = '/sdcard/log 或完整檔案路徑';
        input.setAttribute('aria-label', '手機來源路徑');
        var browse = document.createElement('button');
        browse.className = 'button'; browse.type = 'button'; browse.textContent = '瀏覽手機…';
        browse.addEventListener('click', function () { openRemoteBrowser(input); });
        row.appendChild(browse);
      }
      if (remoteKey && key === 'LOCAL_FOLDER') {
        label.firstChild.textContent = '本機目的路徑';
        input.setAttribute('aria-label', '本機目的路徑');
        input.placeholder = '例如 D:\\Test Logs';
      }
      if (key === 'SERIAL') input.addEventListener('change', refreshTargetOptions);
      if (spec[1] !== 'text') {
        var select = document.createElement('select'); select.dataset.targetKey = key; select.setAttribute('aria-label', spec[0] + '偵測結果');
        select.addEventListener('change', function () {
          if (this.value) { input.value = this.value; input.dispatchEvent(new Event('input', { bubbles: true })); if (key === 'SERIAL') refreshTargetOptions(); }
        }); label.appendChild(select);
      }
      if (['source', 'folder', 'apk'].indexOf(spec[1]) >= 0) (spec[1] === 'source' ? ['file', 'folder'] : [spec[1]]).forEach(function (kind) {
        var button = document.createElement('button'); button.type = 'button'; button.className = 'button'; button.textContent = kind === 'folder' ? '選資料夾…' : '選檔案…';
        button.addEventListener('click', function () {
          if (pathPickPending) return;
          var requestId = uid('path-pick'); pathPickPending = { id: requestId, target: pathCommandTarget, input: input };
          if (!send({ type: 'pickCommandPath', requestId: requestId, kind: kind })) { pathPickPending = null; showToast('檔案選擇器尚未就緒。', true); }
        }); row.appendChild(button);
      });
      label.appendChild(row); fields.appendChild(label);
    });
    if (remoteKey) {
      var preview = document.createElement('p'); preview.id = 'pullCommandPreview'; preview.className = 'help-note';
      preview.setAttribute('role', 'status'); preview.style.whiteSpace = 'pre-line'; preview.style.overflowWrap = 'anywhere';
      fields.appendChild(preview); updatePullPreview();
    }
    $('pathCommandDialog').showModal();
    refreshTargetOptions();
    $('targetDiscoveryStatus').textContent = '';
    if (fields.querySelector('select[data-target-key]')) discoverTargets();
  }
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
    tab.exe = str(raw.exe, 4096); tab.args = str(raw.args, 16000); tab.batchFile = str(raw.batchFile, 4096);
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
          return { action: ['start', 'send', 'wait', 'pause', 'stop', 'output', 'exit', 'nanTransfer', 'trafficPause'].indexOf(step.action) >= 0 ? step.action : 'send',
            slot: limitNumber(step.slot, 0, 0, 15), tabId: str(step.tabId, 64), text: str(step.text, 16000),
            delayMs: limitNumber(step.delayMs, 500, 100, 30000), enter: step.enter !== false,
            timeoutMs: limitNumber(step.timeoutMs || 10000, 10000, 100, 600000), retries: limitNumber(step.retries, 0, 0, 5), failureText: str(step.failureText, 512), duringTransfer: str(step.duringTransfer, 4000) };
        }) };
    }).filter(function (f) { return workspaces.some(function (w) { return w.id === f.workspaceId; }); }) : [];
    var packs = Array.isArray(raw.commandPacks) ? raw.commandPacks.slice(0, 32).map(function (p) {
      p = p || {};
      return { id: str(p.id, 64) || uid('pack'), name: str(p.name, 64).trim() || '指令集',
        commands: (Array.isArray(p.commands) ? p.commands : []).slice(0, 128).map(function (c) {
          c = c || {};
          return { id: str(c.id, 64) || uid('cmd'), name: str(c.name, 80).trim() || '常用指令',
            description: str(c.description, 240), command: str(c.command, 16000), literal: c.literal === true, pinned: c.pinned === true };
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
    var testCases = (Array.isArray(raw.testCases) ? raw.testCases : []).filter(function (item) { return item && typeof item === 'object'; }).slice(0, 256).map(function (item) {
      return { id: str(item.id, 64) || uid('case'), code: str(item.code, 32), title: str(item.title, 120),
        feasibility: ['auto', 'assisted', 'external'].includes(item.feasibility) ? item.feasibility : 'pending',
        notes: str(item.notes, 4000), flowId: str(item.flowId, 64), usbCount: limitNumber(item.usbCount, 0, 0, 16),
        serials: str(item.serials, 2048), toolsFolder: str(item.toolsFolder, 4096) };
    });
    return { version: 2, activeWorkspaceId: activeId, workspaces: workspaces, automations: automations, commandPacks: packs, testCases: testCases };
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
    var routed = message.workspaceId && getState(message.workspaceId, message.slot, message.tabId);
    if (routed) message.routeId = routed.routeId;
    if (message.type === 'input') {
      var target = getState(message.workspaceId, message.slot, message.tabId);
      if (target) {
        if (message.data === '\x03' && target.iperfOutput) target.iperfOutput.feed(new TextEncoder().encode('\r\n^C\r\n'));
        target.pendingCommand = (target.pendingCommand || '') + message.data;
        if (/[\r\n]/.test(message.data)) {
          if (/\biperf3?(?:\.exe)?"?\s[^\r\n]*\s?-c\s/i.test(target.pendingCommand))
            target.iperfOutput = window.TerminalGridFlowOutput.create();
          target.pendingCommand = '';
        } else if (target.pendingCommand.length > 16000 || message.data === '\x03') target.pendingCommand = '';
      }
      if (target && target.liveReplace && !/^\x1b\[(?:[IO]|\??[0-9;]*[Rc])$/.test(message.data)) { target.liveReplace.input(message.data); target.liveIntent = false; }
    }
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
    if (transferPending) return;
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
    function capture(entry) { recordCapture(state, entry); }
    state.captureScanner = window.TerminalGridIPv6.createScanner(capture, capture, function (interfaceName) {
      capturedValues.forEach(function (item) {
        if (captureFrom(item, state) && (interfaceName === null || item.interfaceName === interfaceName)) item.historical = true;
      });
      queueCaptureRender();
    });
  }
  function captureFrom(item, state) {
    return item.workspaceId === state.workspaceId && item.slot === state.slot && item.tabId === state.tabId && item.generation === state.generation;
  }
  function currentCaptures() { return capturedValues.filter(function (item) { return !item.historical; }); }
  function resetTerminalRecords(state) {
    state.transcript = window.TerminalGridFlowOutput.create();
    state.iperfOutput = null;
    state.pendingCommand = '';
    state.logMarkers = [];
    resetCaptureScanner(state);
  }
  function recordCapture(state, entry) {
    if (!$('captureEnabled').checked || getState(state.workspaceId, state.slot, state.tabId) !== state) return;
    var workspace = getWorkspace(state.workspaceId), tab = getTabConfig(workspace, state.slot, state.tabId);
    if (!workspace || !tab) return;
    var key = [state.workspaceId, state.slot, state.tabId, entry.interfaceName, entry.address.toLowerCase()].join('|');
    capturedValues = capturedValues.filter(function (item) { return item.key !== key; });
    capturedValues.unshift({ key: key, address: entry.address, interfaceName: entry.interfaceName, kind: entry.kind,
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
    state.liveReplace.invalidate(); state.liveIntent = false; state.terminal.clearSelection(); updateLiveSelection(state);
  }
  function replaceFocusedText(value) {
    if (focusedEditor && focusedEditor.draft && commandDraft.hasSelection()) { commandDraft.replaceSelection(value); return; }
    if (focused && (focused.state.terminal.hasSelection() || focused.state.liveIntent) && !(focusedEditor && focusedEditor.state && focusedEditor.state.lineEditor.hasSelection())) {
      replaceLiveSelection(focused.state, value); return;
    }
    if (focusedEditor && focusedEditor.state) {
      var state = focusedEditor.state;
      if (getState(state.workspaceId, state.slot, state.tabId) === state && !state.lineInput.disabled) {
        state.lineEditor.insert(value, true); return;
      }
    }
    commandDraft.replaceSelection(value);
  }
  function showCaptureMenu(event, item) {
    event.preventDefault();
    var menu = $('terminalContextMenu'); menu.textContent = ''; menu.className = 'terminal-context-menu';
    var copy = document.createElement('button'); copy.type = 'button'; copy.textContent = '複製暫存文字';
    copy.addEventListener('click', function () { menu.hidden = true; copyCapture(item); });
    var replace = document.createElement('button'); replace.type = 'button'; replace.textContent = '替換目前框選文字';
    replace.addEventListener('click', function () { menu.hidden = true; replaceFocusedText(item.address); });
    var save = document.createElement('button'); save.type = 'button'; save.textContent = '儲存為常用文字片段…';
    save.addEventListener('click', function () { menu.hidden = true; addCommand(item.address); });
    menu.append(copy, replace, save);
    if (!item.historical && window.TerminalGridIPv6.isIPv6(item.address)) {
      ['ping6', 'iperf3'].forEach(function (tool) {
        var button = document.createElement('button'); button.type = 'button'; button.textContent = '在 DUT2 產生 ' + tool + '…';
        button.addEventListener('click', function () { menu.hidden = true; openCaptureCommand(item, tool); });
        menu.appendChild(button);
      });
    }
    positionContextMenu(menu, event.clientX, event.clientY);
  }
  function openCaptureCommand(item, tool) {
    if (item.historical || !capturedValues.includes(item)) { showToast('請使用最近一次查詢的 IPv6。', true); return; }
    var targets = [];
    views.forEach(function (view) { view.panes.forEach(function (cell) { cell.tabs.forEach(function (state) {
      if (state.status === 'running' && !captureFrom(item, state)) targets.push({ state: state, generation: state.generation });
    }); }); });
    captureCommand = { item: item, tool: tool, targets: targets };
    $('captureCommandTitle').textContent = '在 DUT2 產生 ' + tool;
    $('captureCommandSource').textContent = item.source + ' · ' + item.address;
    var select = $('captureCommandTarget'); select.textContent = ''; select.add(new Option('選擇已進入 DUT2 adb shell 的終端', ''));
    targets.forEach(function (target, index) {
      var state = target.state, workspace = getWorkspace(state.workspaceId), tab = getTabConfig(workspace, state.slot, state.tabId);
      select.add(new Option(workspace.name + ' · ' + String(state.slot + 1).padStart(2, '0') + ' · ' + tab.name, String(index)));
    });
    if (targets.length === 1) select.value = '0';
    refreshCaptureCommand(true); $('captureCommandDialog').showModal();
  }
  function refreshCaptureCommand(refill) {
    var draft = captureCommand; if (!draft) return;
    var target = $('captureCommandTarget').value === '' ? null : draft.targets[Number($('captureCommandTarget').value)];
    var scope = $('captureCommandScope');
    if (refill) {
      scope.textContent = ''; scope.add(new Option('選擇發送端最近查詢的介面', ''));
      if (target) {
        var seen = new Set();
        currentCaptures().filter(function (item) { return item.kind === 'scope' && captureFrom(item, target.state); }).forEach(function (item) {
          if (!seen.has(item.address)) { seen.add(item.address); scope.add(new Option(item.address, item.address)); }
        });
        if (seen.size === 1) scope.selectedIndex = 1;
      }
    }
    var sourceValid = capturedValues.includes(draft.item) && !draft.item.historical;
    var scopeValid = target && currentCaptures().some(function (item) { return captureFrom(item, target.state) && item.kind === 'scope' && item.address === scope.value; });
    var valid = sourceValid && target && sameSession(target.state, target.generation) && scopeValid;
    var value = valid ? draft.tool + (draft.tool === 'iperf3' ? ' -c' : '') + ' "' + draft.item.address.split('%')[0] + scope.value + '"' +
      (draft.tool === 'iperf3' ? ' -f m -n 1300M' : '') : '';
    $('captureCommandPreview').value = value; $('captureCommandApply').disabled = !valid;
    $('captureCommandStatus').textContent = !sourceValid ? '目標位址已更新，請關閉後選擇最新 IPv6。' :
      !target ? '請選擇發送端終端。' : !sameSession(target.state, target.generation) ? '發送端已重啟或結束，請重新選擇。' :
      !scopeValid ? '請先在此發送端執行 ifconfig 或 ip addr，再按重新讀取介面。' : '填入後可在 DUT2 輸入列檢查，再按 Enter 送出。';
    return valid ? { target: target, text: value } : null;
  }
  async function applyCaptureCommand() {
    var draft = captureCommand, command = refreshCaptureCommand(false); if (!command) return;
    var input = command.target.state.lineInput;
    if (input.value && !await askConfirmation('取代 DUT2 輸入列內容？', input.value, '取代')) return;
    if (captureCommand !== draft || !refreshCaptureCommand(false)) return;
    var state = command.target.state, view = getView(state.workspaceId);
    view.config.slots[state.slot].activeTabId = state.tabId;
    activateWorkspace(state.workspaceId); view.zoomedSlot = null;
    if (state.slot >= view.config.rows * view.config.cols) { view.config.rows = 4; view.config.cols = 4; }
    applyLayout(view); renderPane(view, state.slot); markFocused(view, state.slot, state.tabId);
    state.liveReplace.invalidate(); state.liveIntent = false; state.terminal.clearSelection(); updateLiveSelection(state);
    input.value = command.text; input.dispatchEvent(new Event('input', { bubbles: true }));
    if (!$('showLineEditors').checked) { $('showLineEditors').checked = true; $('showLineEditors').dispatchEvent(new Event('change')); }
    $('captureCommandDialog').close(); input.focus(); input.setSelectionRange(input.value.length, input.value.length); queueSave();
  }
  function positionContextMenu(menu, x, y) {
    x = Number.isFinite(x) ? x : 8; y = Number.isFinite(y) ? y : 8;
    menu.hidden = false; menu.style.left = Math.max(8, Math.min(x, window.innerWidth - menu.offsetWidth - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(y, window.innerHeight - menu.offsetHeight - 8)) + 'px';
  }
  function renderCaptures() {
    var list = $('captureList'), wasOpen = !!list.querySelector('.capture-history[open]'); list.textContent = '';
    $('captureCount').textContent = String(capturedValues.length);
    $('captureEmpty').hidden = capturedValues.length > 0; $('clearCapturesButton').disabled = capturedValues.length === 0;
    var history = document.createElement('details'); history.className = 'capture-history'; history.open = wasOpen;
    var summary = document.createElement('summary'); summary.textContent = '歷史查詢（' + capturedValues.filter(function (item) { return item.historical; }).length + '）';
    history.appendChild(summary);
    var groups = new Map();
    capturedValues.forEach(function (item) {
      var parent = item.historical ? history : list;
      if (!item.historical && item.workspaceId) {
        var groupKey = [item.workspaceId, item.slot, item.tabId].join('|');
        if (!groups.has(groupKey)) {
          var group = document.createElement('section'); group.className = 'capture-group';
          var heading = document.createElement('h3'); heading.textContent = item.source; group.appendChild(heading);
          groups.set(groupKey, group); list.appendChild(group);
        }
        parent = groups.get(groupKey);
      }
      var row = document.createElement('article'); row.className = 'capture-item'; row.draggable = true; row.dataset.address = item.address;
      row.dataset.historical = String(!!item.historical);
      var top = document.createElement('div'); top.className = 'capture-item-heading';
      var label = document.createElement('span'); label.textContent = item.historical ? '先前查詢' : item.kind === 'scope' ? 'Wi-Fi Aware 介面' : '最近查詢';
      var time = document.createElement('time'); time.dateTime = item.seen.toISOString(); time.textContent = item.seen.toLocaleTimeString('zh-TW', { hour12: false }); time.title = item.seen.toLocaleString('zh-TW');
      top.append(label, time);
      var address = document.createElement('code'); address.className = 'capture-address'; address.textContent = item.address;
      var source = document.createElement('p'); source.className = 'capture-source'; source.textContent = item.source + (item.interfaceName ? ' · ' + item.interfaceName : ''); source.title = source.textContent;
      var copy = document.createElement('button'); copy.type = 'button'; copy.className = 'button quiet capture-copy'; copy.textContent = '複製'; copy.setAttribute('aria-label', '複製 ' + item.address);
      copy.addEventListener('click', function () { copyCapture(item); });
      var replace = document.createElement('button'); replace.type = 'button'; replace.className = 'button quiet capture-replace'; replace.textContent = '替換'; replace.title = '替換輸入列或指令草稿中框選的文字';
      replace.addEventListener('click', function () { replaceFocusedText(item.address); });
      var remove = document.createElement('button'); remove.type = 'button'; remove.className = 'icon-button capture-remove'; remove.textContent = '×'; remove.setAttribute('aria-label', '移除 ' + item.address);
      remove.addEventListener('click', function () { capturedValues = capturedValues.filter(function (value) { return value !== item; }); renderCaptures(); });
      row.addEventListener('contextmenu', function (event) { showCaptureMenu(event, item); });
      row.addEventListener('dragstart', function (event) {
        captureDragging = true;
        event.dataTransfer.setData('application/x-terminalgrid-value', item.address); event.dataTransfer.setData('text/plain', item.address); event.dataTransfer.effectAllowed = 'copy';
      });
      row.append(top, address, source, copy, replace, remove); parent.appendChild(row);
    });
    if (history.children.length > 1) list.appendChild(history);
    if (captureCommand && $('captureCommandDialog').open) refreshCaptureCommand(false);
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
  function validLineText(value) {
    return typeof value === 'string' && value.length <= 16000 && !/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(value);
  }
  function sameSession(state, generation) {
    return state.status === 'running' && state.generation === generation && getState(state.workspaceId, state.slot, state.tabId) === state;
  }
  function updateLiveSelection(state) {
    var selected = state.terminal.hasSelection();
    if (selected) focusedEditor = { terminal: state };
    if (!selected) {
      if (state.userSelecting || !state.liveIntent) { state.liveSelection = null; state.liveIntent = false; }
      state.hadLiveSelection = false;
    }
    else {
      // Rendering and resize may emit selection events too. Only a new user
      // selection can renew its validity after input/output has changed.
      if (!state.hadLiveSelection || state.userSelecting) state.liveSelection = state.liveReplace.capture();
      state.hadLiveSelection = true;
      state.liveIntent = true;
    }
    selected = selected || state.liveIntent;
    var button = state.lineEditorElement.querySelector('.line-send');
    button.textContent = selected ? '替換' : '貼入';
    button.title = selected ? '用下方文字替換終端框選內容，保留其他字元，不按 Enter' : '貼到終端游標，不按 Enter；若終端已有輸入會接在後面';
    state.lineInput.placeholder = selected ? '輸入替換文字 · Enter 替換，不執行' : '輸入列 · 可框選編輯，Enter 送出';
  }
  function replaceLiveSelection(state, value, saved) {
    var target = saved === undefined ? state.liveSelection : saved;
    if (!target) { showToast(state.liveReplace.getUnavailableMessage() || '請連續框選目前 CMD／PowerShell 提示字元後、尚未送出的指令文字；歷史輸出請帶到輸入列編輯。', true); return false; }
    var result = state.liveReplace.replace(target, value);
    if (!result.ok) { showToast(result.message, true); return false; }
    showToast('已原位替換，其他文字保留；按終端 Enter 才執行。');
    return true;
  }
  function showLiveReplaceMenu(state, x, y) {
    var saved = state.liveSelection;
    if (!saved) { replaceLiveSelection(state, '', null); return; }
    var menu = $('terminalContextMenu'); menu.textContent = ''; menu.className = 'terminal-context-menu live-replace-menu';
    var title = document.createElement('p'); title.className = 'text-edit-label'; title.textContent = '將「' + saved.selected.slice(0, 80) + '」原位替換成';
    var input = document.createElement('input'); input.className = 'text-edit-replacement live-replace-text'; input.type = 'text'; input.maxLength = 16000;
    input.value = state.lineInput.value; input.placeholder = '例如 222；也可貼上或選用暫存值'; input.setAttribute('aria-label', '終端原位替換文字');
    var apply = document.createElement('button'); apply.type = 'button'; apply.className = 'live-replace-apply'; apply.textContent = '替換，不執行';
    function commit(value) { if (replaceLiveSelection(state, value, saved)) menu.hidden = true; }
    apply.addEventListener('click', function () { commit(input.value); });
    input.addEventListener('keydown', function (event) { if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); if (!event.repeat && !event.isComposing && event.keyCode !== 229) commit(input.value); } });
    input.addEventListener('paste', function (event) { if (event.clipboardData && /[\r\n]/.test(event.clipboardData.getData('text/plain'))) { event.preventDefault(); showToast('替換文字必須是單行。', true); } });
    menu.append(title, input, apply);
    currentCaptures().slice(0, 20).forEach(function (item) {
      var button = document.createElement('button'); button.type = 'button'; button.className = 'live-replace-suggestion'; button.textContent = item.address;
      button.title = item.source || ''; button.addEventListener('click', function () { commit(item.address); }); menu.appendChild(button);
    });
    positionContextMenu(menu, x, y); input.focus(); input.select();
    var completion = attachReplacementCompletion(input, saved.selected);
    var observer = new MutationObserver(function () {
      if (menu.hidden || !menu.contains(input)) { completion.dispose(); observer.disconnect(); }
    });
    observer.observe(menu, { attributes: true, attributeFilter: ['hidden'], childList: true });
  }
  function createLineEditor(state, view, tabConfig) {
    var editor = document.createElement('div'); editor.className = 'pane-line-editor';
    var input = document.createElement('input'); input.type = 'text'; input.className = 'pane-line-input'; input.maxLength = 16000;
    input.placeholder = '輸入列 · 可框選編輯，Enter 送出'; input.spellcheck = false; input.autocomplete = 'off';
    input.setAttribute('aria-label', '第 ' + String(state.slot + 1).padStart(2, '0') + ' 格 ' + tabConfig.name + ' 可編輯指令');
    input.title = '在這裡點選任意位置、框選刪除或貼上。Enter 傳送文字與換行；貼入只傳送文字。';
    var paste = document.createElement('button'); paste.type = 'button'; paste.className = 'button line-send'; paste.textContent = '貼入';
    paste.title = '貼到終端游標，不按 Enter；若終端已有輸入會接在後面';
    var interrupt = document.createElement('button'); interrupt.type = 'button'; interrupt.className = 'icon-button line-interrupt'; interrupt.textContent = '■';
    interrupt.title = '中斷目前程式（Ctrl+C）'; interrupt.setAttribute('aria-label', '中斷目前程式');
    editor.append(input, paste, interrupt); state.layer.appendChild(editor);
    state.lineInput = input; state.lineEditorElement = editor; state.lineHistory = []; state.lineHistoryIndex = 0; state.lineDraft = '';
    state.lineEditor = window.TerminalGridTextEdit.attach(input, {
      getValues: currentCaptures, onStatus: showToast, attachReplacementCompletion: attachReplacementCompletion
    });
    state.lineCompletion = attachCommandCompletion(input, state.lineEditor, state);
    input.addEventListener('focus', function () { focusedEditor = { state: state }; });
    function deliver(enter) {
      if (!hostReady || !sameSession(state, state.generation)) { showToast('請先啟動這個終端分頁。'); return; }
      var value = input.value;
      if (state.terminal.hasSelection() || state.liveIntent) {
        if (replaceLiveSelection(state, value)) { input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); }
        return;
      }
      if (!value || !validLineText(value)) { showToast('輸入列只接受單行文字，最多 16,000 字元。', true); return; }
      if (enter) {
        if (!send(withGeneration(state, { type: 'input', data: value + '\r' }))) return;
        rememberCommand(value);
      }
      else state.terminal.paste(value);
      if (state.lineHistory[state.lineHistory.length - 1] !== value) state.lineHistory.push(value);
      if (state.lineHistory.length > 50) state.lineHistory.shift();
      state.lineHistoryIndex = state.lineHistory.length; state.lineDraft = ''; input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      if (!enter) { state.terminal.focus(); showToast('已貼到終端游標，請檢查後自行按 Enter。'); }
      else input.focus();
    }
    input.addEventListener('keydown', function (event) {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); if (!event.repeat) deliver(true); }
      if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey) {
        event.preventDefault();
        if (state.lineHistoryIndex === state.lineHistory.length) state.lineDraft = input.value;
        state.lineHistoryIndex = Math.max(0, Math.min(state.lineHistory.length, state.lineHistoryIndex + (event.key === 'ArrowUp' ? -1 : 1)));
        input.value = state.lineHistoryIndex === state.lineHistory.length ? state.lineDraft : state.lineHistory[state.lineHistoryIndex];
        input.setSelectionRange(input.value.length, input.value.length);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    input.addEventListener('input', function () { if (state.lineHistoryIndex === state.lineHistory.length) state.lineDraft = input.value; });
    paste.addEventListener('click', function () { deliver(false); });
    interrupt.addEventListener('click', function () { if (sameSession(state, state.generation)) send(withGeneration(state, { type: 'input', data: '\x03' })); });
    ['click', 'contextmenu', 'dragover', 'drop'].forEach(function (name) {
      editor.addEventListener(name, function (event) { event.stopPropagation(); });
    });
  }
  function editTerminalSelection(state) {
    var selection = state.terminal.getSelection();
    if (!selection || !validLineText(selection)) { showToast('請選取一整行指令（不含提示字元），再帶入輸入列。', true); return; }
    state.liveReplace.invalidate(); state.liveIntent = false; state.terminal.clearSelection(); updateLiveSelection(state);
    if (!$('showLineEditors').checked) { $('showLineEditors').checked = true; $('showLineEditors').dispatchEvent(new Event('change')); }
    state.lineInput.value = selection; state.lineInput.focus(); state.lineInput.select();
    state.lineInput.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function disposeTerminal(state) {
    if (state.selectionCleanup) state.selectionCleanup();
    if (state.lineEditor) state.lineEditor.dispose();
    if (state.lineCompletion) state.lineCompletion.dispose();
    if (state.rawCompletion) completionMenu.close(state.rawCompletion);
    window.clearTimeout(state.completionTimer);
    try { state.terminal.dispose(); } catch (_) { }
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
    var state = { workspaceId: view.config.id, slot: slot, tabId: tabConfig.id, routeId: uid('route'), layer: mount, terminal: terminal, fit: fit,
      status: 'idle', generation: null, pid: null, exitCode: null, hasOutput: false, clearOnStarted: false };
    resetTerminalRecords(state);
    view.panes[slot].tabs.push(state);
    state.sessionShell = tabConfig.shell;
    state.liveReplace = window.TerminalGridLiveReplace.create(terminal, {
      isRunning: function () { return hostReady && sameSession(state, state.generation); },
      getShell: function () { return state.sessionShell; }, getGeneration: function () { return state.generation; },
      send: function (data) { return send(withGeneration(state, { type: 'input', data: data })); }
    });
    createLineEditor(state, view, tabConfig);
    state.rawCompletion = { input: terminal.textarea, tabOnly: true,
      anchor: function () {
        var rect = terminal.textarea.getBoundingClientRect();
        return rect.width && rect.height ? rect : mount.querySelector('.terminal-mount').getBoundingClientRect();
      },
      apply: function (item, saved) {
        replaceLiveSelection(state, item.value, Object.assign({}, saved, { start: item.start, end: item.end }));
      }
    };
    terminal.textarea.addEventListener('blur', function () {
      completionMenu.close(state.rawCompletion); window.clearTimeout(state.completionTimer);
    });
    terminal.onSelectionChange(function () { updateLiveSelection(state); });
    mount.querySelector('.terminal-mount').addEventListener('mousedown', function (event) {
      if (event.button !== 0) return;
      state.liveReplace.invalidate();
      if (state.selectionCleanup) state.selectionCleanup();
      state.userSelecting = true;
      function finish() { updateLiveSelection(state); state.userSelecting = false; state.selectionCleanup(); }
      state.selectionCleanup = function () { document.removeEventListener('mouseup', finish); state.selectionCleanup = null; };
      document.addEventListener('mouseup', finish);
    });
    terminal.onData(function (data) {
      if (state.status !== 'running' || !hostReady) return;
      var protocol = /^\x1b\[(?:[IO]|\??[0-9;]*[Rc])$/.test(data);
      if (!protocol) {
        completionMenu.close(state.rawCompletion); window.clearTimeout(state.completionTimer);
        state.completionTypingUntil = document.activeElement === terminal.textarea && (/^[^\x00-\x1f\x7f-\x9f]+$/.test(data) || data === '\x7f') ? Date.now() + 500 : 0;
      }
      send(withGeneration(state, { type: 'input', data: data }));
    });
    terminal.onResize(function (size) {
      completionMenu.close(state.rawCompletion); state.liveReplace.resize();
      if (isActive(state) && hostReady) send(withGeneration(state, { type: 'resize', cols: size.cols, rows: size.rows }));
    });
    terminal.attachCustomKeyEventHandler(function (event) {
      if (completionMenu.key(event, state.rawCompletion)) return false;
      if (event.type === 'keydown' && !event.isComposing && event.keyCode !== 229) {
        if (event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey && event.code === 'Space' && completionEnabled() && state.status === 'running') {
          event.preventDefault(); event.stopPropagation(); offerTerminalCompletion(state, true); return false;
        }
        if (event.key === 'Enter' && !event.repeat && !event.altKey && !event.ctrlKey && !event.shiftKey && !event.metaKey && completionEnabled()) {
          var command = state.liveReplace.snapshot();
          if (command) rememberCommand(command.command);
        }
      }
      if (event.code === 'ContextMenu' || (event.shiftKey && event.code === 'F10')) {
        event.preventDefault(); event.stopPropagation();
        if (event.type === 'keydown' && !event.repeat) {
          var bounds = mount.getBoundingClientRect();
          markFocused(getView(state.workspaceId), state.slot, state.tabId); showTerminalMenu(bounds.left + 12, bounds.top + 12, state);
        }
        return false;
      }
      var control = event.ctrlKey && !event.altKey && !event.metaKey;
      var pasteKey = (control && event.code === 'KeyV') || (event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && event.code === 'Insert');
      var copyKey = control && event.code === 'KeyC' && (event.shiftKey || state.terminal.hasSelection());
      if (pasteKey || copyKey) {
        // Returning false stops xterm, but not the browser's native paste.
        event.preventDefault(); event.stopPropagation();
        if (event.type === 'keydown' && !event.repeat) { if (copyKey) copySelection(state); else pasteClipboard(state); }
        return false;
      }
      if ((event.code === 'Backspace' || event.code === 'Delete') && state.terminal.hasSelection()) {
        event.preventDefault(); event.stopPropagation();
        if (event.type === 'keydown' && !event.repeat) replaceLiveSelection(state, '');
        return false;
      }
      if (state.terminal.hasSelection() && !event.ctrlKey && !event.altKey && !event.metaKey && !event.isComposing && event.key && event.key.length === 1) {
        event.preventDefault(); event.stopPropagation();
        if (event.type === 'keydown') replaceLiveSelection(state, event.key);
        return false;
      }
      if (event.type === 'keydown' && !event.shiftKey && !event.altKey && !event.metaKey &&
          ['Home', 'End', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
        var navigation = state.liveReplace.navigation(event);
        if (navigation) {
          event.preventDefault(); event.stopPropagation();
          state.terminal.clearSelection(); send(withGeneration(state, { type: 'input', data: navigation }));
          return false;
        }
      }
      return true;
    });
    mount.querySelector('.terminal-mount').addEventListener('paste', function (event) {
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.clipboardData) pasteText(state, event.clipboardData.getData('text/plain')); else pasteClipboard(state);
    }, true);
    mount.addEventListener('contextmenu', function (event) {
      if (event.target.closest('.pane-line-editor')) return;
      event.preventDefault(); event.stopImmediatePropagation(); markFocused(getView(state.workspaceId), state.slot, state.tabId);
      if (event.shiftKey || event.button !== 2 || rightClickMode === 'menu') {
        showTerminalMenu(event.clientX, event.clientY, state); return;
      }
      $('terminalContextMenu').hidden = true;
      if (state.quickCopyPending) { showToast('正在複製，完成後即可貼上。'); return; }
      if (state.terminal.hasSelection()) {
        state.quickCopyPending = true;
        copySelection(state, true).finally(function () { state.quickCopyPending = false; });
      } else {
        // A right-click with no visible selection is always a plain paste, even
        // if a resize previously retained a stale replacement intent.
        state.liveReplace.invalidate(); state.liveIntent = false; updateLiveSelection(state);
        pasteClipboard(state);
      }
    }, true);
    mount.addEventListener('click', function (event) {
      if (event.target.closest('button[data-action="start"]')) { startSlot(getView(state.workspaceId), state.slot, state.tabId, false); return; }
      markFocused(getView(state.workspaceId), state.slot, state.tabId);
    });
    mount.addEventListener('dragover', function (event) {
      if ([commandDragType, literalDragType, 'application/x-terminalgrid-value'].some(function (type) { return hasDataType(event.dataTransfer, type); })) {
        event.preventDefault(); event.dataTransfer.dropEffect = 'copy';
      }
    });
    mount.addEventListener('drop', function (event) {
      var captured = hasDataType(event.dataTransfer, 'application/x-terminalgrid-value');
      var literal = hasDataType(event.dataTransfer, literalDragType);
      var value = event.dataTransfer && event.dataTransfer.getData(captured ? 'application/x-terminalgrid-value' : literal ? literalDragType : commandDragType);
      if (!value) return;
      event.preventDefault(); event.stopPropagation();
      if (captured && !validCaptureText(value)) return;
      if (literal && !validLineText(value)) return;
      markFocused(getView(state.workspaceId), state.slot, state.tabId); insertCommand(state, value, captured, literal);
    });
    if (terminal.textarea) terminal.textarea.setAttribute('aria-label', '第 ' + (slot + 1) + ' 格 ' + tabConfig.name + ' 可操作終端');
    return state;
  }
  function offerTerminalCompletion(state, explicit) {
    if (!completionEnabled() || document.activeElement !== state.terminal.textarea || !$('terminalContextMenu').hidden) return;
    if (state.terminal.buffer.active.viewportY !== state.terminal.buffer.active.baseY) return;
    var selected = state.terminal.hasSelection();
    var saved = selected ? state.liveSelection : state.liveReplace.snapshot();
    if (!saved) {
      if (explicit) showToast('無法辨識目前指令。可在下方輸入列或指令草稿按 Ctrl+Space。');
      return;
    }
    var context = { value: saved.command, start: selected ? saved.start : saved.cursor, end: selected ? saved.end : saved.cursor, terminal: state };
    var choices = window.TerminalGridCompletion.suggestions(context, completionSources(), explicit);
    state.rawCompletion.explicit = explicit;
    if (!completionMenu.show(state.rawCompletion, saved, choices) && explicit) showToast('目前沒有相符的建議。');
  }
  function createPane(view, index) {
    var element = document.createElement('section'); element.className = 'pane'; element.dataset.slot = index; element.dataset.status = 'idle';
    element.innerHTML = '<header class="pane-header"><div class="pane-title-row"><span class="slot-number">' + String(index + 1).padStart(2, '0') + '</span><span class="state-dot" aria-hidden="true"></span><h2 class="pane-name"></h2><div class="pane-controls"><button class="icon-button" data-action="configure" title="終端設定" aria-label="終端設定">⚙</button><button class="icon-button" data-action="zoom" title="放大終端" aria-label="放大終端">⛶</button><button class="icon-button close-button" data-action="stop" title="結束終端" aria-label="結束終端">×</button></div></div><div class="pane-tabs" role="tablist"></div><div class="pane-toolbar"><select class="pane-shell" aria-label="終端類型"><option value="CMD">CMD</option><option value="PowerShell">PowerShell</option><option value="PowerShell 7">PowerShell 7</option><option value="Custom">自訂程式</option></select><span class="pane-state"></span><button class="icon-button pane-folder" data-action="folder" title="選擇啟動資料夾" aria-label="選擇啟動資料夾">📁</button><button class="icon-button pane-restart" data-action="restart" title="重新啟動終端" aria-label="重新啟動終端">↻</button><button class="button pane-start" data-action="start">啟動</button></div><div class="pane-directory"><span class="pane-folder-path"></span></div></header><div class="terminal-container"></div>';
    view.grid.appendChild(element);
    var menuButton = document.createElement('button'); menuButton.className = 'icon-button pane-menu';
    menuButton.dataset.action = 'menu'; menuButton.textContent = '⋯';
    menuButton.title = '終端選單（Shift＋右鍵）'; menuButton.setAttribute('aria-label', '終端功能選單');
    menuButton.setAttribute('aria-haspopup', 'menu');
    element.querySelector('.pane-controls').prepend(menuButton);
    element.querySelector('.pane-folder').innerHTML = '<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M2.5 5h5l2 2h8v9h-15z"/><path d="M2.5 5V3.5h5l2 2H17v1.5"/></svg>';
    var cell = { element: element, container: element.querySelector('.terminal-container'), tabs: [], config: view.config.slots[index] };
    view.panes[index] = cell;
    installPaneTransfer(view, index);
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
      if (button.dataset.action === 'menu') {
        var bounds = button.getBoundingClientRect(); markFocused(view, index, state.tabId);
        showTerminalMenu(bounds.left, bounds.bottom + 4, state);
      }
      if (button.dataset.action === 'configure') openSettings(view, index, state.tabId);
      if (button.dataset.action === 'zoom') toggleZoom(view, index);
      if (button.dataset.action === 'start') startSlot(view, index, state.tabId, false);
      if (button.dataset.action === 'stop') requestStop(state);
      if (button.dataset.action === 'restart') requestRestart(view, index, state.tabId);
      if (button.dataset.action === 'folder') choosePaneFolder(view, index, state.tabId);
    });
    element.querySelector('.pane-shell').addEventListener('change', function (event) {
      var state = activeState(view, index), tab = getTabConfig(view.config, index, state.tabId);
      if (tab.batchFile && event.target.value !== 'CMD') { event.target.value = 'CMD'; showToast('此分頁使用 BAT。請在終端設定清除 BAT 路徑後，再切換 Shell。'); return; }
      tab.shell = event.target.value; renderPane(view, index); queueSave();
      if (tab.shell === 'Custom' && !tab.exe.trim()) openSettings(view, index, state.tabId);
    });
    element.querySelector('.terminal-container').addEventListener('click', function (event) {
      if (!event.target.closest('button,input,textarea,.pane-line-editor')) { var state = activeState(view, index); if (state.status === 'running') state.terminal.focus(); }
    });
    renderPane(view, index);
  }
  function createView(workspace) {
    var grid = document.createElement('main'); grid.className = 'terminal-grid'; grid.setAttribute('aria-label', workspace.name + ' 終端網格');
    grid.hidden = true;
    grid.dataset.workspaceId = workspace.id; workspaceHost.appendChild(grid);
    var view = { config: workspace, grid: grid, panes: [], zoomedSlot: null };
    views.push(view);
    for (var i = 0; i < MAX_SLOTS; i++) createPane(view, i);
    return view;
  }
  function destroyViews() {
    draftTarget = null; focusedEditor = null;
    capturedValues = []; queueCaptureRender();
    views.forEach(function (view) {
      view.panes.forEach(function (cell) { cell.tabs.forEach(disposeTerminal); });
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
      button.addEventListener('dragenter', function (event) { if (paneDrag && hasDataType(event.dataTransfer, paneDragType) && activeView.config.id !== workspace.id) activateWorkspace(workspace.id); });
      button.addEventListener('dragover', function (event) { if (paneDrag) event.preventDefault(); });
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
    completionMenu.close();
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
        view.panes.forEach(function (cell) { cell.tabs.forEach(function (state) { pruneCaptures(state); disposeTerminal(state); }); });
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
    element.querySelector('[data-action="folder"]').disabled = !hostReady || isBusy(state) || pendingFolderRequest !== null || !!tab.batchFile;
    element.querySelector('[data-action="folder"]').title = isActive(state) ? '選擇下次啟動資料夾，不中斷目前測試' : '選擇資料夾並啟動此終端';
    element.querySelector('.pane-folder-path').textContent = tab.cwd || '工作目錄：預設';
    element.querySelector('.pane-folder-path').title = tab.cwd || '使用預設工作目錄';
    element.querySelector('.pane-start').textContent = state.status === 'starting' ? '啟動中' : '啟動';
    element.querySelectorAll('[data-action="start"]').forEach(function (button) { button.disabled = !hostReady || isActive(state); });
    var strip = element.querySelector('.pane-tabs'); strip.textContent = '';
    cell.config.tabs.forEach(function (item) {
      var button = document.createElement('button'); button.type = 'button'; button.className = 'terminal-tab';
      button.dataset.tabId = item.id; button.setAttribute('role', 'tab'); button.setAttribute('aria-selected', String(item.id === cell.config.activeTabId));
      button.draggable = true;
      button.title = item.name + ' · ' + stateLabel(getState(view.config.id, slot, item.id)); button.textContent = item.name;
      var remove = document.createElement('span'); remove.className = 'terminal-tab-close'; remove.textContent = '×'; remove.title = '移除此終端分頁';
      remove.addEventListener('click', function (event) { event.stopPropagation(); removeTerminalTab(view, slot, item.id); });
      button.appendChild(remove); strip.appendChild(button);
    });
    var plus = document.createElement('button'); plus.type = 'button'; plus.className = 'terminal-tab-add'; plus.dataset.addTab = 'true'; plus.textContent = '＋'; plus.title = '在此格新增終端分頁'; plus.disabled = cell.config.tabs.length >= MAX_TABS; strip.appendChild(plus);
    cell.tabs.forEach(function (child) {
      var selected = child.tabId === cell.config.activeTabId;
      child.layer.hidden = !selected; child.layer.querySelector('.empty-name').textContent = child.status === 'starting' ? '正在建立終端…' : child.status === 'error' ? '請檢查設定後重試' : '準備開始新的測試';
      var childConfig = getTabConfig(view.config, slot, child.tabId);
      child.layer.querySelector('.empty-command').textContent = child.status === 'error' ? '啟動失敗' : (childConfig.batchFile ? 'BAT · ' + childConfig.batchFile : childConfig.command || childConfig.shell + ' · 可直接輸入指令');
      child.layer.querySelector('.pane-empty').hidden = child.hasOutput || child.status === 'running' || child.status === 'stopping';
      var exit = child.layer.querySelector('.exit-notice'); exit.hidden = child.status !== 'exited' || !child.hasOutput;
      exit.textContent = '已結束 · 結束碼 ' + (child.exitCode === null ? '—' : child.exitCode) + ' · 輸出已保留';
      child.terminal.options.disableStdin = child.status !== 'running';
      child.terminal.options.fontSize = view.config.fontSize;
      child.lineInput.disabled = child.status !== 'running';
      if (!selected || child.lineInput.disabled) child.lineEditor.closeMenu();
      child.lineEditorElement.querySelector('.line-send').disabled = child.status !== 'running';
      child.lineEditorElement.querySelector('.line-interrupt').disabled = child.status !== 'running';
    });
  }
  function removeTerminalTab(view, slot, tabId) {
    var cell = view.panes[slot], state = getState(view.config.id, slot, tabId);
    if (!state || isBusy(state) || transferPending) { showToast('請等目前操作完成。'); return; }
    askConfirmation('移除終端分頁？', '「' + (getTabConfig(view.config, slot, tabId).name) + '」中的執行中程序也會結束。', '移除分頁').then(function (accepted) {
      if (!accepted) return;
      var before = JSON.parse(JSON.stringify(appConfig));
      if (isActive(state)) send(withGeneration(state, { type: 'stop' }));
      pruneCaptures(state); disposeTerminal(state); state.layer.remove();
      cell.tabs = cell.tabs.filter(function (s) { return s !== state; });
      cell.config.tabs = cell.config.tabs.filter(function (t) { return t.id !== tabId; });
      if (!cell.config.tabs.length) { var empty = defaultTab(0, uid('tab')); cell.config.tabs.push(empty); makeTerminal(view, slot, empty); }
      if (cell.config.activeTabId === tabId) cell.config.activeTabId = cell.config.tabs[0].id;
      rememberPaneAction('關閉分頁', before, appConfig, [], stateAddress(state), [{ workspaceId: view.config.id, slot: slot }]);
      renderPane(view, slot); if (focused && focused.state === state) markFocused(view, slot, cell.config.activeTabId); queueSave(); updateCounts();
    });
  }
  function applyLayout(view) {
    if (!view) return;
    var config = view.config, count = config.rows * config.cols, grid = view.grid;
    grid.style.setProperty('--grid-rows', String(config.rows)); grid.style.setProperty('--grid-cols', String(config.cols));
    grid.classList.toggle('is-dense', config.rows >= 3 || config.cols >= 3);
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
  function startSlot(view, slot, tabId, clear, recording) {
    var state = getState(view.config.id, slot, tabId), setting = getTabConfig(view.config, slot, tabId);
    if (!hostReady || !state || isActive(state) || !validateState(view, slot, tabId)) return false;
    state.clearOnStarted = !!clear; state.status = 'starting'; state.exitCode = null;
    try { state.fit.fit(); } catch (_) { }
    var sent = send(Object.assign({ type: 'start', workspaceId: view.config.id, slot: slot, tabId: tabId,
      config: Object.assign({}, setting), cols: Math.max(2, state.terminal.cols), rows: Math.max(1, state.terminal.rows) }, recording));
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
    $('settingBrowse').disabled = !hostReady || pendingFolderRequest !== null || !!$('settingBatchFile').value;
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
    $('settingBatchFile').value = setting.batchFile || '';
    $('settingShell').querySelector('option[value="PowerShell 7"]').disabled = !capabilities.pwsh && setting.shell !== 'PowerShell 7';
    $('settingBrowse').disabled = !hostReady || pendingFolderRequest !== null; updateCustomFields(); $('settingsDialog').showModal();
    $('settingName').focus(); $('settingName').select();
  }
  function updateCustomFields() {
    var custom = $('settingShell').value === 'Custom', batch = !!$('settingBatchFile').value;
    $('customFields').hidden = !custom; $('settingCommand').disabled = custom || batch;
    $('settingCwd').disabled = batch; $('settingBrowse').disabled = batch || !hostReady || pendingFolderRequest !== null;
    $('commandHint').textContent = batch ? '此分頁直接執行上方 BAT 原檔，使用原檔所在資料夾；清除 BAT 路徑即可恢復一般啟動指令。' : custom ? '自訂程式請使用上方的啟動參數。此欄指令不會傳送給自訂程式。' : '儲存設定不會執行指令；修改會在下次啟動生效。';
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
  async function copySelection(state, clearSelection) {
    var selection = state.terminal.getSelection();
    if (!selection) { showToast('請先選取要複製的文字。'); return; }
    if (clearSelection) {
      state.liveReplace.invalidate(); state.liveIntent = false;
      state.terminal.clearSelection(); updateLiveSelection(state);
    }
    try { await navigator.clipboard.writeText(selection); showToast('已複製終端文字。'); }
    catch (_) { showToast('無法使用剪貼簿，請檢查系統權限。', true); }
  }
  function pasteClipboard(state) {
    if (state.status !== 'running') { showToast('請先啟動這個終端分頁。'); return Promise.resolve(); }
    var generation = state.generation, read, selected = state.terminal.hasSelection() || state.liveIntent;
    var selectedTarget = selected ? state.liveSelection : null;
    try { read = navigator.clipboard.readText(); } catch (_) { read = Promise.reject(new Error('clipboard')); }
    // Start each read during the user's gesture, preserve deliberate paste order,
    // and consume a rejection immediately while an earlier confirmation is open.
    var result = Promise.resolve(read).then(function (value) { return { value: value }; }, function () { return { failed: true }; });
    state.pasteQueue = (state.pasteQueue || Promise.resolve()).then(async function () {
      var clipboard = await result;
      if (!sameSession(state, generation)) return;
      if (clipboard.failed) { showToast('無法讀取剪貼簿，請檢查系統權限。', true); return; }
      if (selected) replaceLiveSelection(state, clipboard.value, selectedTarget);
      else await pasteText(state, clipboard.value, generation, false);
    }).catch(function () { showToast('貼上未完成，請重試。', true); });
    return state.pasteQueue;
  }
  async function pasteText(state, value, expectedGeneration, allowReplace) {
    var generation = expectedGeneration === undefined ? state.generation : expectedGeneration;
    if (!value || !sameSession(state, generation)) return;
    if (allowReplace !== false && (state.terminal.hasSelection() || state.liveIntent)) { replaceLiveSelection(state, value); return; }
    if (value.length > 1048576) { showToast('剪貼簿文字超過 1 MB。', true); return; }
    if (/[\r\n]/.test(value)) {
      var preview = value.length > 500 ? value.slice(0, 500) + '\n…（僅顯示前 500 字）' : value;
      if (!(await askConfirmation('貼上多行文字？', '多行貼上可能執行指令，請先檢查內容。\n\n' + preview, '確認貼上'))) return;
    }
    if (!sameSession(state, generation)) return;
    state.terminal.paste(value); state.terminal.focus();
  }
  async function insertCommand(state, value, captured, resolved) {
    if (!state || state.status !== 'running') { showToast('請先啟動要插入指令的終端分頁。'); return; }
    if (!captured && !resolved) value = window.TerminalGridDefaults.prepare(value);
    if (!captured && !resolved && window.TerminalGridDefaults.keys(value).length) { openPathCommand(state, value); return; }
    if (state.terminal.hasSelection() || state.liveIntent) { replaceLiveSelection(state, value); return; }
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
    if (message.type === 'runFile') {
      if (message.error) showToast(message.error, true);
      else {
        if (lastRun && lastRun.id === message.runId) lastRun.path = message.path;
        if (activeRun && activeRun.id === message.runId) activeRun.path = message.path;
        $('flowLogPath').textContent = message.path;
      }
      return;
    }
    if (message.type === 'evidenceReady') {
      if (!evidence || evidence.id !== message.requestId) return;
      if (message.error) { evidence = null; showToast(message.error, true); return; }
      $('evidenceStatus').textContent = evidence.status;
      $('evidenceLogLines').value = evidence.lines.join('\n') || '尚無可判讀的輸出。';
      $('saveEvidenceButton').disabled = false;
      $('evidenceDialog').showModal();
      return;
    }
    if (message.type === 'evidenceSaved') { showToast('PNG 與同名 Log 已儲存：' + message.path); return; }
    if (message.type === 'relocated') {
      if (!transferPending || message.requestId !== transferPending.id) return;
      var transfer = transferPending; transferPending = null;
      document.body.classList.remove('transfer-pending');
      if (message.error) showToast('未移動：' + message.error, true);
      else { finishTransfer(transfer.plan, transfer.history, transfer.undo); }
      saveConfig(false); return;
    }
    if (message.type === 'batchFiles') { handleBatchFiles(message); return; }
    if (message.type === 'androidPathResult') {
      var browser = remoteBrowser;
      if (!browser || browser.requestId !== message.requestId || browser.target !== pathCommandTarget || !$('androidBrowseDialog').open) return;
      if (message.error) {
        $('androidBrowseStatus').textContent = message.error;
        return;
      }
      if (message.adbPath) {
        browser.target.adbPath = message.adbPath;
        browser.folder = message.adbPath.replace(/[^\\/]+$/, '');
      }
      browser.entries = message.entries || [];
      browser.entries.forEach(function (entry, index) {
        $('androidBrowseEntries').add(new Option(entry.name + (entry.directory ? '/' : ''), index));
      });
      browser.loaded = true;
      $('androidBrowseStatus').textContent = browser.entries.length ? '選取檔案或資料夾。' : '此資料夾目前沒有項目。';
      updateRemoteBrowserButtons();
      return;
    }
    if (adbToolsPick && message.type === 'commandPathPicked' && message.requestId === adbToolsPick.id) {
      var picker = adbToolsPick; adbToolsPick = null;
      if (picker.dialog.open && !message.cancelled && !message.error && typeof message.path === 'string') {
        adbToolsFolder = message.path;
        try { localStorage.setItem('terminalGrid.adbToolsFolder', adbToolsFolder); } catch (_) { }
        picker.refresh();
      } else if (message.error) showToast(message.error, true);
      return;
    }
    if (appsRequest && message.requestId === appsRequest.id && ['commandTargets', 'androidActionResult'].includes(message.type)) {
      var request = appsRequest; appsRequest = null;
      if (!$('androidAppsDialog').open) return;
      if (message.type === 'commandTargets') {
        appsAdbPath = message.adbPath ? message.adbPath.replace(/[^\\/]+$/, '') : adbToolsFolder;
        var devices = (message.candidates || []).filter(function (item) { return item.kind === 'device'; });
        devices.forEach(function (item) { $('androidDevice').add(new Option(item.label, item.value)); });
        $('androidAppsStatus').textContent = message.message || '選擇裝置以讀取可開啟的 App。';
        if (devices.length === 1) { $('androidDevice').value = devices[0].value; loadAndroidApps(); }
      } else if (message.error) $('androidAppsStatus').textContent = message.error;
      else if (request.type === 'androidApps') {
        appComponents = Array.isArray(message.components) ? message.components : [];
        renderAndroidApps();
        $('androidAppsStatus').textContent = appComponents.length ? '找到 ' + appComponents.length + ' 個啟動項目。' : '找不到可啟動的 App。';
      } else if (request.type === 'androidMirror') {
        $('androidAppsStatus').textContent = message.alreadyOpen ? '這台裝置已有由 Terminal Grid 啟動的 scrcpy 視窗。' : '已啟動 scrcpy，請查看獨立鏡像視窗。';
      } else if (request.type === 'androidWake') {
        $('androidAppsStatus').textContent = '已送出喚醒指令。若出現鎖定畫面，請在手機上解鎖。';
      } else $('androidAppsStatus').textContent = request.sysdump
        ? '已開啟撥號器。請查看手機是否進入 SysDump；若只顯示撥號畫面，請清空後手動鍵入 *#9900#。'
        : '手機已接收開啟 App 的指令。';
      updateAndroidButtons();
      return;
    }
    if (message.type === 'commandPathPicked' && flowRecordingPick && message.requestId === flowRecordingPick) {
      flowRecordingPick = null;
      if (!message.cancelled && !message.error && typeof message.path === 'string') {
        flowRecordingFolder = message.path;
        $('flowRecordingFolder').textContent = $('caseRecordingFolder').textContent = message.path;
      } else if (message.error) showToast(message.error, true);
      return;
    }
    if (message.type === 'commandTargets' && testCaseCheck && message.requestId === testCaseCheck.requestId) {
      finishTestCaseCheck(message); return;
    }
    if (message.type === 'commandPathPicked' && testCasePathId && message.requestId === testCasePathId) {
      testCasePathId = null;
      if ($('testCaseDialog').open && !message.cancelled && !message.error) {
        $('testCaseFolder').value = message.path;
        $('testCaseFolder').dispatchEvent(new Event('input', { bubbles: true }));
      }
      if (message.error) $('testCaseStatus').textContent = message.error;
      return;
    }
    if (message.type === 'commandTargets' && nanDiscoveryId && message.requestId === nanDiscoveryId) {
      nanDiscoveryId = null;
      if (!$('nanDialog').open) return;
      $('nanDevices').textContent = '';
      var nanCandidates = Array.isArray(message.candidates) ? message.candidates : [];
      var devices = nanCandidates.filter(function (c) { return c.kind === 'device'; }).slice(0, 256);
      devices.forEach(function (c) { $('nanDevices').appendChild(new Option(c.label, c.value)); });
      if (devices.length === 2 && !$('nanDut1').value && !$('nanDut2').value) {
        $('nanDut1').value = devices[0].value; $('nanDut2').value = devices[1].value;
      }
      $('nanStatus').textContent = devices.length
        ? '找到 ' + devices.length + ' 台已授權手機。請核對 DUT1 與 DUT2 序號。'
        : !message.adbPath && /找不到 adb\.exe/.test(message.message || '')
          ? '找不到 adb.exe。請按上方「選資料夾…」，選擇含 adb.exe 的 Platform Tools 或 scrcpy 資料夾。'
          : message.message || '未找到已授權的手機。請檢查 USB 連線與偵錯授權後重新偵測。';
      return;
    }
    if (message.type === 'commandPathPicked' && nanPathId && message.requestId === nanPathId) {
      nanPathId = null;
      if ($('nanDialog').open && !message.cancelled && !message.error && typeof message.path === 'string') { $('nanFolder').value = message.path; discoverNanDevices(); }
      else if (message.error) showToast(message.error, true);
      return;
    }
    if (message.type === 'commandTargets') {
      var discovery = targetDiscoveryRequest;
      if (!discovery || discovery.id !== message.requestId || discovery.target !== pathCommandTarget || !$('pathCommandDialog').open) return;
      targetDiscoveryRequest = null;
      pathCommandTarget.adbPath = typeof message.adbPath === 'string' ? message.adbPath : '';
      targetCandidates = Array.isArray(message.candidates) ? message.candidates.filter(function (c) { return c && typeof c.value === 'string' && typeof c.label === 'string'; }).slice(0,768) : [];
      refreshTargetOptions(); $('targetDiscoveryStatus').textContent = message.message || '偵測完成。僅供選擇，遠端 IP 的連線狀態需由測試確認。'; return;
    }
    if (message.type === 'commandPathPicked') {
      var request = pathPickPending;
      if (!request || request.id !== message.requestId) return;
      pathPickPending = null;
      if (request.target !== pathCommandTarget || !$('pathCommandDialog').open) return;
      if (message.error) showToast(message.error, true);
      else if (!message.cancelled && typeof message.path === 'string') {
        request.input.value = message.path; request.input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return;
    }
    if (message.type === 'folderPicked' || message.type === 'folderPickError') { handleFolderResult(message); return; }
    if (message.type === 'init') {
      paneHistory = []; selectedPanes.clear();
      batchRequests = {}; invalidateFolderRequests(); destroyViews(); appConfig = normalizeAppConfig(message.config);
      capabilities = Object.assign({ pwsh: false }, message.capabilities || {}); hostReady = true;
      appConfig.workspaces.forEach(createView); activateWorkspace(appConfig.activeWorkspaceId);
      $('connectionDot').className = 'connection-dot connected'; $('connectionText').textContent = '終端引擎已就緒';
      $('connectionText').title = 'Terminal Grid ' + (message.version || '3.0') + ' · Windows ConPTY';
      $('saveButton').disabled = false; $('exportButton').disabled = false; $('importButton').disabled = false;
      renderFlowOptions(); renderCommandLibrary(); applyLayout(activeView); setStatus('選工作區，再在格子右上角按 ＋ 加終端分頁。'); return;
    }
    if (message.type === 'imported') {
      paneHistory = []; selectedPanes.clear();
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
      completionMenu.close(state.rawCompletion); state.completionTypingUntil = 0;
      if (isStale(state, message, true)) return;
      pruneCaptures(state); resetTerminalRecords(state);
      state.liveReplace.reset(); state.liveSelection = null; state.liveIntent = false; state.terminal.clearSelection(); updateLiveSelection(state);
      state.recording = false; state.recordingPath = null;
      var startedTab = getTabConfig(view.config, state.slot, state.tabId);
      state.sessionShell = startedTab.shell;
      if (startedTab.shell === 'Custom' &&
          ((/(?:^|[\\/])TerminalGridNan\.exe$/i.test(startedTab.exe) && /^--mode shell[12](?: |$)/.test(startedTab.args)) ||
           (/(?:^|[\\/])adb(?:\.exe)?$/i.test(startedTab.exe) && /\bshell\b/.test(startedTab.args))))
        state.sessionShell = 'Android';
      state.lineInput.value = ''; state.lineInput.dispatchEvent(new Event('input', { bubbles: true }));
      if (typeof message.generation === 'number') state.generation = message.generation;
      if (activeRun && activeRun.output.has(state)) {
        var observation = activeRun.output.get(state);
        if (!observation.started) observation.firstStartedGeneration = state.generation;
        observation.generation = state.generation;
        observation.buffer = window.TerminalGridFlowOutput.create();
        observation.started = true;
      }
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
    if (message.type === 'recording') {
      state.recording = message.recording; state.recordingPath = message.path;
      if (activeRun && activeRun.recorded.has(state)) {
        if (message.error) activeRun.captureError = message.error;
        if (message.recording && activeRun.recorded.get(state) !== message.generation) {
          activeRun.recorded.set(state, message.generation);
          activeRun.lines.push('逐行 Log · 第 ' + (state.slot + 1) + ' 格 · ' + message.path);
        }
      }
      if (state.recordingReply) state.recordingReply(message.error || '');
      if (logState === state) updateRecording();
      if (message.error) showToast(message.error, true);
      return;
    }
    if (message.type === 'output') {
      if (typeof message.data !== 'string' || !message.data) return;
      try {
        var binary = window.atob(message.data), bytes = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        var gen = message.generation, size = bytes.length;
        state.transcript.feed(bytes);
        if (state.iperfOutput) state.iperfOutput.feed(bytes);
        var observation = activeRun && activeRun.output.get(state);
        if (observation && observation.generation === state.generation) observation.buffer.feed(bytes);
        var outputToken = state.liveReplace.output();
        completionMenu.close(state.rawCompletion);
        state.terminal.write(bytes, function () {
          if (state.generation === gen) {
            state.liveReplace.parsed(outputToken);
            if (state.completionTypingUntil > Date.now() && completionEnabled()) {
              window.clearTimeout(state.completionTimer);
              state.completionTimer = window.setTimeout(function () { offerTerminalCompletion(state, false); }, 125);
            }
          }
          send({ type: 'ack', workspaceId: state.workspaceId, slot: state.slot, tabId: state.tabId, bytes: size, generation: gen });
        });
        try { if ($('captureEnabled').checked) state.captureScanner.feed(state.captureDecoder.decode(bytes, { stream: true })); }
        catch (_) { resetCaptureScanner(state); setStatus('IPv6 擷取已重設；終端輸出繼續顯示。'); }
        if (!state.hasOutput) { state.hasOutput = true; renderPane(view, state.slot); }
      } catch (_) { setStatus('無法解碼終端輸出。'); }
      return;
    }
    if (message.type === 'exited') {
      completionMenu.close(state.rawCompletion); window.clearTimeout(state.completionTimer);
      try { if ($('captureEnabled').checked) { state.captureScanner.feed(state.captureDecoder.decode()); state.captureScanner.flush(); } } catch (_) { resetCaptureScanner(state); }
      state.status = 'exited'; state.pid = null; state.exitCode = typeof message.exitCode === 'number' ? message.exitCode : null;
      state.recording = false; if (logState === state) updateRecording();
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
  function selectedTestCase() { return appConfig.testCases.find(function (item) { return item.id === testCaseId; }); }
  function testCaseSerials(value) { return window.TerminalGridTestCases.serials(value); }
  function updateTestCaseButtons() {
    var item = selectedTestCase();
    $('runTestCase').disabled = !item || !appConfig.automations.some(function (f) { return f.id === item.flowId && f.steps.length; }) ||
      $('testCaseSelect').value !== testCaseId || testCaseDirty || !!testCaseCheck || flowRunning || flowPreparing;
    $('deleteTestCase').disabled = !item || !!testCaseCheck;
    $('runTestCaseQueue').disabled = !testCaseQueue.size || !!testCaseCheck || testCaseQueueRunning || flowRunning || flowPreparing;
  }
  function renderTestCaseList() {
    var list = $('testCaseSelect'), query = $('testCaseFilter').value.trim().toLowerCase();
    list.replaceChildren(new Option('選擇測項', ''));
    appConfig.testCases.filter(function (item) { return (item.code + ' ' + item.title).toLowerCase().includes(query); })
      .forEach(function (item) { list.add(new Option(item.code + ' · ' + item.title, item.id)); });
    list.value = testCaseId;
    var queue = $('testCaseQueue');
    queue.replaceChildren();
    testCaseQueue.forEach(function (id) {
      if (!appConfig.testCases.some(function (item) { return item.id === id; })) testCaseQueue.delete(id);
    });
    appConfig.testCases.forEach(function (item) {
      var check = document.createElement('input'), label = document.createElement('label');
      check.type = 'checkbox'; check.checked = testCaseQueue.has(item.id);
      check.disabled = !appConfig.automations.some(function (flow) { return flow.id === item.flowId && flow.steps.length; });
      if (check.disabled) testCaseQueue.delete(item.id);
      check.addEventListener('change', function () {
        if (check.checked) testCaseQueue.add(item.id); else testCaseQueue.delete(item.id);
        updateTestCaseButtons();
      });
      label.append(check, document.createTextNode(' ' + item.code + ' · ' + item.title));
      queue.append(label);
    });
  }
  function editTestCase(id) {
    testCaseId = id; testCaseDirty = false;
    var item = selectedTestCase() || { usbCount: 0, feasibility: 'pending' };
    var flowList = $('testCaseFlow');
    flowList.replaceChildren(new Option('尚未連結流程', ''));
    appConfig.automations.forEach(function (flow) { flowList.add(new Option(flow.name, flow.id)); });
    $('testCaseCode').value = item.code || ''; $('testCaseName').value = item.title || '';
    $('testCaseFeasibility').value = item.feasibility;
    $('testCaseNotes').value = item.notes || ''; $('testCaseUsb').value = item.usbCount;
    $('testCaseSerials').value = item.serials || ''; $('testCaseFolder').value = item.toolsFolder || '';
    flowList.value = item.flowId || '';
    if (!flowList.value) flowList.value = '';
    $('testCaseStatus').textContent = item.flowId && !flowList.value ? '原本連結的流程已移除，請重新選擇。' : '';
    renderTestCaseList(); updateTestCaseButtons();
  }
  function openTestCaseDialog() {
    if (flowRunning || flowPreparing) { showToast('請先完成或停止目前流程。'); return; }
    $('testCaseFilter').value = '';
    editTestCase(testCaseId || (appConfig.testCases[0] || {}).id || '');
    $('testCaseDialog').showModal();
  }
  function saveTestCase(event) {
    event.preventDefault();
    if (testCaseCheck) return;
    var current = selectedTestCase(), code = $('testCaseCode').value.trim(), title = $('testCaseName').value.trim();
    var status = $('testCaseStatus'), serials = testCaseSerials($('testCaseSerials').value);
    if (!code || !title) { status.textContent = '請輸入測項編號與名稱。'; return; }
    if (appConfig.testCases.some(function (item) { return item !== current && item.code.toLowerCase() === code.toLowerCase(); })) {
      status.textContent = '這個 TC 編號已存在。'; return;
    }
    if (!current && appConfig.testCases.length >= 256) { status.textContent = '已達 256 個本機測項上限。'; return; }
    if (serials.length > 16 || serials.some(function (serial) { return !/^[A-Za-z0-9_.:\[\]%-]{1,128}$/.test(serial); })) {
      status.textContent = '請輸入有效的序號，每個序號以逗號或空白分隔。'; return;
    }
    var item = current || { id: uid('case') };
    Object.assign(item, { code: code, title: title, feasibility: $('testCaseFeasibility').value,
      notes: $('testCaseNotes').value, flowId: $('testCaseFlow').value, usbCount: Number($('testCaseUsb').value),
      serials: serials.join(', '), toolsFolder: $('testCaseFolder').value.trim() });
    if (!current) appConfig.testCases.push(item);
    $('testCaseFilter').value = '';
    editTestCase(item.id); queueSave();
    status.textContent = '測項已保存在本機。';
  }
  function launchTestCase(item) {
    $('testCaseDialog').close();
    currentFlowId = item.flowId;
    renderFlowOptions();
    return runFlow(item, $('testCaseLogChecks').checked);
  }
  function finishTestCaseCheck(message) {
    var check = testCaseCheck;
    clearTimeout(check.timer); testCaseCheck = null; updateTestCaseButtons();
    var usb = new Set((Array.isArray(message.candidates) ? message.candidates : [])
      .filter(function (candidate) { return candidate.kind === 'device' && candidate.usb === true; })
      .map(function (candidate) { return candidate.value; }));
    var missing = testCaseSerials(check.item.serials).filter(function (serial) { return !usb.has(serial); });
    if (message.error) { check.resolve(message.error); return; }
    if (usb.size < check.item.usbCount || missing.length) {
      check.resolve('USB 未就緒。此測項至少需 ' + check.item.usbCount + ' 台，已確認 ' + usb.size + ' 台。' +
        (missing.length ? ' 未確認的指定序號：' + missing.join('、') + '。' : '') +
        ' 請接上手機、解鎖並確認 USB 偵錯已授權，再按「預檢並執行」。' +
        (!message.adbPath && message.message ? '\n' + message.message : ''));
      return;
    }
    check.resolve('');
  }
  function verifyCaseUsb(item, cancelOnClose) {
    if (!item.usbCount && !item.serials) return Promise.resolve('');
    if (!hostReady || !activeView) return Promise.resolve('偵測需要連上本機 Terminal Grid 主程式。');
    if (testCaseCheck) return Promise.resolve('已有 USB 偵測進行中，請重試。');
    var state = activeState(activeView, 0), requestId = uid('case-usb');
    return new Promise(function (resolve) {
      testCaseCheck = { requestId: requestId, item: item, resolve: resolve, cancelOnClose: cancelOnClose,
        timer: setTimeout(function () { finishTestCaseCheck({ error: 'USB 偵測逾時，請重試。' }); }, 9000) };
      $('testCaseStatus').textContent = '正在確認已授權的 USB 裝置…';
      updateTestCaseButtons();
      if (!send({ type: 'discoverCommandTargets', requestId: requestId, workspaceId: state.workspaceId, slot: state.slot,
        tabId: state.tabId, toolsFolder: item.toolsFolder })) finishTestCaseCheck({ error: 'USB 偵測無法啟動，請重試。' });
    });
  }
  async function checkTestCase() {
    var item = selectedTestCase();
    if (!item || $('runTestCase').disabled) return;
    item = Object.assign({}, item);
    var error = await verifyCaseUsb(item, true);
    if (!$('testCaseDialog').open || item.id !== testCaseId || testCaseDirty) return;
    if (error) { $('testCaseStatus').textContent = error; return; }
    await launchTestCase(item);
  }
  async function runTestCaseQueue() {
    if ($('runTestCaseQueue').disabled) return;
    var items = Array.from(testCaseQueue).map(function (id) {
      return Object.assign({}, appConfig.testCases.find(function (item) { return item.id === id; }));
    });
    testCaseQueueRunning = true;
    try {
      for (var item of items) {
        if (!$('testCaseDialog').open) $('testCaseDialog').showModal();
        editTestCase(item.id);
        var error = await verifyCaseUsb(item, true);
        if (!$('testCaseDialog').open) break;
        if (error) { $('testCaseStatus').textContent = item.code + ' · ' + error; break; }
        if (!(await launchTestCase(item))) { showToast('續跑停在 ' + item.code + '。後續測項尚未執行。', true); break; }
        testCaseQueue.delete(item.id);
      }
    } finally {
      testCaseQueueRunning = false;
      updateTestCaseButtons();
    }
  }
  async function importTestCases() {
    if (testCaseCheck || testCaseQueueRunning) return;
    var file = $('testCaseImportFile').files[0], status = $('testCaseStatus');
    try {
      if (file && file.size > 1024 * 1024) throw Error('測項檔案上限為 1 MB。');
      var text = file ? await file.text() : $('testCaseImportText').value;
      var cases = window.TerminalGridTestCases.parse(text, appConfig.testCases, appConfig.automations);
      if (!(await askConfirmation('匯入 ' + cases.length + ' 筆本機測項？', cases.slice(0, 25).map(function (item) {
        return item.code + ' · ' + item.title;
      }).join('\n') + (cases.length > 25 ? '\n…' : '') + '\n\n匯入後可逐題核對內容及流程。', '匯入測項'))) return;
      cases = window.TerminalGridTestCases.parse(text, appConfig.testCases, appConfig.automations);
      cases.forEach(function (item) { item.id = uid('case'); appConfig.testCases.push(item); });
      $('testCaseFilter').value = ''; $('testCaseImportFile').value = ''; $('testCaseImportText').value = '';
      editTestCase(cases[0].id); queueSave();
      status.textContent = '已匯入 ' + cases.length + ' 筆本機測項。';
    } catch (error) { status.textContent = error.message; }
  }
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
    $('stopRunningFlow').disabled = !flowRunning;
    if (!flow) { stepsHost.innerHTML = '<p class="help-note">新增流程，逐步安排啟動、輸入指令、等待或結束終端。</p>'; return; }
    var workspace = flowWorkspace(flow);
    if (!workspace) { stepsHost.textContent = '找不到此流程的工作區。'; return; }
    flow.steps.forEach(function (step, index) {
      var row = document.createElement('div'); row.className = 'flow-step';
      var action = document.createElement('select');
      [['start', '啟動終端'], ['send', '輸入指令'], ['wait', '等待時間'], ['pause', '等待操作後繼續'], ['trafficPause', '流量中操作'], ['output', '等待輸出'], ['exit', '確認正常結束'], ['stop', '結束終端']].forEach(function (item) { var o = new Option(item[1], item[0]); action.add(o); });
      if (step.action === 'nanTransfer') action.add(new Option('Ping 成功後選擇傳輸', 'nanTransfer'));
      action.value = step.action;
      var slot = document.createElement('select'); slot.className = 'flow-slot flow-target';
      for (var i = 0; i < MAX_SLOTS; i++) slot.add(new Option(String(i + 1).padStart(2, '0') + ' 格', String(i)));
      slot.value = String(step.slot);
      var tab = document.createElement('select'); tab.className = 'flow-tab flow-target'; fillFlowTabs(tab, workspace, step.slot, step.tabId);
      var manual = step.action === 'pause' || step.action === 'trafficPause';
      var textInput = document.createElement(manual ? 'textarea' : 'input');
      textInput.className = 'flow-step-text';
      textInput.value = step.action === 'wait' ? String(step.delayMs) : (step.text || '');
      textInput.placeholder = step.action === 'wait' ? '毫秒（100–30000）' : manual ? '提示使用者要完成的操作' : '指令內容';
      if (manual) textInput.rows = 2;
      var enterLabel = document.createElement('label'); enterLabel.className = 'flow-enter'; var enter = document.createElement('input'); enter.type = 'checkbox'; enter.checked = step.enter !== false; enterLabel.append(enter, document.createTextNode('Enter'));
      var moveUp = document.createElement('button'); moveUp.type = 'button'; moveUp.className = 'icon-button flow-move'; moveUp.textContent = '↑'; moveUp.title = '上移步驟'; moveUp.disabled = index === 0;
      var moveDown = document.createElement('button'); moveDown.type = 'button'; moveDown.className = 'icon-button flow-move'; moveDown.textContent = '↓'; moveDown.title = '下移步驟'; moveDown.disabled = index === flow.steps.length - 1;
      var remove = document.createElement('button'); remove.type = 'button'; remove.className = 'icon-button'; remove.textContent = '×'; remove.title = '移除此步驟';
      action.disabled = slot.disabled = tab.disabled = textInput.disabled = enter.disabled = flowRunning;
      moveUp.disabled = moveUp.disabled || flowRunning; moveDown.disabled = moveDown.disabled || flowRunning; remove.disabled = flowRunning;
      row.dataset.action = step.action;
      row.append(action, slot, tab, textInput, enterLabel, moveUp, moveDown, remove); stepsHost.appendChild(row);
      if (step.action === 'output' || step.action === 'exit') {
        var conditions = document.createElement('div');
        conditions.className = 'flow-conditions';
        [['timeoutMs', '逾時毫秒', 100, 600000, 10000], ['retries', '再等次數', 0, 5, 0]].forEach(function (spec) {
          var label = document.createElement('label'), input = document.createElement('input');
          label.textContent = spec[1]; input.type = 'number'; input.min = spec[2]; input.max = spec[3]; input.value = step[spec[0]] ?? spec[4];
          input.disabled = flowRunning;
          input.addEventListener('change', function () { step[spec[0]] = limitNumber(input.value, spec[4], spec[2], spec[3]); input.value = step[spec[0]]; queueSave(); });
          label.append(input); conditions.append(label);
        });
        if (step.action === 'output') {
          textInput.placeholder = '成功文字，例如 NAN started';
          var failure = document.createElement('input');
          failure.placeholder = '失敗文字（選填）'; failure.maxLength = 512; failure.value = step.failureText || ''; failure.disabled = flowRunning;
          failure.addEventListener('input', function () { step.failureText = failure.value; queueSave(); });
          conditions.append(failure);
        }
        row.append(conditions);
      }
      row.dataset.step = index + 1;
      if (failedFlowStep && failedFlowStep.flowId === flow.id && failedFlowStep.index === index) row.classList.add('flow-failed');
      action.addEventListener('change', function () { step.action = action.value; renderFlowEditor(); queueSave(); });
      slot.addEventListener('change', function () { step.slot = Number(slot.value); step.tabId = ''; fillFlowTabs(tab, workspace, step.slot, ''); queueSave(); });
      tab.addEventListener('change', function () { step.tabId = tab.value; queueSave(); });
      textInput.addEventListener('input', function () { if (step.action === 'wait') step.delayMs = limitNumber(textInput.value, 500, 100, 30000); else step.text = textInput.value.slice(0, 16000); queueSave(); });
      enter.addEventListener('change', function () { step.enter = enter.checked; queueSave(); });
      moveUp.addEventListener('click', function () { var item = flow.steps.splice(index, 1)[0]; flow.steps.splice(index - 1, 0, item); renderFlowEditor(); queueSave(); });
      moveDown.addEventListener('click', function () { var item = flow.steps.splice(index, 1)[0]; flow.steps.splice(index + 1, 0, item); renderFlowEditor(); queueSave(); });
      remove.addEventListener('click', function () { flow.steps.splice(index, 1); renderFlowEditor(); queueSave(); });
      textInput.hidden = ['start', 'stop', 'exit'].includes(step.action); enterLabel.hidden = step.action !== 'send'; slot.hidden = tab.hidden = step.action === 'wait' || step.action === 'pause';
      if (step.action === 'nanTransfer') { textInput.readOnly = true; textInput.title = '傳輸量由 NAN／NDP 精靈設定，單位為 bytes。'; }
      if (step.action === 'nanTransfer') {
        var during = document.createElement('textarea');
        during.rows = 2; during.maxLength = 4000; during.className = 'flow-conditions';
        during.placeholder = '傳輸進行中的人工操作（僅 iperf，選填）';
        during.setAttribute('aria-label', '傳輸中的人工操作');
        during.value = step.duringTransfer || ''; during.disabled = flowRunning;
        during.addEventListener('input', function () { step.duringTransfer = during.value; queueSave(); });
        row.append(during);
      }
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
        return { action: ['start', 'send', 'wait', 'pause', 'stop', 'output', 'exit', 'nanTransfer', 'trafficPause'].indexOf(s.action) >= 0 ? s.action : 'send',
          slot: slot, tabId: tabId, text: str(s.text, 16000), delayMs: limitNumber(s.delayMs, 500, 100, 30000), enter: s.enter !== false,
          timeoutMs: limitNumber(s.timeoutMs || 10000, 10000, 100, 600000), retries: limitNumber(s.retries, 0, 0, 5), failureText: str(s.failureText, 512), duringTransfer: str(s.duringTransfer, 4000) };
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
  function waitForUserContinue(instruction, stepNumber, buttonLabel) {
    if (flowPauseResolve) return Promise.resolve(false);
    $('flowPauseTitle').textContent = '流程暫停 · 第 ' + stepNumber + ' 步';
    $('flowPauseMessage').textContent = instruction || '請完成需要的手動操作，完成後按「繼續」。';
    $('continuePausedFlowButton').textContent = buttonLabel || '繼續';
    return new Promise(function (resolve) { flowPauseResolve = resolve; $('flowPauseDialog').show(); $('continuePausedFlowButton').focus(); });
  }
  function finishFlowPause(continueFlow) {
    var resolve = flowPauseResolve; flowPauseResolve = null;
    if ($('flowPauseDialog').open) $('flowPauseDialog').close();
    if (resolve) resolve(continueFlow);
  }
  function finishNanTransfer(choice) {
    var resolve = nanTransferResolve; nanTransferResolve = null;
    if ($('nanTransferDialog').open) $('nanTransferDialog').close();
    if (resolve) resolve(choice);
  }
  function nanTransferPlan(workspace, step) {
    var pingTab = getTabConfig(workspace, step.slot, step.tabId);
    function isNanTab(tab, mode) {
      return tab && tab.shell === 'Custom' && /^TerminalGridNan\.exe$/i.test(tab.exe) &&
        tab.args.startsWith('--mode ' + mode + ' ') && !tab.command && !tab.batchFile;
    }
    if (!isNanTab(pingTab, 'ping') || !/^[1-9]\d{0,11}$/.test(step.text)) throw Error('請由 NAN／NDP 精靈建立傳輸選擇步驟。');
    function find(id, mode, tool) {
      var matching = [];
      workspace.slots.forEach(function (cell, slot) {
        cell.tabs.forEach(function (tab) { if (tab.id === id) matching.push({ slot: slot, tab: tab }); });
      });
      var target = matching[0];
      if (matching.length !== 1 || !isNanTab(target.tab, mode) ||
          !target.tab.args.includes('--amount "' + step.text + '" ') || !target.tab.args.includes('--tool "' + tool + '" '))
        throw Error('找不到符合設定的 ' + tool + ' 分頁，請重新建立 NAN／NDP 流程。');
      return target;
    }
    return {
      iperf3: [find('nan-server', 'server', 'iperf3'), find('nan-traffic', 'traffic', 'iperf3')],
      iperf: [find('nan-server-iperf2', 'server', 'iperf'), find('nan-traffic-iperf2', 'traffic', 'iperf')]
    };
  }
  function formatNanAmount(bytes) {
    return (Number(bytes) / 1000000000).toLocaleString('zh-TW', { maximumFractionDigits: 9 }) + ' GB（' + Number(bytes).toLocaleString('zh-TW') + ' bytes）';
  }
  function selectFlowTarget(view, state) {
    if (activeView !== view) activateWorkspace(state.workspaceId);
    view.panes[state.slot].config.activeTabId = state.tabId;
    renderPane(view, state.slot); markFocused(view, state.slot, state.tabId);
  }
  async function startFlowTerminal(view, state) {
    var alreadyRunning = state.status === 'running';
    if (!isActive(state)) {
      observeRun(state, getTabConfig(view.config, state.slot, state.tabId).command);
      var recording;
      if (activeRun.capture) {
        activeRun.recorded.set(state, null);
        recording = { recordRun: activeRun.id, recordFolder: activeRun.captureFolder };
      }
      if (!startSlot(view, state.slot, state.tabId, false, recording)) throw Error('無法啟動終端。');
    } else if (alreadyRunning && activeRun.capture && !activeRun.recorded.has(state)) {
      observeRun(state, getTabConfig(view.config, state.slot, state.tabId).command);
      await recordFlowPane(state);
    }
    var deadline = Date.now() + 30000;
    while (state.status === 'starting' && Date.now() < deadline) await flowDelay(100);
    var observation = activeRun.output.get(state);
    if (state.status !== 'running' && !(state.status === 'exited' && state.exitCode === 0 && observation && observation.started))
      throw Error('終端啟動失敗或逾時。');
  }
  function setFlowRecording(state, enabled) {
    return new Promise(function (resolve, reject) {
      var timeout = setTimeout(function () { finish('等待終端 Log 回覆逾時。'); }, 5000);
      function finish(error) {
        clearTimeout(timeout); state.recordingReply = null;
        if (error) reject(Error(error)); else resolve();
      }
      state.recordingReply = finish;
      if (!send(withGeneration(state, { type: enabled ? 'recordStart' : 'recordStop', timestamp: true,
        recordRun: activeRun.id, recordFolder: activeRun.captureFolder }))) finish('無法設定終端 Log。');
    });
  }
  async function recordFlowPane(state) {
    if (!activeRun.capture || activeRun.recorded.get(state) === state.generation) return;
    if (state.recording) throw Error('此終端已有其他錄製。請先停止錄製或選用另一個終端。');
    activeRun.recorded.set(state, null);
    await setFlowRecording(state, true);
    ensureRunCurrent(state, activeRun.recorded.get(state));
  }
  async function stopFlowTerminal(view, state) {
    if (state.status === 'running') {
      if (!send(withGeneration(state, { type: 'stop' }))) throw Error('無法停止終端。');
      state.status = 'stopping'; renderPane(view, state.slot);
    }
    var deadline = Date.now() + 10000;
    while (isBusy(state) && Date.now() < deadline) await delay(100);
    if (isActive(state)) throw Error('終端尚未停止，請稍後重試。');
  }
  async function runNanTransfer(view, pingState, step, stepNumber, plan) {
    var ping = activeRun.output.get(pingState);
    var pingGeneration = ping && ping.generation;
    function requirePingReply() {
      if (!ping || pingState.status !== 'running' || !ping.buffer.hasPingReply()) throw Error('本次流程需要 DUT2 的 Ping 回覆。');
      ensureRunCurrent(pingState, pingGeneration);
    }
    requirePingReply();
    var shareButton = $('nanTransferDialog').querySelector('[data-nan-transfer="share"]');
    shareButton.disabled = !!step.duringTransfer;
    $('nanTransferLiveHint').hidden = !step.duringTransfer;
    $('nanTransferAmount').textContent = formatNanAmount(step.text);
    var choice = await new Promise(function (resolve) {
      nanTransferResolve = resolve; $('nanTransferDialog').showModal();
    });
    if (!choice) throw Error('已取消傳輸測試。');
    requirePingReply();
    activeRun.lines.push('傳輸選擇 ' + choice + ' · ' + formatNanAmount(step.text));
    if (choice === 'share') {
      var completed = await waitForUserContinue('在 DUT2 用 Quick Share 傳送 ' + formatNanAmount(step.text) + ' 的測試檔到 DUT1。請在接收端確認檔案已完整接收，再按「繼續」。', stepNumber);
      if (!completed) throw Error('未確認 Quick Share 已完成。');
      activeRun.lines.push('使用者確認 Quick Share 完成。');
      return;
    }

    var targets = plan[choice].map(function (target) {
      var state = getState(view.config.id, target.slot, target.tab.id);
      var current = getTabConfig(view.config, target.slot, target.tab.id);
      if (!state || isActive(state) || !current || current.exe !== target.tab.exe || current.args !== target.tab.args || current.shell !== target.tab.shell ||
          current.cwd !== target.tab.cwd || current.command !== target.tab.command || current.batchFile !== target.tab.batchFile)
        throw Error('傳輸分頁設定已變更或正在使用，請確認後重跑。');
      return state;
    });
    var owned = [], cleanupError = null;
    async function start(state) {
      selectFlowTarget(view, state);
      var starting = startFlowTerminal(view, state);
      var observation = activeRun.output.get(state);
      if (observation) owned.push({ state: state, observation: observation });
      await starting;
    }
    try {
      await start(targets[0]);
      await waitForFlowCondition({ action: 'output', text: 'Server listening', timeoutMs: 10000 }, targets[0]);
      requirePingReply();
      if (targets[0].status !== 'running') throw Error('Server 已停止，未啟動傳輸。');
      await start(targets[1]);
      if (step.duringTransfer) await runTrafficPause(targets[1], step.duringTransfer, stepNumber);
      await waitForFlowCondition({ action: 'exit', timeoutMs: 600000 }, targets[1]);
    } finally {
      for (var item of owned.reverse()) {
        try {
          var deadline = Date.now() + 30000;
          while (!item.observation.started && item.state.status === 'starting' && Date.now() < deadline) await delay(100);
          if (item.observation.started && item.state.generation === item.observation.firstStartedGeneration &&
              getState(item.state.workspaceId, item.state.slot, item.state.tabId) === item.state) await stopFlowTerminal(view, item.state);
        } catch (error) {
          activeRun.lines.push('停止傳輸終端失敗 · ' + error.message);
          cleanupError = Error('請手動確認 ' + choice + ' 終端已停止。');
        }
      }
    }
    if (cleanupError) throw cleanupError;
  }
  async function runTrafficPause(state, instruction, stepNumber) {
    var entry = activeRun.output.get(state);
    if (!entry) throw Error('請先啟動並觀測此格的 iperf 終端。');
    function requireRunning() {
      ensureRunCurrent(state, entry.generation);
      if (state.status !== 'running') throw Error('流量已停止。請延長測試時間或傳輸量後重跑。');
    }
    var deadline = performance.now() + 15000;
    while (!entry.buffer.intervals().length && performance.now() < deadline) {
      requireRunning(); await delay(100);
    }
    requireRunning();
    if (!entry.buffer.intervals().length) throw Error('未收到 iperf 區間輸出。請確認傳輸已開始並啟用週期報表。');
    async function waitWhileRunning(text, button) {
      var failure = null;
      var watcher = setInterval(function () {
        try { requireRunning(); }
        catch (error) { failure = error; finishFlowPause(false); }
      }, 100);
      try {
        if (!(await waitForUserContinue(text, stepNumber, button))) throw failure || Error('已停止流量中操作。');
        requireRunning();
      } finally { clearInterval(watcher); }
    }
    await waitWhileRunning('流量已開始。準備好後按「開始操作」，再執行下列步驟。\n\n' + instruction, '開始操作');
    var phase = { start: Date.now(), end: null };
    entry.trafficPhases.push(phase);
    activeRun.lines.push(new Date(phase.start).toISOString() + ' 開始操作 · 第 ' + (state.slot + 1) + ' 格');
    saveRun();
    await waitWhileRunning(instruction + '\n\n完成後按「完成操作」。', '完成操作');
    phase.end = Date.now();
    activeRun.lines.push(new Date(phase.end).toISOString() + ' 完成操作 · 第 ' + (state.slot + 1) + ' 格');
    saveRun();
  }
  function observeRun(state, command) {
    var previous = activeRun.output.get(state);
    if (previous && previous.buffer.text().trim()) appendRunOutput(state, previous);
    activeRun.output.set(state, { generation: state.generation, buffer: window.TerminalGridFlowOutput.create(), command: command, started: false, trafficPhases: [] });
  }
  function appendRunOutput(state, entry) {
    var tab = getTabConfig(getWorkspace(state.workspaceId), state.slot, state.tabId);
    var raw = entry.buffer.text(), intervals = entry.buffer.intervals();
    activeRun.lines.push('\r\n--- 第 ' + (state.slot + 1) + ' 格 / ' + (tab ? tab.name + ' / ' : '') + state.tabId + ' ---');
    var result = window.TerminalGridFlowOutput.iperfResult(raw);
    if (intervals.length || result.rate) {
      activeRun.lines.push('吞吐證據 · ' + result.status + (result.rate ? ' · ' + result.rate : ''));
      entry.trafficPhases.forEach(function (phase) {
        activeRun.lines.push('區間收到時間（UTC） · ' + new Date(phase.start).toISOString() + ' 至 ' + (phase.end ? new Date(phase.end).toISOString() : '未完成'));
        [['操作前', intervals.filter(function (r) { return r.at < phase.start; })],
          ['操作中', intervals.filter(function (r) { return r.at >= phase.start && (!phase.end || r.at < phase.end); })],
          ['操作後', phase.end ? intervals.filter(function (r) { return r.at >= phase.end; }) : []]].forEach(function (group) {
          var windowed = group[1].slice(-40);
          activeRun.lines.push(group[0] + ' · ' + (windowed.length ? windowed.map(function (r) {
            return r.start + '–' + r.end + 's [' + r.stream + '] ' + r.rate;
          }).join(' | ') : '無樣本'));
        });
      });
    }
    activeRun.lines.push(raw.slice(-16000));
  }
  function saveRun() {
    var run = activeRun;
    send({ type: 'runSave', runId: run.id, text: run.lines.join('\r\n').slice(0, 1500000) + '\r\n' });
  }
  function ensureRunCurrent(state, generation) {
    if (activeRun.cancelled) throw Error('已停止流程。');
    if (activeRun.captureError) throw Error(activeRun.captureError);
    if (state && (generation !== state.generation || getState(state.workspaceId, state.slot, state.tabId) !== state))
      throw Error('目標終端已重新啟動或關閉。');
  }
  async function waitForFlowCondition(step, state) {
    var observation = activeRun.output.get(state);
    if (!observation) throw Error('請先加入此終端的「啟動」或「輸入指令」步驟。');
    var timeout = limitNumber(step.timeoutMs || 10000, 10000, 100, 600000);
    var generation = observation.generation;
    for (var attempt = 0; attempt <= (step.retries || 0); attempt++) {
      var deadline = performance.now() + timeout;
      do {
        ensureRunCurrent(state, generation);
        if (step.action === 'output' && observation.buffer.match(step.failureText, observation.command))
          throw Error('收到失敗文字「' + step.failureText + '」。');
        if (step.action === 'output') {
          var matches = state.tabId === 'nan-ping' && step.text === 'bytes from' ? observation.buffer.hasPingReply() : observation.buffer.match(step.text, observation.command);
          if (matches) return;
        }
        if (state.status === 'exited') {
          if (step.action === 'exit' && state.exitCode === 0) {
            if (state.tabId === 'nan-python-probe' && !observation.buffer.hasLine('NAN_PING_OK')) throw Error('Python 驗證未取得成功回覆。');
            return;
          }
          throw Error('終端已結束（代碼 ' + state.exitCode + '）。');
        }
        if (state.status === 'error') throw Error('終端發生錯誤。');
        await delay(75);
      } while (performance.now() < deadline);
      activeRun.lines.push(new Date().toISOString() + ' 等待逾時，第 ' + (attempt + 1) + ' 次');
    }
    throw Error('等待' + (step.action === 'exit' ? '終端正常結束' : '輸出「' + step.text + '」') + '逾時。');
  }
  async function runFlow(testCase, logChecks) {
    var flow = currentFlow(); if (!flow || flowRunning || flowPreparing) return;
    flow = JSON.parse(JSON.stringify(flow));
    var workspace = flowWorkspace(flow);
    flowPreparing = true;
    var shared = Object.create(null);
    var transferPlans = new Map();
    try {
      for (var p = 0; p < flow.steps.length; p++) {
        var planned = flow.steps[p], tab = workspace.slots[planned.slot].tabs.find(function (t) { return t.id === planned.tabId; });
        if (planned.action === 'start' && tab && window.TerminalGridDefaults.keys(window.TerminalGridDefaults.prepare(tab.command)).length) { showToast('請先在終端設定填妥啟動指令參數；範本請放在流程「輸入指令」步驟。', true); return; }
        if (planned.action === 'output' && !planned.text.trim()) { showToast('第 ' + (p + 1) + ' 步請填入成功文字。', true); return; }
        if (planned.action === 'nanTransfer') transferPlans.set(p, nanTransferPlan(JSON.parse(JSON.stringify(workspace)), planned));
        if (planned.action !== 'send') continue;
        planned.text = window.TerminalGridDefaults.prepare(planned.text);
        var keys = window.TerminalGridDefaults.keys(planned.text);
        if (!keys.length) continue;
        var targetState = getState(flow.workspaceId, planned.slot, planned.tabId);
        if (!targetState) return;
        var resolved = keys.every(function (key) { return shared[key]; })
          ? window.TerminalGridDefaults.resolve(planned.text, shared, targetState.status === 'running' ? targetState.sessionShell : (tab || getTabConfig(workspace, planned.slot, targetState.tabId)).shell)
          : await new Promise(function (resolve) { openPathCommand(targetState, planned.text, resolve, shared); });
        if (resolved === null) return;
        planned.text = resolved;
      }
    } catch (error) { showToast(error.message, true); return; }
    finally { flowPreparing = false; }
    var summaryLines = flow.steps.map(function (step, i) {
      var tab = workspace.slots[step.slot].tabs.find(function (t) { return t.id === step.tabId; }) || workspace.slots[step.slot].tabs[0];
      var verb = step.action === 'send' ? ((step.text || '（空指令）') + (step.enter ? '  ↵' : '')) : step.action === 'wait' ? '等待 ' + step.delayMs + ' ms' : step.action === 'pause' ? '等待使用者：' + (step.text || '完成操作後按繼續') : step.action === 'start' ? ('啟動 ' + tab.shell + (tab.exe ? ' · ' + tab.exe + ' ' + tab.args : '') + (tab.cwd ? ' · 目錄 ' + tab.cwd : '') + (tab.command ? '\n啟動指令：' + tab.command : '')) : '結束終端';
      if (step.action === 'start' && tab.batchFile) verb = '啟動 CMD · BAT 原檔：' + tab.batchFile + '\n（啟動不會等待 BAT 完成）';
      if (step.action === 'output') verb = '等待輸出「' + step.text + '」' + (step.failureText ? '，遇到「' + step.failureText + '」停止' : '');
      if (step.action === 'exit') verb = '等待終端以代碼 0 結束';
      if (step.action === 'trafficPause') verb = '流量中操作：' + step.text;
      if (step.action === 'nanTransfer') {
        var transferPlan = transferPlans.get(i);
        verb = '收到 Ping 回覆後選擇傳輸 ' + formatNanAmount(step.text) + '。Quick Share 由使用者操作。';
        if (step.duringTransfer) verb = '收到 Ping 回覆後選擇 iperf 傳輸 ' + formatNanAmount(step.text) + '。\n流量中操作：' + step.duringTransfer;
        ['iperf3', 'iperf'].forEach(function (tool) {
          transferPlan[tool].forEach(function (target) { verb += '\n' + target.tab.name + ' · ' + target.tab.exe + ' ' + target.tab.args; });
        });
      }
      return step.action === 'pause' || step.action === 'wait' ? (i + 1) + '. ' + verb : (i + 1) + '. ' + String(step.slot + 1).padStart(2, '0') + ' 格 / ' + tab.name + ' · ' + verb;
    });
    var caseNotes = testCase && testCase.notes ? '測項說明\n' + testCase.notes + '\n\n' : '';
    if (!(await askConfirmation('執行「' + (testCase ? testCase.code + ' · ' + testCase.title : flow.name) + '」？', caseNotes + '以下步驟會依序送到本機終端：\n\n' + summaryLines.join('\n') + '\n\n請確認目標與指令正確。', '確認執行'))) return;
    if (testCase) {
      flowPreparing = true;
      var usbError;
      try { usbError = await verifyCaseUsb(testCase, false); }
      finally { flowPreparing = false; }
      if (usbError) {
        if (!$('testCaseDialog').open) $('testCaseDialog').showModal();
        editTestCase(testCase.id);
        $('testCaseStatus').textContent = '執行前重新檢查 · ' + usbError;
        return false;
      }
    }
    $('flowDialog').close();
    flowRunning = true; failedFlowStep = null;
    activeRun = { id: uid('run'), output: new Map(), lines: ['開始 ' + new Date().toISOString(), '流程 ' + flow.name, '工作區 ' + workspace.name],
      cancelled: false, capture: testCase ? $('testCaseRecordOutput').checked : $('recordFlowOutput').checked,
      captureFolder: flowRecordingFolder, recorded: new Map() };
    if (testCase) activeRun.lines.push('測項 ' + testCase.code);
    $('flowLogPath').textContent = ''; $('flowProgress').textContent = '執行中';
    saveRun(); renderFlowEditor();
    var i = 0, completed = false;
    try {
      if (logChecks) {
        activeRun.lines.push(new Date().toISOString() + ' 等待手機 Log 準備');
        saveRun();
        if (!(await waitForUserContinue('請先保留仍需要的舊 Log。若測項要求清理，請在測試手機的 Log 工具中手動清理並開始錄製，再按「繼續」。', '前置'))) throw Error('未完成手機 Log 準備。');
        activeRun.lines.push(new Date().toISOString() + ' 已確認手機 Log 準備');
        var deviceError = await verifyCaseUsb(testCase, false);
        if (deviceError) throw Error(deviceError);
      }
      for (; i < flow.steps.length; i++) {
        ensureRunCurrent();
        var step = flow.steps[i];
        var progress = '第 ' + (i + 1) + ' / ' + flow.steps.length + ' 步';
        $('flowProgress').textContent = progress;
        setStatus(flow.name + ' · ' + progress);
        activeRun.lines.push(new Date().toISOString() + ' ' + summaryLines[i]);
        saveRun();
        if (step.action === 'wait') { await flowDelay(step.delayMs); continue; }
        if (step.action === 'pause') {
          if (!(await waitForUserContinue(step.text, i + 1))) throw new Error('已停止後續自動化步驟。');
          continue;
        }
        var view = getView(flow.workspaceId), state = getState(flow.workspaceId, step.slot, step.tabId);
        if (!view || !state) throw new Error('第 ' + (i + 1) + ' 步找不到目標終端。');
        selectFlowTarget(view, state);
        if (step.action === 'start') {
          await startFlowTerminal(view, state);
        } else if (step.action === 'send') {
          if (state.status !== 'running') throw new Error('第 ' + (i + 1) + ' 步目標尚未執行；請先加入「啟動終端」步驟。');
          await recordFlowPane(state);
          observeRun(state, step.text);
          if (step.text && !send(withGeneration(state, { type: 'input', data: step.text + (step.enter ? '\r' : '') }))) throw Error('無法送出指令。');
        } else if (step.action === 'output' || step.action === 'exit') {
          await waitForFlowCondition(step, state);
        } else if (step.action === 'nanTransfer') {
          await runNanTransfer(view, state, step, i + 1, transferPlans.get(i));
        } else if (step.action === 'trafficPause') {
          await runTrafficPause(state, step.text, i + 1);
        } else if (step.action === 'stop') {
          await stopFlowTerminal(view, state);
        }
        if (step.delayMs > 0) await flowDelay(step.delayMs);
      }
      ensureRunCurrent();
      if (logChecks) {
        activeRun.lines.push(new Date().toISOString() + ' 等待手機 Log 收證');
        saveRun();
        if (!(await waitForUserContinue('請停止本輪手機錄製，將本題 Log 存到測試資料夾，再按「繼續」。', '收證'))) throw Error('未確認手機 Log 已收證。');
        activeRun.lines.push(new Date().toISOString() + ' 已確認手機 Log 收證');
      }
      ensureRunCurrent();
      $('flowProgress').textContent = '流程完成';
      completed = true;
      showToast('流程「' + flow.name + '」已完成。');
    } catch (error) {
      failedFlowStep = { flowId: flow.id, index: i };
      $('flowProgress').textContent = '第 ' + (i + 1) + ' 步 · ' + error.message;
      showToast($('flowProgress').textContent, true);
    } finally {
      for (var recorded of activeRun.recorded) {
        var recordedPane = recorded[0];
        if (!recordedPane.recording || recordedPane.generation !== recorded[1]) continue;
        try { await setFlowRecording(recordedPane, false); }
        catch (error) { completed = false; $('flowProgress').textContent = error.message; showToast(error.message, true); }
      }
      activeRun.lines.push('結束 ' + new Date().toISOString(), '結果 ' + $('flowProgress').textContent);
      activeRun.output.forEach(function (entry, state) { appendRunOutput(state, entry); });
      saveRun(); lastRun = activeRun; activeRun = null;
      flowRunning = false; renderFlowEditor(); updateCounts();
      var failed = $('flowSteps').querySelector('.flow-failed'); if (failed) failed.scrollIntoView({ block: 'nearest' });
    }
    return completed;
  }
  async function flowDelay(ms) {
    var deadline = performance.now() + ms;
    while (performance.now() < deadline) { ensureRunCurrent(); await delay(Math.min(100, deadline - performance.now())); }
  }
  function deleteFlow() {
    var flow = currentFlow(); if (!flow) return;
    appConfig.automations = appConfig.automations.filter(function (f) { return f !== flow; }); currentFlowId = null;
    renderFlowOptions(); queueSave();
  }
  function renderCommandLibrary(packId) {
    completionCatalog = null;
    if (!$('commandPackSelect')) return;
    var select = $('commandPackSelect'), previous = typeof packId === 'string' ? packId : select.value; select.textContent = '';
    allCommandPacks().forEach(function (pack) { select.add(new Option(pack.name, pack.id)); });
    if (!appConfig.commandPacks.length) select.add(new Option('（無指令包）', ''));
    if (allCommandPacks().some(function (p) { return p.id === previous; })) select.value = previous;
    var pack = allCommandPacks().find(function (p) { return p.id === select.value; });
    $('renamePackButton').disabled = !pack || pack.builtin; $('duplicatePackButton').disabled = !pack || appConfig.commandPacks.length >= 32;
    $('deletePackButton').disabled = !pack || pack.builtin || appConfig.commandPacks.length <= 1;
    var target = pack && !pack.builtin ? pack : quickCommandPack();
    $('addCommandButton').disabled = !target || target.commands.length >= 128;
    $('addCommandButton').title = target ? '儲存到「' + target.name + '」' : '個人指令包已滿';
    $('exportPackButton').disabled = !pack;
    var list = $('commandList'); list.textContent = '';
    if (!pack || !pack.commands.length) { list.innerHTML = '<p class="help-note">此指令包目前是空的。可新增指令或匯入 .tgridcmd。</p>'; return; }
    pack.commands.forEach(function (command) {
      var item = document.createElement('div'); item.className = 'command-item'; item.draggable = true;
      var details = document.createElement('div'); details.className = 'command-details';
      var title = document.createElement('strong'); title.textContent = command.name;
      var desc = document.createElement('span'); desc.textContent = (command.literal ? '文字片段' + (command.description ? ' · ' + command.description : '') : command.description || command.command);
      var code = document.createElement('code'); code.textContent = command.command;
      details.append(title, desc, code);
      var insert = document.createElement('button'); insert.type = 'button'; insert.className = 'button'; insert.textContent = '插入';
      insert.addEventListener('click', function () { if (focused) insertSnippet(focused.state, command); else showToast('請先選取一個終端分頁。'); });
      var edit = document.createElement('button'); edit.type = 'button'; edit.className = 'icon-button'; edit.textContent = '⋯'; edit.title = '編輯／刪除';
      edit.hidden = !!pack.builtin;
      edit.addEventListener('click', function () { openCommandEditor(pack, command); });
      var pin = document.createElement('button'); pin.type = 'button'; pin.className = 'icon-button command-pin';
      pin.hidden = !!pack.builtin; pin.textContent = command.pinned ? '★' : '☆';
      pin.title = command.pinned ? '取消釘選' : '釘選至終端選單頂端';
      pin.setAttribute('aria-label', pin.title + ' · ' + command.name);
      pin.setAttribute('aria-pressed', String(!!command.pinned));
      pin.addEventListener('click', function () {
        command.pinned = !command.pinned; renderCommandLibrary(pack.id); queueSave();
      });
      item.append(details, insert, pin, edit);
      item.addEventListener('dragstart', function (event) { event.dataTransfer.setData(command.literal ? literalDragType : commandDragType, command.command); event.dataTransfer.setData('text/plain', command.command); event.dataTransfer.effectAllowed = 'copy'; });
      list.appendChild(item);
    });
  }
  function selectedCommandPack() { return allCommandPacks().find(function (p) { return p.id === $('commandPackSelect').value; }) || null; }
  function quickCommandPack() {
    var packs = appConfig.commandPacks;
    var personal = packs.find(function (pack) { return pack.id === personalPackId && pack.commands.length < 128; });
    if (personal) return personal;
    if (packs.length < 32 && !packs.some(function (pack) { return pack.id === personalPackId; })) {
      return { id: personalPackId, name: '我的常用', commands: [] };
    }
    return packs.find(function (pack) { return pack.commands.length < 128; }) || null;
  }
  function insertSnippet(state, snippet) {
    if (snippet.literal && (!snippet.command.trim() || !validLineText(snippet.command))) {
      showToast('文字片段必須是單行文字。', true); return;
    }
    insertCommand(state, snippet.command, false, snippet.literal);
  }
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
      return { id: uid('cmd'), name: command.name, description: command.description, command: command.command, literal: !!command.literal, pinned: !!command.pinned };
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
  function openCommandEditor(pack, command, literalValue) {
    commandEditingRef = { pack: pack, commandId: command ? command.id : null };
    $('commandEditTitle').textContent = command ? '編輯常用項目' : '新增常用項目';
    $('commandEditDestination').textContent = '儲存到「' + pack.name + '」';
    $('commandItemType').value = (command && command.literal || literalValue) ? 'literal' : 'command';
    $('commandNameInput').value = command ? command.name : (literalValue || '').slice(0, 80);
    $('commandDescriptionInput').value = command ? command.description : '';
    $('commandTextInput').value = command ? command.command : literalValue || '';
    $('deleteCommandButton').hidden = !command;
    $('commandEditDialog').showModal(); $('commandNameInput').focus();
  }
  function saveCommandEditor(event) {
    event.preventDefault(); var ref = commandEditingRef; if (!ref) return;
    var pack = appConfig.commandPacks.find(function (item) { return item.id === ref.pack.id; });
    var name = $('commandNameInput').value.trim(), value = $('commandTextInput').value, literal = $('commandItemType').value === 'literal';
    if (!name || !value.trim()) { (name ? $('commandTextInput') : $('commandNameInput')).focus(); return; }
    if (literal && !validLineText(value)) { showToast('文字片段必須是單行文字。', true); $('commandTextInput').focus(); return; }
    if (!pack) {
      if (ref.commandId || ref.pack.id !== personalPackId || appConfig.commandPacks.length >= 32) {
        showToast('指令包已變更，請重新選擇儲存位置。', true); $('commandEditDialog').close(); return;
      }
      pack = ref.pack; appConfig.commandPacks.push(pack);
    }
    var fields = { name: name.slice(0, 80), description: $('commandDescriptionInput').value.slice(0, 240), command: value.slice(0, 16000), literal: literal };
    var command = ref.commandId ? pack.commands.find(function (item) { return item.id === ref.commandId; }) : null;
    if (command) Object.assign(command, fields);
    else {
      if (pack.commands.length >= 128) { $('commandEditDialog').close(); showToast('每個指令包最多 128 個項目。', true); return; }
      pack.commands.push(Object.assign({ id: uid('cmd') }, fields));
    }
    $('commandEditDialog').close(); renderCommandLibrary(pack.id); queueSave();
    showToast('已儲存到「' + pack.name + '」。');
  }
  function deleteCommandSnippet() {
    var ref = commandEditingRef, pack = ref && appConfig.commandPacks.find(function (item) { return item.id === ref.pack.id; });
    var command = pack && pack.commands.find(function (item) { return item.id === ref.commandId; }); if (!command) return;
    askConfirmation('刪除常用指令？', '將刪除「' + command.name + '」。', '刪除指令').then(function (accepted) {
      if (!accepted) return;
      pack.commands = pack.commands.filter(function (item) { return item !== command; });
      $('commandEditDialog').close(); renderCommandLibrary(); queueSave();
    });
  }
  function addCommand(literalValue) {
    var selected = literalValue ? null : selectedCommandPack();
    var pack = selected && !selected.builtin ? selected : quickCommandPack();
    if (!pack || pack.commands.length >= 128) { showToast('儲存位置已滿，請選擇其他個人指令包。', true); return; }
    openCommandEditor(pack, null, literalValue);
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
          return { id: uid('cmd'), name: str(c.name, 80).trim() || '常用指令', description: str(c.description, 240), command: str(c.command, 16000), literal: c.literal === true, pinned: c.pinned === true };
        }) };
      appConfig.commandPacks.push(pack); renderCommandLibrary(pack.id); queueSave();
      showToast('指令包已匯入；指令只會在選取終端並按插入時填入文字。');
    } catch (error) { showToast('匯入指令包失敗：' + error.message, true); }
  }
  function stateAddress(state) { return { workspaceId: state.workspaceId, slot: state.slot, tabId: state.tabId }; }
  function canTransfer() {
    if (!hostReady || transferPending || flowRunning || flowPreparing || pendingFolderRequest || Object.keys(batchRequests).length || document.querySelector('dialog[open]')) {
      showToast('請先完成目前流程、對話框或移動操作。', true); return false;
    }
    return true;
  }
  function clearPaneSelection() {
    selectedPanes.clear();
    document.querySelectorAll('.pane.batch-selected').forEach(function (element) { element.classList.remove('batch-selected'); });
  }
  function applyTransfer(plan) {
    var moving = plan.moves.map(function (m) { return { state: getState(m.from.workspaceId, m.from.slot, m.from.tabId), move: m }; });
    // Capture references before changing any address (a swap can have equal tab IDs).
    var captures = capturedValues.map(function (item) { return { item: item, move: plan.moves.find(function (m) { return item.workspaceId === m.from.workspaceId && item.slot === m.from.slot && item.tabId === m.from.tabId; }) }; });
    moving.forEach(function (entry) { var s = entry.state, c = getView(s.workspaceId).panes[s.slot]; c.tabs = c.tabs.filter(function (t) { return t !== s; }); });
    appConfig = plan.config;
    views.forEach(function (view) { view.config = getWorkspace(view.config.id); view.panes.forEach(function (cell, i) { cell.config = view.config.slots[i]; }); });
    moving.forEach(function (entry) {
      var state = entry.state, to = entry.move.to, cell = getView(to.workspaceId).panes[to.slot];
      state.workspaceId = to.workspaceId; state.slot = to.slot; state.tabId = to.tabId;
      cell.tabs.push(state); cell.container.appendChild(state.layer);
      state.liveReplace.invalidate(); state.liveIntent = false; state.terminal.clearSelection(); updateLiveSelection(state);
      state.terminal.textarea.setAttribute('aria-label', '第 ' + (state.slot + 1) + ' 格 ' + getTabConfig(getWorkspace(state.workspaceId), state.slot, state.tabId).name + ' 可操作終端');
    });
    captures.forEach(function (entry) {
      if (!entry.move) return; var item = entry.item, to = entry.move.to, workspace = getWorkspace(to.workspaceId);
      item.workspaceId = to.workspaceId; item.slot = to.slot; item.tabId = to.tabId;
      item.key = [to.workspaceId, to.slot, to.tabId, item.interfaceName, item.address.toLowerCase()].join('|');
      item.source = workspace.name + ' · ' + String(to.slot + 1).padStart(2, '0') + ' · ' + getTabConfig(workspace, to.slot, to.tabId).name;
    });
    views.forEach(function (view) { view.panes.forEach(function (cell, i) {
      cell.tabs = cell.tabs.filter(function (state) {
        if (cell.config.tabs.some(function (t) { return t.id === state.tabId; })) return true;
        pruneCaptures(state); disposeTerminal(state); state.layer.remove(); return false;
      });
      cell.config.tabs.forEach(function (t) { if (!getState(view.config.id, i, t.id)) makeTerminal(view, i, t); });
      renderPane(view, i);
    }); });
    var dest = plan.destination, view = getView(dest.workspaceId); view.zoomedSlot = null;
    activateWorkspace(dest.workspaceId); markFocused(view, dest.slot, dest.tabId);
    if (paneClipboard && paneClipboard.mode === 'move') paneClipboard = null;
    queueCaptureRender(); renderFlowOptions(); scheduleFit();
  }
  function rememberPaneAction(label, before, after, moves, destination, addresses) {
    var keys = new Set(), cells = [];
    addresses.forEach(function (address) {
      var key = address.workspaceId + ':' + address.slot;
      if (keys.has(key)) return;
      keys.add(key);
      var oldCell = before.workspaces.find(function (w) { return w.id === address.workspaceId; }).slots[address.slot];
      var newCell = after.workspaces.find(function (w) { return w.id === address.workspaceId; }).slots[address.slot];
      cells.push({ address: address, before: oldCell, after: JSON.stringify(newCell.tabs) });
    });
    var flows = before.automations.filter(function (flow) {
      return JSON.stringify(flow) !== JSON.stringify(after.automations.find(function (item) { return item.id === flow.id; }));
    }).map(function (flow) {
      return { before: flow, after: JSON.stringify(after.automations.find(function (item) { return item.id === flow.id; })) };
    });
    paneHistory.push({ label: label, time: new Date().toLocaleTimeString(), cells: cells, flows: flows, moves: moves,
      destination: destination, clipboard: paneClipboard });
    if (paneHistory.length > 20) paneHistory.shift();
  }
  function finishTransfer(plan, history, undo) {
    if (history) rememberPaneAction(history.label, appConfig, plan.config, plan.moves, history.source, history.addresses);
    applyTransfer(plan);
    clearPaneSelection();
    if (undo) { paneHistory.pop(); paneClipboard = undo.clipboard; }
    saveConfig(false);
    showToast(undo ? '已復原：' + undo.label : (plan.moves.length ? '已移動，程序及輸出保留。' : '已複製分頁設定。'));
  }
  function submitTransfer(plan, history, undo) {
    if (plan.moves.some(function (m) { var s = getState(m.from.workspaceId, m.from.slot, m.from.tabId); return !s || isBusy(s); }))
      throw Error('請等終端啟動或停止完成再移動。');
    if (!plan.moves.length) { finishTransfer(plan, history, undo); return; }
    window.clearTimeout(saveTimer);
    transferPending = { id: uid('move'), plan: plan, history: history, undo: undo };
    document.body.classList.add('transfer-pending');
    if (!send({ type: 'relocate', requestId: transferPending.id, config: plan.config, moves: plan.moves })) {
      transferPending = null; document.body.classList.remove('transfer-pending');
    }
  }
  function undoPaneAction() {
    if (!canTransfer() || !paneHistory.length) { if (!paneHistory.length) showToast('目前沒有可復原的格子操作。'); return; }
    var entry = paneHistory[paneHistory.length - 1];
    if (!entry.cells.length) {
      paneClipboard = entry.clipboard; paneHistory.pop(); showToast('已復原：' + entry.label); return;
    }
    try {
      var config = JSON.parse(JSON.stringify(appConfig));
      var reverse = entry.moves.map(function (move) { return { from: move.to, to: move.from }; });
      entry.cells.forEach(function (change) {
        var a = change.address, workspace = config.workspaces.find(function (w) { return w.id === a.workspaceId; });
        if (!workspace || JSON.stringify(workspace.slots[a.slot].tabs) !== change.after) throw Error('格子設定已有變更，無法安全復原。');
        var previous = JSON.parse(JSON.stringify(change.before));
        var view = getView(a.workspaceId);
        view.panes[a.slot].tabs.forEach(function (state) {
          if (!previous.tabs.some(function (tab) { return tab.id === state.tabId; }) &&
              !reverse.some(function (m) { return m.from.workspaceId === a.workspaceId && m.from.slot === a.slot && m.from.tabId === state.tabId; }) &&
              isActive(state)) throw Error('請先結束復原時會移除的終端。');
        });
        workspace.slots[a.slot] = previous;
      });
      entry.flows.forEach(function (change) {
        var index = config.automations.findIndex(function (flow) { return flow.id === change.before.id; });
        if (JSON.stringify(config.automations[index]) !== change.after) throw Error('相關流程已有變更，無法安全復原。');
        config.automations[index] = change.before;
      });
      var destination = Object.assign({}, entry.destination);
      submitTransfer({ config: config, moves: reverse, destination: destination }, null, entry);
    } catch (error) { showToast(error.message, true); }
  }
  function transferPane(source, target, mode) {
    transferPaneGroup([source], target, mode);
  }
  function transferPaneGroup(sources, target, mode) {
    if (!canTransfer()) return;
    try {
      var config = appConfig, moves = [], destination;
      sources.forEach(function (source) {
        var planned = window.TerminalGridTransfer.plan(config, source, target, mode, function () { return uid('tab'); });
        config = planned.config; moves.push.apply(moves, planned.moves); destination = planned.destination;
      });
      submitTransfer({ config: config, moves: moves, destination: destination }, {
        label: mode === 'copy' ? '貼上分頁設定' : mode === 'swap' ? '交換格子' : '移動分頁',
        source: sources[0], addresses: sources.concat([target])
      }, null);
    } catch (error) { showToast(error.message, true); }
  }
  function chooseTransferTarget(state, mode) {
    if (!canTransfer()) return;
    var source = stateAddress(state), dialog = document.createElement('dialog'); dialog.className = 'modal transfer-dialog';
    dialog.innerHTML = '<form method="dialog"><div class="modal-heading"><h2></h2></div><div class="modal-content"><p>選擇工作區及格子，加入為新分頁。移動保留程序與輸出；複製使用設定中的啟動資料夾，不會執行。</p><label class="field">工作區<select class="transfer-workspace"></select></label><label class="field">格子<select class="transfer-slot"></select></label></div><div class="modal-actions"><button class="button" value="cancel">取消</button><button class="button primary" value="apply">確定</button></div></form>';
    dialog.querySelector('h2').textContent = mode === 'copy' ? '複製終端設定到…' : '移動終端到…';
    var workspace = dialog.querySelector('.transfer-workspace'), slot = dialog.querySelector('.transfer-slot');
    appConfig.workspaces.forEach(function (w) { workspace.add(new Option(w.name, w.id)); }); workspace.value = state.workspaceId;
    function refresh() { var w = getWorkspace(workspace.value); slot.textContent = ''; for (var i = 0; i < w.rows * w.cols; i++) slot.add(new Option(String(i + 1).padStart(2, '0') + ' · ' + w.slots[i].tabs.length + '/8 頁', i)); }
    workspace.addEventListener('change', refresh); refresh();
    dialog.addEventListener('close', function () { var apply = dialog.returnValue === 'apply', target = { workspaceId: workspace.value, slot: Number(slot.value) }; dialog.remove(); if (apply) transferPane(source, target, mode); });
    document.body.appendChild(dialog); dialog.showModal(); workspace.focus();
  }
  function addPaneMenuActions(add, state) {
    add('複製此分頁設定', function () { paneClipboard = { mode: 'copy', source: stateAddress(state) }; showToast('已複製來源；到目標格標題按右鍵貼上設定。'); });
    add('剪下此分頁（貼上後移動）', function () { rememberPaneAction('剪下分頁', appConfig, appConfig, [], stateAddress(state), []); paneClipboard = { mode: 'move', source: stateAddress(state) }; showToast('已標記來源；到目標格標題按右鍵貼上。'); });
    if (selectedPanes.size) {
      add('複製所選格的有效分頁（' + selectedPanes.size + '）', function () { paneClipboard = { mode: 'copy', sources: Array.from(selectedPanes.values()) }; showToast('到目標格右鍵貼上選取的分頁。'); });
      add('剪下所選格的有效分頁（' + selectedPanes.size + '）', function () {
        rememberPaneAction('剪下多個分頁', appConfig, appConfig, [], stateAddress(state), []);
        paneClipboard = { mode: 'move', sources: Array.from(selectedPanes.values()) }; showToast('到目標格右鍵移動選取的分頁。');
      });
    }
    if (paneClipboard) add(paneClipboard.mode === 'copy' ? '在此格貼上分頁設定' : '將剪下的分頁移到此格', function () {
      transferPaneGroup(paneClipboard.sources || [paneClipboard.source], stateAddress(state), paneClipboard.mode);
    });
    if (paneHistory.length) add('復原上一次格子操作', undoPaneAction);
    add('複製設定到工作區／格子…', function () { chooseTransferTarget(state, 'copy'); });
    add('移動到工作區／格子…', function () { chooseTransferTarget(state, 'move'); });
    add('關閉並移除此分頁…', function () { removeTerminalTab(getView(state.workspaceId), state.slot, state.tabId); });
  }
  function showPaneMenu(event, state) {
    event.preventDefault(); event.stopPropagation();
    markFocused(getView(state.workspaceId), state.slot, state.tabId);
    var menu = $('terminalContextMenu'); menu.textContent = ''; menu.className = 'terminal-context-menu';
    function add(label, action) { var b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.addEventListener('click', function (e) { e.stopPropagation(); menu.hidden = true; action(); }); menu.appendChild(b); }
    addPaneMenuActions(add, state);
    add('終端設定…', function () { openSettings(getView(state.workspaceId), state.slot, state.tabId); });
    positionContextMenu(menu, event.clientX, event.clientY); menu.firstChild.focus();
  }
  function installPaneTransfer(view, slot) {
    var element = view.panes[slot].element, title = element.querySelector('.pane-title-row');
    title.draggable = true; title.title = '拖曳標題交換整格；拖曳分頁移動單一終端；右鍵管理';
    title.addEventListener('click', function (event) {
      if (event.target.closest('button')) return;
      title.focus();
      var current = activeState(view, slot); markFocused(view, slot, current.tabId);
      if (!event.ctrlKey) return;
      event.preventDefault();
      var key = view.config.id + ':' + slot;
      if (selectedPanes.has(key)) selectedPanes.delete(key);
      else selectedPanes.set(key, stateAddress(activeState(view, slot)));
      element.classList.toggle('batch-selected', selectedPanes.has(key));
    });
    title.tabIndex = 0;
    element.querySelector('.pane-header').addEventListener('contextmenu', function (event) {
      var tab = event.target.closest('[data-tab-id]'); showPaneMenu(event, tab ? getState(view.config.id, slot, tab.dataset.tabId) : activeState(view, slot));
    });
    element.addEventListener('dragstart', function (event) {
      var tab = event.target.closest('[data-tab-id]');
      if (!tab && event.target !== title) return;
      if (!canTransfer()) { event.preventDefault(); return; }
      var state = tab ? getState(view.config.id, slot, tab.dataset.tabId) : activeState(view, slot);
      paneDrag = { source: stateAddress(state), mode: tab ? 'move' : 'swap' };
      event.dataTransfer.setData(paneDragType, 'internal'); event.dataTransfer.effectAllowed = 'move'; element.classList.add('pane-dragging');
    });
    element.addEventListener('dragover', function (event) { if (!paneDrag || !hasDataType(event.dataTransfer, paneDragType)) return; event.preventDefault(); event.dataTransfer.dropEffect = 'move'; element.classList.add('pane-drop-target'); });
    element.addEventListener('dragleave', function (event) { if (!element.contains(event.relatedTarget)) element.classList.remove('pane-drop-target'); });
    element.addEventListener('drop', function (event) {
      if (!paneDrag || !hasDataType(event.dataTransfer, paneDragType)) return;
      event.preventDefault(); event.stopImmediatePropagation(); var drag = paneDrag; clearPaneDrag();
      transferPane(drag.source, { workspaceId: view.config.id, slot: slot }, drag.mode);
    }, true);
  }
  function clearPaneDrag() { paneDrag = null; document.querySelectorAll('.pane-dragging,.pane-drop-target').forEach(function (e) { e.classList.remove('pane-dragging', 'pane-drop-target'); }); }
  document.addEventListener('dragend', clearPaneDrag);
  ['keydown', 'paste', 'click', 'contextmenu', 'drop'].forEach(function (name) { document.addEventListener(name, function (event) { if (transferPending) { event.preventDefault(); event.stopImmediatePropagation(); } }, true); });
  function showTerminalMenu(x, y, state) {
    var menu = $('terminalContextMenu'); menu.textContent = ''; menu.className = 'terminal-context-menu';
    function add(label, action) { var button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.addEventListener('click', function (event) { event.stopPropagation(); menu.hidden = true; action(); }); menu.appendChild(button); return button; }
    var packs = appConfig.commandPacks.slice().sort(function (a, b) { return Number(b.id === personalPackId) - Number(a.id === personalPackId); });
    var snippets = packs.flatMap(function (pack) { return pack.commands; });
    snippets.filter(function (command) { return command.pinned; }).slice(0, 15).forEach(function (command) {
      add('★ 插入：' + command.name, function () { insertSnippet(state, command); });
    });
    var selectedText = state.terminal.getSelection();
    add('複製選取文字', function () { copySelection(state); });
    add('原位替換選取文字…', function () { showLiveReplaceMenu(state, x, y); });
    add('貼上剪貼簿', function () { pasteClipboard(state); });
    add('暫存選取文字', function () { saveCaptureText(state.terminal.getSelection(), state); });
    var saveSelection = add('存到我的常用…', function () {
      if (!selectedText.trim() || !validLineText(selectedText)) { showToast('請框選單行文字，最多 16,000 字元。', true); return; }
      addCommand(selectedText);
    });
    saveSelection.disabled = !selectedText.trim();
    add('編輯選取指令', function () { openCommandDraft(state); });
    add('帶到本格輸入列編輯', function () { editTerminalSelection(state); });
    add('開啟資料暫存區…', function () { setCapturePanel(true); });
    if (!isActive(state)) add('啟動終端', function () { startSlot(getView(state.workspaceId), state.slot, state.tabId, false); });
    add('選擇啟動資料夾…', function () { choosePaneFolder(getView(state.workspaceId), state.slot, state.tabId); });
    add('選檔執行 BAT／CMD…', function () { requestBatch(getView(state.workspaceId), state.slot); });
    add('終端設定…', function () { openSettings(getView(state.workspaceId), state.slot, state.tabId); });
    addPaneMenuActions(add, state);
    add('快速截圖＋Log（F8）', function () { captureEvidence(state); });
    add('檢視／匯出終端 Log…', function () { openTerminalLog(state); });
    var separator = document.createElement('div'); separator.className = 'context-separator'; menu.appendChild(separator);
    add('開啟指令庫…', function () { renderCommandLibrary(); $('commandDialog').showModal(); });
    window.TerminalGridDefaults.packs.forEach(function (pack) { add(pack.name + '…', function () { renderCommandLibrary(); $('commandPackSelect').value = pack.id; renderCommandLibrary(); $('commandDialog').showModal(); }); });
    snippets.filter(function (command) { return !command.pinned; }).slice(0, 15).forEach(function (command) {
      add('插入：' + command.name, function () { insertSnippet(state, command); });
    });
    positionContextMenu(menu, x, y);
    menu.querySelector('button').focus();
  }
  function importDroppedFiles(files) {
    var queue = Array.prototype.slice.call(files || []);
    function next() { if (queue.length) importDroppedFile(queue.shift(), next); }
    next();
  }
  function batchTarget(element) {
    var pane = element && element.closest && element.closest('.pane'), grid = pane && pane.closest('[data-workspace-id]');
    if (grid) return { view: getView(grid.dataset.workspaceId), slot: Number(pane.dataset.slot) };
    if (focused && focused.view === activeView && focused.slot < activeView.config.rows * activeView.config.cols) return { view: activeView, slot: focused.slot };
    return { view: activeView, slot: 0 };
  }
  function requestBatch(view, slot, files) {
    if (!hostReady || !view) { showToast('請等終端引擎就緒後重試。', true); return; }
    var capacity = MAX_TABS - view.panes[slot].config.tabs.length;
    if (capacity < 1 || files && files.length > capacity) { showToast('此格最多 8 個分頁，目前剩 ' + capacity + ' 個位置；請先移除分頁或選另一格。', true); return; }
    var id = uid('batch'); batchRequests[id] = { view: view, slot: slot };
    try {
      if (files) {
        if (!host.postMessageWithAdditionalObjects) throw new Error('此 WebView2 不支援檔案拖入路徑，請改用「選檔執行 BAT／CMD」。');
        host.postMessageWithAdditionalObjects({ type: 'batchDrop', requestId: id }, files);
      } else if (!send({ type: 'batchOpen', requestId: id })) throw new Error('無法開啟檔案選擇器。');
    } catch (error) { delete batchRequests[id]; showToast(error.message, true); }
  }
  function handleBatchFiles(message) {
    var request = batchRequests[message.requestId]; if (!request) return; delete batchRequests[message.requestId];
    if (message.cancelled) return;
    if (message.error) { showToast(message.error, true); return; }
    var view = request.view, slot = request.slot;
    if (getView(view.config.id) !== view) { showToast('原目標工作區已變更，請重新拖入批次檔。', true); return; }
    var files = message.files;
    if (!Array.isArray(files) || !files.length || files.some(function (f) { return !f || typeof f.path !== 'string' || !/\.(bat|cmd)$/i.test(f.path) || !f.directory; })) { showToast('未取得有效批次檔。', true); return; }
    var cell = view.panes[slot], running = views.reduce(function (n, v) { return n + v.panes.reduce(function (m, p) { return m + p.tabs.filter(isActive).length; }, 0); }, 0);
    if (files.length + cell.config.tabs.length > MAX_TABS || running + files.length > 64) { showToast('終端或分頁容量不足，本次批次檔未執行。', true); return; }
    var previousFocused = focused;
    var tabs = files.map(function (file) {
      var tab = defaultTab(cell.config.tabs.length, uid('batch-tab'));
      tab.name = str(file.name, 48) || 'BAT'; tab.batchFile = file.path; tab.cwd = file.directory;
      cell.config.tabs.push(tab); makeTerminal(view, slot, tab); return tab;
    });
    cell.config.activeTabId = tabs[0].id; saveConfig(false);
    tabs.forEach(function (tab) { startSlot(view, slot, tab.id, false); });
    cell.config.activeTabId = tabs[0].id; renderPane(view, slot);
    if (activeView === view) { markFocused(view, slot, tabs[0].id); getState(view.config.id, slot, tabs[0].id).terminal.focus(); }
    else if (previousFocused && previousFocused.view === activeView) markFocused(previousFocused.view, previousFocused.slot, previousFocused.tabId);
    queueSave(); scheduleFit(); showToast('已在第 ' + (slot + 1) + ' 格新增 ' + tabs.length + ' 個 CMD 分頁並執行原檔。');
  }
  function importDroppedFile(file, done) {
    done = typeof done === 'function' ? done : function () {};
    if (!file) { done(); return; }
    var name = file.name || '';
    if (!/\.(tgridflow|tgridcmd)$/i.test(name)) { showToast('支援 .bat／.cmd 執行，或 .tgridflow／.tgridcmd 匯入。', true); done(); return; }
    if (file.size > 1024 * 1024) { showToast('檔案超過 1 MB。', true); done(); return; }
    var reader = new FileReader();
    reader.onload = function () { if (/\.tgridflow$/i.test(name)) loadFlowFile(String(reader.result), name); else loadCommandPackFile(String(reader.result), name); done(); };
    reader.onerror = function () { showToast('無法讀取拖入的檔案。', true); done(); };
    reader.readAsText(file, 'UTF-8');
  }

  function terminalLog(state) {
    return (state.recordingPath ? '完整錄製檔案：' + state.recordingPath + '\r\n\r\n' : '') +
      state.transcript.text() + (state.logMarkers.length ? '\r\n--- 標記 ---\r\n' + state.logMarkers.join('\r\n') : '');
  }
  function captureEvidence(state) {
    if (!hostReady || evidence || document.querySelector('dialog[open]:not(#flowPauseDialog)')) return;
    if (!state.hasOutput || !state.layer.getClientRects().length) { showToast('請先顯示有輸出的終端分頁。', true); return; }
    var bounds = state.layer.closest('.pane').getBoundingClientRect();
    var text = terminalLog(state), result = window.TerminalGridFlowOutput.iperfResult((state.iperfOutput || state.transcript).text());
    if (state.status === 'exited' && state.exitCode !== null)
      result.status += ' · 終端退出碼 ' + state.exitCode;
    evidence = { id: uid('evidence'), text: text, status: result.status, lines: result.lines };
    $('evidenceRate').value = result.rate;
    $('evidenceResult').value = '待確認';
    $('saveEvidenceButton').disabled = true;
    var capture = evidence;
    requestAnimationFrame(function () { requestAnimationFrame(function () {
      if (evidence !== capture) return;
      if (!send({ type: 'captureEvidence', requestId: capture.id,
        x: bounds.left / innerWidth, y: bounds.top / innerHeight, w: bounds.width / innerWidth, h: bounds.height / innerHeight })) evidence = null;
    }); });
  }
  function openTerminalLog(state) {
    logState = state;
    $('terminalLogText').value = terminalLog(state);
    updateRecording();
    $('terminalLogDialog').showModal();
    $('terminalLogQuery').focus();
  }
  function updateRecording() {
    $('terminalRecordingPath').textContent = logState.recordingPath || '';
    $('toggleTerminalRecording').textContent = logState.recording ? '停止錄製' : '開始錄製完整 Log';
    $('toggleTerminalRecording').disabled = logState.status !== 'running';
  }
  function initialize() {
    $('androidBrowseDialog').addEventListener('close', function () { if (!this.open) remoteBrowser = null; });
    $('androidBrowseForm').addEventListener('submit', function (event) { event.preventDefault(); requestRemoteDirectory($('androidBrowsePath').value); });
    $('androidBrowseUp').addEventListener('click', function () {
      var path = $('androidBrowsePath').value.trim().replace(/\/+$/, '');
      requestRemoteDirectory(path.slice(0, path.lastIndexOf('/')) || '/');
    });
    document.querySelectorAll('[data-remote-dir]').forEach(function (button) {
      button.addEventListener('click', function () { requestRemoteDirectory(this.dataset.remoteDir); });
    });
    function enterRemoteDirectory() {
      var entry = selectedRemoteEntry();
      if (!$('androidBrowseEnter').disabled && entry && entry.directory) requestRemoteDirectory(remoteEntryPath(entry));
    }
    $('androidBrowsePath').addEventListener('input', updateRemoteBrowserButtons);
    $('androidBrowseEntries').addEventListener('change', updateRemoteBrowserButtons);
    $('androidBrowseEntries').addEventListener('dblclick', enterRemoteDirectory);
    $('androidBrowseEnter').addEventListener('click', enterRemoteDirectory);
    $('androidBrowseUse').addEventListener('click', function () {
      if (this.disabled || !remoteBrowser || remoteBrowser.target !== pathCommandTarget) return;
      var entry = selectedRemoteEntry();
      remoteBrowser.input.value = entry ? remoteEntryPath(entry) : remoteBrowser.path;
      remoteBrowser.input.dispatchEvent(new Event('input', { bubbles: true }));
      $('androidBrowseDialog').close();
    });
    try { adbToolsFolder = localStorage.getItem('terminalGrid.adbToolsFolder') || ''; } catch (_) { }
    $('adbLogsButton').addEventListener('click', openAdbLogs);
    $('androidAppsButton').addEventListener('click', function () {
      if (!hostReady) return;
      $('androidAppsDialog').showModal(); discoverAndroidAppsDevices();
    });
    $('androidAppsDialog').addEventListener('close', function () { appsRequest = null; });
    $('refreshAndroidDevices').addEventListener('click', discoverAndroidAppsDevices);
    $('pickAppsAdb').addEventListener('click', function () { pickAdbTools($('androidAppsDialog'), discoverAndroidAppsDevices); });
    $('androidDevice').addEventListener('change', loadAndroidApps);
    $('openAndroidMirror').addEventListener('click', function () {
      if (!this.disabled) requestAndroid('androidMirror', { toolsFolder: appsAdbPath });
    });
    $('wakeAndroidScreen').addEventListener('click', function () {
      if (!this.disabled) requestAndroid('androidWake', { toolsFolder: appsAdbPath });
    });
    $('androidAppSearch').addEventListener('input', renderAndroidApps);
    $('androidApp').addEventListener('change', updateAndroidButtons);
    $('launchAndroidApp').addEventListener('click', function () {
      if (!$('launchAndroidApp').disabled) requestAndroid('androidLaunch', { component: $('androidApp').value, toolsFolder: appsAdbPath });
    });
    $('androidSysdump').addEventListener('click', function () {
      if (!$('androidSysdump').disabled) requestAndroid('androidLaunch', { sysdump: true, toolsFolder: appsAdbPath });
    });
    completionMenu = window.TerminalGridCompletion.createMenu(document);
    try { $('smartCompletion').checked = localStorage.getItem('terminalGrid.smartCompletion') !== 'false'; } catch (_) { }
    $('smartCompletion').addEventListener('change', function () {
      completionMenu.close();
      try { localStorage.setItem('terminalGrid.smartCompletion', String(this.checked)); } catch (_) { }
    });
    $('clearCompletionHistory').addEventListener('click', function () {
      completionHistory = []; completionMenu.close(); showToast('已清除本次補全使用的指令歷史。');
    });
    var historyButton = document.createElement('button');
    historyButton.className = 'button'; historyButton.textContent = '最近格子操作…';
    $('appOptions').querySelector('.app-options-menu').appendChild(historyButton);
    historyButton.addEventListener('click', function () {
      $('paneHistoryList').replaceChildren();
      paneHistory.slice().reverse().forEach(function (item) {
        var li = document.createElement('li'); li.textContent = item.time + ' · ' + item.label;
        $('paneHistoryList').append(li);
      });
      $('undoPaneButton').disabled = !paneHistory.length;
      $('paneHistoryDialog').showModal();
    });
    $('undoPaneButton').addEventListener('click', function () { $('paneHistoryDialog').close(); undoPaneAction(); });
    var sharedParams = document.createElement('label');
    sharedParams.id = 'shareFlowParamsLabel'; sharedParams.hidden = true;
    sharedParams.innerHTML = '<input id="shareFlowParams" type="checkbox"> 套用同名參數到整個流程';
    $('pathCommandFields').after(sharedParams);
    var flowTools = document.createElement('div');
    flowTools.innerHTML = '<p id="flowProgress" role="status"></p><p id="flowLogPath" class="help-note"></p><div class="folder-input-row"><button id="stopRunningFlow" class="button" disabled>停止流程</button><button id="exportFlowLog" class="button">匯出最近流程 Log</button></div><div class="folder-input-row"><label><input id="recordFlowOutput" type="checkbox"> 每格逐行加時間並寫入 Log</label><button id="pickFlowRecordingFolder" type="button" class="button">選 Log 資料夾…</button></div><p id="flowRecordingFolder" class="help-note">預設儲存在本機 terminal-logs</p>';
    function pickRecordingFolder() {
      if (flowRecordingPick || flowRunning) return;
      flowRecordingPick = uid('flow-log-folder');
      if (!send({ type: 'pickCommandPath', requestId: flowRecordingPick, kind: 'folder' })) flowRecordingPick = null;
    }
    flowTools.querySelector('#pickFlowRecordingFolder').addEventListener('click', pickRecordingFolder);
    $('pickCaseRecordingFolder').addEventListener('click', pickRecordingFolder);
    $('flowSteps').after(flowTools);
    $('stopRunningFlow').addEventListener('click', function () { if (activeRun) activeRun.cancelled = true; finishFlowPause(false); finishNanTransfer(null); });
    $('exportFlowLog').addEventListener('click', function () {
      if (!lastRun) { showToast('本次開啟程式後尚未完成流程。'); return; }
      send({ type: 'exportLog', text: lastRun.lines.join('\r\n') });
    });
    $('evidenceDialog').addEventListener('close', function () { evidence = null; });
    $('evidenceForm').addEventListener('submit', function (event) {
      event.preventDefault();
      if (!evidence) return;
      var sheet = $('evidenceSheet').value.trim(), tc = $('evidenceTc').value.trim();
      if (!sheet || !tc) { showToast('請填工作表與 TC 編號。', true); return; }
      send({ type: 'saveEvidence', requestId: evidence.id, sheet: sheet, tc: tc, status: evidence.status, text: evidence.text,
        result: $('evidenceResult').value, rate: $('evidenceRate').value.trim() });
      $('evidenceDialog').close();
    });
    $('findTerminalLog').addEventListener('click', function () {
      var query = $('terminalLogQuery').value.toLowerCase(), area = $('terminalLogText');
      if (!query) return;
      var text = area.value.toLowerCase(), index = text.indexOf(query, area.selectionEnd);
      if (index < 0) index = text.indexOf(query);
      if (index < 0) { showToast('找不到相符的文字。'); return; }
      area.focus(); area.setSelectionRange(index, index + query.length);
      area.scrollTop = Math.max(0, (area.value.slice(0, index).split('\n').length - 4) * parseFloat(getComputedStyle(area).lineHeight));
    });
    $('markTerminalLog').addEventListener('click', function () {
      if (!logState) return;
      logState.logMarkers.push(new Date().toISOString() + ' ' + ($('terminalLogNote').value.trim() || '標記'));
      if (logState.logMarkers.length > 100) logState.logMarkers.shift();
      $('terminalLogNote').value = ''; $('terminalLogText').value = terminalLog(logState);
    });
    $('clearTerminalScreen').addEventListener('click', function () { if (logState) logState.terminal.clear(); $('terminalLogDialog').close(); });
    $('exportTerminalLog').addEventListener('click', function () { if (logState) send({ type: 'exportLog', text: terminalLog(logState) }); });
    $('toggleTerminalRecording').addEventListener('click', function () {
      if (logState) send(withGeneration(logState, { type: logState.recording ? 'recordStop' : 'recordStart' }));
    });
    window.TerminalGridHelp.render($('helpDialog'));
    var batchButton = document.createElement('button'); batchButton.id = 'runBatchButton'; batchButton.className = 'button'; batchButton.textContent = '選檔執行 BAT／CMD…';
    batchButton.addEventListener('click', function () { var target = batchTarget(null); requestBatch(target.view, target.slot); });
    $('appOptions').querySelector('.app-options-menu').appendChild(batchButton);
    var batchField = document.createElement('label'); batchField.className = 'field'; batchField.innerHTML = 'BAT 原檔路徑（選填）<input id="settingBatchFile" maxlength="4096" spellcheck="false" placeholder="留空使用一般終端；亦可直接拖入 BAT"><span class="field-hint">有路徑時使用 CMD 執行原檔，工作目錄固定為原檔所在資料夾。儲存不會立刻執行。</span>';
    $('settingCommand').parentNode.before(batchField); $('settingBatchFile').addEventListener('input', updateCustomFields);
    ['options', 'commands'].forEach(function (place) {
      var button = document.createElement('button'); button.type = 'button'; button.className = 'button'; button.id = 'deviceFiles-' + place; button.textContent = '裝置檔案 · cfg／Logs…';
      button.addEventListener('click', function () { if (hostReady) send({ type: 'deviceFilesOpen' }); });
      (place === 'options' ? $('appOptions').querySelector('.app-options-menu') : $('commandDialog').querySelector('.flow-toolbar')).appendChild(button);
    });
    ['flow', 'options'].forEach(function (place) {
      var button = document.createElement('button'); button.type = 'button'; button.className = 'button'; button.id = place === 'flow' ? 'nanWorkflowButton' : 'nanOptionsButton'; button.textContent = 'NAN／NDP 雙手機…';
      button.addEventListener('click', openNanDialog);
      (place === 'flow' ? $('flowDialog').querySelector('.flow-toolbar') : $('appOptions').querySelector('.app-options-menu')).appendChild(button);
    });
    $('nanDiscover').addEventListener('click', discoverNanDevices);
    var testCaseButton = document.createElement('button');
    testCaseButton.type = 'button'; testCaseButton.className = 'button'; testCaseButton.id = 'testCaseButton';
    testCaseButton.textContent = '本機測項（TC）…';
    testCaseButton.addEventListener('click', openTestCaseDialog);
    $('flowDialog').querySelector('.flow-toolbar').appendChild(testCaseButton);
    $('testCaseFilter').addEventListener('input', function () { renderTestCaseList(); updateTestCaseButtons(); });
    $('testCaseSelect').addEventListener('change', function () { testCasePathId = null; editTestCase(this.value); });
    $('newTestCase').addEventListener('click', function () { testCasePathId = null; editTestCase(''); $('testCaseCode').focus(); });
    $('testCaseForm').addEventListener('input', function (event) {
      if (!['testCaseCode', 'testCaseName', 'testCaseFeasibility', 'testCaseNotes', 'testCaseFlow', 'testCaseUsb', 'testCaseSerials', 'testCaseFolder'].includes(event.target.id)) return;
      testCaseDirty = true; updateTestCaseButtons();
    });
    $('testCaseForm').addEventListener('submit', saveTestCase);
    $('testCaseBrowse').addEventListener('click', function () {
      if (testCasePathId || testCaseCheck) return;
      testCasePathId = uid('case-folder');
      if (!send({ type: 'pickCommandPath', requestId: testCasePathId, kind: 'folder' })) testCasePathId = null;
    });
    $('testCaseDialog').addEventListener('close', function () {
      if (this.open) return;
      testCasePathId = null;
      if (testCaseCheck && testCaseCheck.cancelOnClose) finishTestCaseCheck({ error: '已取消預檢。' });
    });
    $('deleteTestCase').addEventListener('click', async function () {
      var item = selectedTestCase();
      if (!item || !(await askConfirmation('刪除測項？', item.code + ' · ' + item.title, '刪除'))) return;
      appConfig.testCases = appConfig.testCases.filter(function (entry) { return entry.id !== item.id; });
      testCaseQueue.delete(item.id);
      editTestCase(''); queueSave();
    });
    $('runTestCase').addEventListener('click', checkTestCase);
    $('runTestCaseQueue').addEventListener('click', runTestCaseQueue);
    $('importTestCases').addEventListener('click', importTestCases);
    $('nanBrowse').addEventListener('click', function () { if (nanPathId) return; nanPathId = uid('nan-folder'); send({ type: 'pickCommandPath', requestId: nanPathId, kind: 'folder' }); });
    $('nanDialog').addEventListener('close', function () { nanDiscoveryId = null; nanPathId = null; });
    function syncNanToolFields() {
      var mode = $('nanTool').value, choose = mode === 'choose', family = mode === 'iperf' ? 'iperf' : 'iperf3';
      if (mode !== 'share') {
        ['nanBin1', 'nanBin2'].forEach(function (id) { if (['iperf', 'iperf3'].includes($(id).value)) $(id).value = family; });
        if (['5001', '5201'].includes($('nanPort').value)) $('nanPort').value = family === 'iperf' ? '5001' : '5201';
      }
      $('nanBin1Label').textContent = 'DUT1 ' + family + ' 名稱／Android 路徑';
      $('nanBin2Label').textContent = 'DUT2 ' + family + ' 名稱／Android 路徑';
      $('nanPortLabel').textContent = choose ? 'iperf3 Port（iperf 2 使用 5001）' : 'Port';
      $('nanAmountLabel').textContent = choose ? '傳輸量（bytes）' : '傳輸量（-n）';
      $('nanIperf2Fields').hidden = !choose;
      $('nanPythonOption').hidden = !choose;
      $('nanPythonField').hidden = !choose || !$('nanUsePython').checked;
      $('nanDuringTransfer').parentNode.hidden = mode === 'share';
    }
    $('nanTool').addEventListener('change', syncNanToolFields);
    $('nanUsePython').addEventListener('change', syncNanToolFields);
    syncNanToolFields();
    $('nanForm').addEventListener('submit', function (event) {
      event.preventDefault();
      if (flowRunning || flowPreparing || nanPathId) { showToast('請先完成目前流程或資料夾選擇。'); return; }
      if (appConfig.workspaces.length >= 12 || appConfig.automations.length >= 32) { showToast('工作區或流程已達上限，請先移除不需要的項目。', true); return; }
      var values = { recovery: $('nanRecovery').checked, reuseMirrors: $('nanReuseMirrors').checked, usePython: $('nanTool').value === 'choose' && $('nanUsePython').checked,
        pythonPath: $('nanPythonPath').value.trim(), bin1Iperf2: $('nanBin1Iperf2').value.trim(), bin2Iperf2: $('nanBin2Iperf2').value.trim(),
        beforeStart: $('nanBeforeStart').value, beforeNdp: $('nanBeforeNdp').value,
        beforeTransfer: $('nanBeforeTransfer').value, afterTransfer: $('nanAfterTransfer').value,
        duringTransfer: $('nanTool').value === 'share' ? '' : $('nanDuringTransfer').value };
      ['Dut1', 'Dut2', 'If1', 'If2', 'Tool', 'Bin1', 'Bin2', 'Amount', 'Port', 'Folder'].forEach(function (key) { values[key.toLowerCase()] = $('nan' + key).value.trim(); });
      try {
        var flow = window.TerminalGridNan.create(values);
        ['nanBeforeStart', 'nanBeforeNdp', 'nanBeforeTransfer', 'nanDuringTransfer', 'nanAfterTransfer'].forEach(function (id) { $(id).value = ''; });
        $('nanDialog').close();
        loadFlowFile(JSON.stringify(flow), 'NAN.tgridflow');
      }
      catch (error) { showToast(error.message, true); }
    });
    try { $('showLineEditors').checked = localStorage.getItem('terminalGrid.showLineEditors') !== 'false'; } catch (_) { }
    document.body.classList.toggle('hide-line-editors', !$('showLineEditors').checked);
    $('showLineEditors').addEventListener('change', function () {
      document.body.classList.toggle('hide-line-editors', !this.checked);
      try { localStorage.setItem('terminalGrid.showLineEditors', String(this.checked)); } catch (_) { }
      scheduleFit();
    });
    $('refreshCommandTargets').addEventListener('click', discoverTargets);
    $('pathCommandFields').addEventListener('input', updatePullPreview);
    var pickPullAdb = document.createElement('button');
    pickPullAdb.type = 'button'; pickPullAdb.className = 'button'; pickPullAdb.textContent = '選 ADB 資料夾…';
    pickPullAdb.addEventListener('click', function () { pickAdbTools($('pathCommandDialog'), discoverTargets); });
    $('refreshCommandTargets').after(pickPullAdb);
    $('pathCommandDialog').addEventListener('close', function () {
      if (this.open) return;
      if ($('androidBrowseDialog').open) $('androidBrowseDialog').close();
      var target = pathCommandTarget; pathCommandTarget = null; pathPickPending = null; targetDiscoveryRequest = null;
      if (target && target.finish) target.finish(null);
    });
    $('pathCommandForm').addEventListener('submit', function (event) {
      event.preventDefault(); var target = pathCommandTarget;
      if (!target || getState(target.state.workspaceId, target.state.slot, target.state.tabId) !== target.state || (target.finish ? target.state.generation !== target.generation : !sameSession(target.state, target.generation))) { showToast('目標終端已變更，請重新插入指令。', true); return; }
      if (pathPickPending) { showToast('請先完成檔案選擇。'); return; }
      var values = {}; $('pathCommandFields').querySelectorAll('input').forEach(function (input) { values[input.dataset.pathKey] = input.value; });
      try {
        var shell = target.state.status === 'running' ? target.state.sessionShell : getTabConfig(getWorkspace(target.state.workspaceId), target.state.slot, target.state.tabId).shell;
        var text = window.TerminalGridDefaults.resolve(target.text, values, shell, target.adbPath);
        var pullCategory = target.pullRemoteKey && pullLogCategory(values[target.pullRemoteKey] || '');
        if (target.shared && $('shareFlowParams').checked) Object.assign(target.shared, values);
        pathCommandTarget = null; pathPickPending = null; targetDiscoveryRequest = null;
        $('pathCommandDialog').close();
        if (!target.finish && window.TerminalGridDefaults.pullPathKey(target.text) && $('commandDialog').open) $('commandDialog').close();
        if (target.finish) target.finish(text);
        else if (target.replace) {
          if (!target.selection) showToast('請重新框選可編輯的指令內容。', true);
          else if (replaceLiveSelection(target.state, text, target.selection)) pullDestination(pullCategory, values.LOCAL_FOLDER);
        } else {
          insertCommand(target.state, text, false, true);
          pullDestination(pullCategory, values.LOCAL_FOLDER);
        }
      } catch (error) { $('targetDiscoveryStatus').textContent = error.message; }
    });
    try { if (localStorage.getItem('terminalGrid.rightClickMode') === 'menu') rightClickMode = 'menu'; } catch (_) { }
    $('rightClickMode').value = rightClickMode;
    $('rightClickMode').addEventListener('change', function () {
      rightClickMode = this.value === 'menu' ? 'menu' : 'quick';
      try { localStorage.setItem('terminalGrid.rightClickMode', rightClickMode); } catch (_) { }
      showToast(rightClickMode === 'quick' ? '右鍵：有選取就複製，無選取就貼上；Shift＋右鍵開選單。' : '右鍵已切換為功能選單。');
    });
    $('appOptions').addEventListener('click', function (event) { if (event.target.closest('button')) this.open = false; });
    if (typeof window.Terminal !== 'function' || !window.FitAddon || !window.TerminalGridDefaults || !window.TerminalGridIPv6 || !window.TerminalGridDraft || !window.TerminalGridTextEdit || !window.TerminalGridLiveReplace) {
      $('connectionDot').className = 'connection-dot failed'; $('connectionText').textContent = '終端元件載入失敗';
      showToast('缺少本機終端元件。請完整解壓縮套件，再啟動 TerminalGridIntegrated.exe。', true); return;
    }
    var initial = normalizeAppConfig(null); initial.workspaces.forEach(createView); activateWorkspace(initial.activeWorkspaceId);
    commandDraft = window.TerminalGridDraft.create({ container: $('commandDraftHost'), getValues: currentCaptures, onStatus: showToast, onResize: scheduleFit,
      attachCompletion: attachCommandCompletion, attachReplacementCompletion: attachReplacementCompletion,
      onSend: function (text) {
        var state = draftTarget && draftTarget.state;
        if (!state || getState(state.workspaceId, state.slot, state.tabId) !== state || state.generation !== draftTarget.generation || state.status !== 'running') {
          showToast('草稿目標已結束或重新啟動；請選取終端後重新開啟草稿以指定目標。', true); return;
        }
        activateWorkspace(state.workspaceId); var view = getView(state.workspaceId); view.panes[state.slot].config.activeTabId = state.tabId;
        renderPane(view, state.slot); markFocused(view, state.slot, state.tabId); scheduleFit(); insertCommand(state, text);
      } });
    $('commandDraftText').addEventListener('focus', function () { focusedEditor = { draft: true }; });
    $('draftButton').addEventListener('click', function () { openCommandDraft(focused && focused.state); });
    $('captureValueForm').addEventListener('submit', function (event) { event.preventDefault(); if (saveCaptureText($('captureValueInput').value)) $('captureValueInput').value = ''; });
    $('captureButton').addEventListener('click', function () { setCapturePanel($('capturePanel').hidden); });
    $('closeCaptureButton').addEventListener('click', function () { setCapturePanel(false); });
    $('clearCapturesButton').addEventListener('click', function () { capturedValues = []; renderCaptures(); });
    $('captureCommandTarget').addEventListener('change', function () { refreshCaptureCommand(true); });
    $('captureCommandScope').addEventListener('change', function () { refreshCaptureCommand(false); });
    $('captureCommandRefresh').addEventListener('click', function () { refreshCaptureCommand(true); });
    $('captureCommandApply').addEventListener('click', applyCaptureCommand);
    $('captureCommandDialog').addEventListener('close', function () { captureCommand = null; });
    $('captureEnabled').addEventListener('change', function () {
      views.forEach(function (view) { view.panes.forEach(function (cell) { cell.tabs.forEach(resetCaptureScanner); }); });
      showToast(this.checked ? '已啟用 IPv6／Aware 介面自動擷取。' : '已暫停自動擷取，現有紀錄會保留。');
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
      if ($('settingBatchFile').value && $('settingShell').value !== 'CMD') { showToast('BAT 原檔請使用 CMD，或清除 BAT 路徑。', true); return; }
      if ($('settingShell').value === 'Custom' && !$('settingExe').value.trim()) { $('settingExe').setCustomValidity('請輸入要啟動的可執行程式。'); $('settingExe').reportValidity(); return; }
      var ref = settingsRef, tab = getTabConfig(getWorkspace(ref.workspaceId), ref.slot, ref.tabId);
      Object.assign(tab, { name: $('settingName').value.trim() || defaultTab(0).name, shell: $('settingShell').value,
        cwd: $('settingCwd').value.trim(), command: $('settingCommand').value, exe: $('settingExe').value.trim(), args: $('settingArgs').value, batchFile: $('settingBatchFile').value });
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
    $('runFlowButton').addEventListener('click', function () { runFlow(); });
    $('deleteFlowButton').addEventListener('click', deleteFlow);
    $('importFlowButton').addEventListener('click', function () { if (hostReady) send({ type: 'flowOpen' }); });
    $('continuePausedFlowButton').addEventListener('click', function () { finishFlowPause(true); });
    $('stopPausedFlowButton').addEventListener('click', function () { finishFlowPause(false); });
    $('flowPauseDialog').addEventListener('cancel', function (event) { event.preventDefault(); finishFlowPause(false); });
    $('nanTransferDialog').addEventListener('cancel', function (event) { event.preventDefault(); finishNanTransfer(null); });
    $('nanTransferDialog').querySelectorAll('[data-nan-transfer]').forEach(function (button) {
      button.addEventListener('click', function () { finishNanTransfer(button.dataset.nanTransfer || null); });
    });
    $('commandPackSelect').addEventListener('change', renderCommandLibrary);
    $('newPackButton').addEventListener('click', newCommandPack);
    $('renamePackButton').addEventListener('click', function () { var pack = selectedCommandPack(); if (pack) openPackDialog(pack); });
    $('duplicatePackButton').addEventListener('click', duplicateCommandPack);
    $('deletePackButton').addEventListener('click', deleteCommandPack);
    $('packForm').addEventListener('submit', savePackDialog);
    $('addCommandButton').addEventListener('click', function () { addCommand(); });
    $('commandEditForm').addEventListener('submit', saveCommandEditor);
    $('deleteCommandButton').addEventListener('click', deleteCommandSnippet);
    $('exportPackButton').addEventListener('click', exportCommandPack);
    $('importPackButton').addEventListener('click', function () { if (hostReady) send({ type: 'commandPackOpen' }); });
    document.addEventListener('dragover', function (event) { if (event.dataTransfer && (event.dataTransfer.files.length || hasDataType(event.dataTransfer, 'Files'))) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } }, true);
    document.addEventListener('drop', function (event) {
      if (!event.dataTransfer || !event.dataTransfer.files.length) return;
      event.preventDefault(); event.stopImmediatePropagation();
      var files = Array.from(event.dataTransfer.files), batches = files.filter(function (f) { return /\.(bat|cmd)$/i.test(f.name); });
      var target = batchTarget(event.target);
      if (batches.length) {
        if (document.querySelector('dialog[open]')) { showToast('請先關閉操作視窗，再把 BAT 拖到目標格子。', true); return; }
        requestBatch(target.view, target.slot, batches);
      }
      importDroppedFiles(files.filter(function (f) { return !/\.(bat|cmd)$/i.test(f.name); }));
    }, true);
    document.addEventListener('click', function (event) {
      if (!event.target.closest('#terminalContextMenu') && !event.target.closest('[data-action="menu"]') && !completionMenu.contains(event.target)) $('terminalContextMenu').hidden = true;
      if (!event.target.closest('#appOptions')) $('appOptions').open = false;
    });
    $('terminalContextMenu').addEventListener('keydown', function (event) {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || event.target.matches('input,textarea')) return;
      var buttons = Array.from(this.querySelectorAll('button:not(:disabled)'));
      if (!buttons.length) return;
      event.preventDefault();
      var index = buttons.indexOf(document.activeElement);
      index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[index].focus();
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && completionMenu.hasInput(event.target)) return;
      if (event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey && event.code === 'KeyZ' &&
          !event.target.closest('input, textarea, [contenteditable], .terminal-mount') && !document.querySelector('dialog[open]')) {
        event.preventDefault(); event.stopImmediatePropagation();
        if (!event.repeat) undoPaneAction();
        return;
      }
      if (event.key === 'F8' && !event.repeat && focused && !document.querySelector('dialog[open]:not(#flowPauseDialog)')) {
        event.preventDefault(); event.stopImmediatePropagation(); captureEvidence(focused.state); return;
      }
      if (event.key === 'Escape' && selectedPanes.size && $('terminalContextMenu').hidden && !document.querySelector('dialog[open]')) {
        event.preventDefault(); event.stopImmediatePropagation(); clearPaneSelection(); return;
      }
      if (event.key === 'Escape' && (!$('terminalContextMenu').hidden || $('appOptions').open)) {
        event.preventDefault(); event.stopImmediatePropagation();
        if ($('appOptions').open) { $('appOptions').open = false; $('appOptions').querySelector('summary').focus(); }
        else { $('terminalContextMenu').hidden = true; if (focused) focused.state.terminal.focus(); }
        return;
      }
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
