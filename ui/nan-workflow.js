(function (root) {
  'use strict';
  function quote(value) { return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"'; }
  function create(v) {
    ['dut1', 'dut2'].forEach(function (k) { if (!/^[A-Za-z0-9_.:\[\]%-]{1,128}$/.test(v[k])) throw Error('請選擇或填入有效的 DUT1／DUT2 序號。'); });
    if (v.dut1 === v.dut2) throw Error('DUT1 與 DUT2 必須是不同手機。');
    ['if1', 'if2'].forEach(function (k) { if (!/^[A-Za-z0-9_.-]{1,32}$/.test(v[k])) throw Error('請填入有效介面名稱，例如 aware_data0。'); });
    ['bin1', 'bin2'].forEach(function (k) { if (!/^(?:\/[A-Za-z0-9_.-]+)+$|^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(v[k])) throw Error('工具請填名稱或 Android 絕對路徑，例如 /data/local/tmp/iperf3。'); });
    if (!/^[1-9][0-9]{0,11}[KMG]?$/.test(v.amount)) throw Error('傳輸量請填 1300M 或 1300000000 等正整數。');
    if (!/^\d+$/.test(v.port) || +v.port < 1 || +v.port > 65535) throw Error('Port 必須介於 1–65535。');
    if (['iperf3', 'iperf', 'share'].indexOf(v.tool) < 0) throw Error('請選測試模式。');
    if (/[\x00-\x1f"]/.test(v.folder)) throw Error('工具資料夾不可包含引號或控制字元。');
    var common = ['dut1', 'dut2', 'if1', 'if2', 'tool', 'bin1', 'bin2', 'amount', 'port', 'folder'].map(function (k) {
      return '--' + k + ' ' + quote(k === 'tool' && v.tool === 'share' ? 'iperf3' : v[k]);
    }).join(' ');
    function tab(name, mode) { return { id: 'nan-' + mode, name: name, shell: 'Custom', exe: 'TerminalGridNan.exe', args: '--mode ' + mode + ' ' + common, cwd: '', command: '' }; }
    var groups = [[tab('DUT1 · scrcpy', 'mirror1')], [tab('DUT2 · scrcpy', 'mirror2')], [tab('DUT1 · Server', 'server')],
      [tab('DUT2 · Ping 保活', 'ping')], [tab('DUT2 · Traffic', 'traffic')], [tab('DUT1 · ADB Shell', 'shell1'), tab('DUT2 · ADB Shell', 'shell2')]];
    var workspace = { name: 'NAN／NDP · ' + (v.tool === 'share' ? 'Quick Share' : v.tool), rows: 2, cols: 3, fontSize: 13,
      slots: groups.map(function (tabs) { return { activeTabId: tabs[0].id, tabs: tabs }; }) };
    function start(slot) { return { action: 'start', slot: slot, tabId: groups[slot][0].id, delayMs: 100 }; }
    function pause(text) { return { action: 'pause', slot: 0, tabId: groups[0][0].id, text: text }; }
    var steps = [start(0), start(1), pause('請透過兩個 scrcpy 視窗在 APK 建立 NAN／NDP。確認連線建立後立即按「繼續」；接著即時讀 DUT1 ' + v.if1 + '，在 DUT2 以 %' + v.if2 + ' 持續 ping6。') , start(3)];
    if (v.tool !== 'share') steps.push(start(2), pause('確認第 04 格 ping6 有回覆，且第 03 格 server 正常監聽，再按「繼續」啟動 ' + v.amount + ' 流量。若出錯先停止流程；可關閉此視窗後修正設定／重新啟動該格。'), start(4));
    else steps.push(pause('Ping 已啟動。請確認第 04 格有回覆，再透過 scrcpy 操作 Quick Share 傳送檔案。完成後按「繼續」結束流程編排，Ping 會持續；需自行停止第 04 格。'));
    // Re-running must end only this workspace's old traffic before obtaining a
    // fresh NDP address; a still-running ping must never retain yesterday's IP.
    steps = [3, 2, 4].map(function (slot) { var step = start(slot); step.action = 'stop'; return step; }).concat(steps);
    return { format: 'terminal-grid-flow', version: 1, name: workspace.name + (v.tool === 'share' ? '' : ' · ' + v.amount), workspace: workspace, steps: steps };
  }
  root.TerminalGridNan = { create: create };
}(typeof window === 'undefined' ? globalThis : window));
