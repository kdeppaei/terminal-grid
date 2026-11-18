(function (root) {
  'use strict';
  function quote(value) { return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"'; }
  function validateToolPath(value) {
    if (typeof value !== 'string' || !/^(?:\/[A-Za-z0-9_.-]+)+$|^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(value))
      throw Error('工具請填名稱或 Android 絕對路徑，例如 /data/local/tmp/iperf3。');
  }
  function create(v) {
    var choose = v.tool === 'choose', usePython = choose && !!v.usePython;
    ['dut1', 'dut2'].forEach(function (k) { if (!/^[A-Za-z0-9_.:\[\]%-]{1,128}$/.test(v[k])) throw Error('請選擇或填入有效的 DUT1／DUT2 序號。'); });
    if (v.dut1 === v.dut2) throw Error('DUT1 與 DUT2 必須是不同手機。');
    ['if1', 'if2'].forEach(function (k) { if (!/^[A-Za-z0-9_.-]{1,32}$/.test(v[k])) throw Error('請填入有效介面名稱，例如 aware_data0。'); });
    [v.bin1, v.bin2].forEach(validateToolPath);
    if (choose ? !/^[1-9][0-9]{0,11}$/.test(v.amount) : !/^[1-9][0-9]{0,11}[KMG]?$/.test(v.amount))
      throw Error(choose ? '傳輸量請以 bytes 填寫，例如 1300000000。' : '傳輸量請填 1300M 或 1300000000 等正整數。');
    if (!/^\d+$/.test(v.port) || +v.port < 1 || +v.port > 65535) throw Error('Port 必須介於 1–65535。');
    if (['choose', 'iperf3', 'iperf', 'share'].indexOf(v.tool) < 0) throw Error('請選測試模式。');
    if (/[\x00-\x1f"]/.test(v.folder)) throw Error('工具資料夾不可包含引號或控制字元。');
    var pythonPath = usePython ? (v.pythonPath || '') : '';
    if (usePython && (typeof pythonPath !== 'string' || /[\x00-\x1f"]/.test(pythonPath))) throw Error('Python 執行檔路徑不可包含引號或控制字元。');
    var primary = Object.assign({}, v, { tool: v.tool === 'iperf' ? 'iperf' : 'iperf3' });
    function tab(name, mode, options, id) {
      var settings = options || primary;
      var args = ['dut1', 'dut2', 'if1', 'if2', 'tool', 'bin1', 'bin2', 'amount', 'port', 'folder'].map(function (key) {
        return '--' + key + ' ' + quote(settings[key]);
      }).join(' ');
      if (mode === 'python-probe' && pythonPath) args += ' --python ' + quote(pythonPath);
      return { id: id || 'nan-' + mode, name: name, shell: 'Custom', exe: 'TerminalGridNan.exe', args: '--mode ' + mode + ' ' + args, cwd: '', command: '' };
    }
    var groups = [[tab('DUT1 · scrcpy', 'mirror1')], [tab('DUT2 · scrcpy', 'mirror2')], [tab('DUT1 · Server', 'server')],
      [tab('DUT2 · Ping 保活', 'ping')], [tab('DUT2 · Traffic', 'traffic')], [tab('DUT1 · ADB Shell', 'shell1'), tab('DUT2 · ADB Shell', 'shell2')]];
    if (choose) {
      var iperf2 = Object.assign({}, primary, { tool: 'iperf', bin1: v.bin1Iperf2 || 'iperf', bin2: v.bin2Iperf2 || 'iperf', port: '5001' });
      [iperf2.bin1, iperf2.bin2].forEach(validateToolPath);
      groups[2][0].name = 'DUT1 · iperf3 Server';
      groups[4][0].name = 'DUT2 · iperf3 Traffic';
      groups[2].push(tab('DUT1 · iperf 2 Server', 'server', iperf2, 'nan-server-iperf2'));
      groups[4].push(tab('DUT2 · iperf 2 Traffic', 'traffic', iperf2, 'nan-traffic-iperf2'));
      if (usePython) groups[3].push(tab('DUT2 · Python 驗證', 'python-probe'));
    }
    var modeName = choose ? 'Ping 後選擇' : v.tool === 'share' ? 'Quick Share' : v.tool;
    var workspace = { name: 'NAN／NDP · ' + modeName, rows: 2, cols: 3, fontSize: 13,
      slots: groups.map(function (tabs) { return { activeTabId: tabs[0].id, tabs: tabs }; }) };
    function start(slot, tabId) { return { action: 'start', slot: slot, tabId: tabId || groups[slot][0].id, delayMs: 100 }; }
    function stop(slot, tabId) { return Object.assign(start(slot, tabId), { action: 'stop' }); }
    function pause(text) { return { action: 'pause', slot: 0, tabId: groups[0][0].id, text: text }; }
    function waitForPing() { return { action: 'output', slot: 3, tabId: 'nan-ping', text: 'bytes from', timeoutMs: 10000, retries: 2 }; }
    var prepNan = '在兩台手機的 NAN 測試頁接續按 Start NAN。需要 AScC 或 Sche.gen 的測項請先手動設定。若測項需要 STD+，在此頁完成所有設定後，最後才在兩台接續按 Start STD+。';
    var prepNdp = '兩台切換到 Wi-Fi Aware 測試頁並先按 Start BLE，接著 DUT1 做 Publish、DUT2 做 Subscribe。確認找到指定對端並建立 NDP 後，按「繼續」驗證 Ping。';
    var steps = [start(0), start(1)];
    if (choose) {
      steps.push(pause(prepNan), pause(prepNdp));
      if (usePython) steps.push(start(3, 'nan-python-probe'), { action: 'exit', slot: 3, tabId: 'nan-python-probe', timeoutMs: 40000, retries: 0 });
      steps.push(start(3), waitForPing(), { action: 'nanTransfer', slot: 3, tabId: 'nan-ping', text: v.amount });
    } else steps.push(pause('請透過兩個 scrcpy 視窗在 APK 建立 NAN／NDP。完成後按「繼續」，DUT2 會使用當下的 DUT1 IPv6 與 DUT2 發送介面執行 ping6。'), start(3));
    if (v.tool === 'iperf3' || v.tool === 'iperf') steps.push(start(2), pause('確認第 04 格 ping6 有回覆，且第 03 格 server 正常監聽，再按「繼續」啟動 ' + v.amount + ' 流量。若出錯先停止流程；可關閉此視窗後修正設定／重新啟動該格。'), start(4),
      { action: 'exit', slot: 4, tabId: 'nan-traffic', timeoutMs: 600000, retries: 0 });
    if (v.tool === 'share') steps.push(pause('Ping 已啟動。請確認第 04 格有回覆，再透過 scrcpy 操作 Quick Share 傳送檔案。完成後按「繼續」結束流程編排，Ping 會持續；需自行停止第 04 格。'));
    var stopTests = [stop(3), stop(2), stop(4)];
    if (choose) stopTests.push(stop(2, 'nan-server-iperf2'), stop(4, 'nan-traffic-iperf2'));
    if (usePython) stopTests.push(stop(3, 'nan-python-probe'));
    if (v.recovery) {
      steps.push(pause('透過 APK 中斷 NDP，核對第 04 格 ping 是否失去回覆，必要時按 F8 留下證據。完成後按繼續。'));
      steps.push.apply(steps, stopTests);
      steps.push(stop(0), stop(1), pause('拔除並重插兩台手機。確認 USB 偵錯已重新授權，且仍使用原 DUT 序號，再按繼續。'), start(0), start(1));
      if (choose) steps.push(pause(prepNan), pause(prepNdp));
      else steps.push(pause('重新建立 Wi-Fi Aware／NDP 後按繼續，重新偵測兩端介面與 IPv6 並測試 Ping。'));
      steps.push(start(3), waitForPing());
    }
    // Re-running must end only this workspace's old traffic before obtaining a
    // fresh NDP address; a still-running ping must never retain yesterday's IP.
    steps = stopTests.concat(steps);
    return { format: 'terminal-grid-flow', version: 1, name: workspace.name + (v.tool === 'share' ? '' : ' · ' + v.amount), workspace: workspace, steps: steps };
  }
  root.TerminalGridNan = { create: create };
}(typeof window === 'undefined' ? globalThis : window));
