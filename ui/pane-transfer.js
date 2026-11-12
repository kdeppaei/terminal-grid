(function (root) {
  'use strict';
  function address(workspaceId, slot, tabId) { return { workspaceId: workspaceId, slot: slot, tabId: tabId }; }
  function cell(config, a) {
    var w = config.workspaces.find(function (w) { return w.id === a.workspaceId; });
    if (!w || !Number.isInteger(a.slot) || a.slot < 0 || a.slot >= w.rows * w.cols) throw Error('目標格子不存在或已隱藏。');
    return w.slots[a.slot];
  }
  function plan(config, source, target, mode, newId) {
    var next = JSON.parse(JSON.stringify(config)), from = cell(next, source), to = cell(next, target), moves = [];
    if (from === to && mode !== 'copy') throw Error('來源與目標是同一格。');
    var tab = from.tabs.find(function (t) { return t.id === source.tabId; });
    if (!tab) throw Error('來源分頁已關閉，請重新選擇。');
    if (mode === 'swap') {
      from.tabs.forEach(function (t) { moves.push({ from: address(source.workspaceId, source.slot, t.id), to: address(target.workspaceId, target.slot, t.id) }); });
      to.tabs.forEach(function (t) { moves.push({ from: address(target.workspaceId, target.slot, t.id), to: address(source.workspaceId, source.slot, t.id) }); });
      var w1 = next.workspaces.find(function (w) { return w.id === source.workspaceId; });
      var w2 = next.workspaces.find(function (w) { return w.id === target.workspaceId; });
      w1.slots[source.slot] = to; w2.slots[target.slot] = from;
    } else {
      if (to.tabs.length >= 8) throw Error('目標格子已有 8 個分頁。');
      var copy = JSON.parse(JSON.stringify(tab));
      if (mode === 'copy') { copy.id = newId(); copy.name = (copy.name + ' 副本').slice(0, 48); }
      else {
        from.tabs = from.tabs.filter(function (t) { return t !== tab; });
        if (!from.tabs.length) from.tabs.push({ id: newId(), name: '新終端', shell: 'CMD', command: '', cwd: '', exe: '', args: '', batchFile: '' });
        if (from.activeTabId === tab.id) from.activeTabId = from.tabs[0].id;
        if (to.tabs.some(function (t) { return t.id === copy.id; })) copy.id = newId();
        moves.push({ from: source, to: address(target.workspaceId, target.slot, copy.id) });
      }
      to.tabs.push(copy); to.activeTabId = copy.id;
    }
    // A flow targets one workspace. Within it, references follow the terminal.
    // Cross-workspace references cannot be represented without splitting a flow.
    next.automations.forEach(function (flow) {
      flow.steps.forEach(function (step) {
        if (step.action === 'wait' || step.action === 'pause') return;
        var original = config.workspaces.find(function (w) { return w.id === flow.workspaceId; });
        var tabId = step.tabId || original.slots[step.slot].activeTabId;
        var move = moves.find(function (m) { return m.from.workspaceId === flow.workspaceId && m.from.slot === step.slot && m.from.tabId === tabId; });
        if (!move) return;
        if (move.to.workspaceId !== flow.workspaceId) throw Error('此分頁被「' + flow.name + '」流程使用。請先修改流程目標，或改用複製設定。');
        step.slot = move.to.slot; step.tabId = move.to.tabId;
      });
    });
    next.workspaces.forEach(function (w) { w.slots.forEach(function (c) { var t = c.tabs.find(function (t) { return t.id === c.activeTabId; }); ['name','shell','command','cwd','exe','args','batchFile'].forEach(function (k) { c[k] = t[k] || ''; }); }); });
    return { config: next, moves: moves, destination: mode === 'swap' ? address(target.workspaceId, target.slot, from.activeTabId) : address(target.workspaceId, target.slot, to.activeTabId) };
  }
  root.TerminalGridTransfer = { plan: plan };
}(window));
