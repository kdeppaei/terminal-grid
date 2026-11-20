(function (root) {
  'use strict';
  function serials(value) { return Array.from(new Set(value.split(/[\s,，]+/).filter(Boolean))); }
  function usbDevices(candidates) {
    var used = new Set();
    return candidates.filter(function (candidate) {
      if (!candidate || candidate.kind !== 'device' || candidate.usb !== true ||
          typeof candidate.value !== 'string' || used.has(candidate.value)) return false;
      used.add(candidate.value);
      return true;
    }).slice(0, 256);
  }
  function chooseDevices(devices, remembered, count) {
    var connected = new Set(devices.map(function (device) { return device.value; }));
    if (Array.isArray(remembered) && remembered.length === count && new Set(remembered).size === count)
      return remembered.every(function (serial) { return connected.has(serial); }) ? remembered.slice() : [];
    return devices.length === count ? Array.from(connected) : [];
  }
  var defaults = [
    { code: 'NAN-PING', title: 'NAN／NDP IPv6 Ping', tool: 'ping', notes: '手動建立 NDP。自動取得 DUT1 IPv6 與 DUT2 介面，等候本輪 Ping 回覆。' },
    { code: 'NAN-TRANSFER', title: 'NAN／NDP Ping 後選擇傳輸', tool: 'choose', notes: '建立 NDP 後等待 Ping，接著選 iperf3、iperf 2 或 Quick Share。' },
    { code: 'NAN-IPERF3', title: 'NAN／NDP iperf3 1.3 GB', tool: 'iperf3', notes: '兩端先備妥 iperf3。確認 Server 監聽後從 DUT2 傳送 1,300,000,000 bytes，保留工具輸出。' },
    { code: 'NAN-IPERF2', title: 'NAN／NDP iperf 2 1.3 GB', tool: 'iperf', notes: '兩端先備妥 iperf 2。確認 Server 監聽後從 DUT2 傳送 1,300,000,000 bytes，保留工具輸出。' },
    { code: 'NAN-SHARE', title: 'NAN／NDP Quick Share 1.3 GB', tool: 'share', notes: '先在 DUT2 準備 1.3 GB 測試檔。Ping 成功後手動選檔、接收並確認完成。' },
    { code: 'NAN-RECOVERY', title: 'NAN／NDP 重插與重建驗證', tool: 'ping', recovery: true, notes: '驗證初次 Ping，手動中斷 NDP、重插 USB 並重建。流程重新查址，再驗證 Ping。' },
    { code: 'AP-CONNECTED', title: 'Wi-Fi AP 連線驗證', state: 'connected', notes: '依提示切換至指定 SSID，可指定 BSSID。用 ADB 驗證連線狀態，需 Python 3.9+。' },
    { code: 'AP-DISCONNECTED', title: 'Wi-Fi AP 斷線驗證', state: 'disconnected', notes: '依提示中斷 AP 連線並保持 Wi-Fi 開啟。用 ADB 驗證狀態，需 Python 3.9+。' }
  ];
  function makeDefault(preset, existing, flowId, devices, folder) {
    var used = new Set(existing.map(function (item) { return item.code.toLowerCase(); }));
    var code = preset.code, index = 2;
    while (used.has(code.toLowerCase())) code = preset.code + '-' + index++;
    return { code: code, title: preset.title, notes: preset.notes, feasibility: 'assisted',
      flowId: flowId, usbCount: devices.length, serials: devices.join(', '), toolsFolder: folder };
  }
  function createApFlow(preset, values) {
    var folder = values.folder, appDir = values.appDir;
    if (!appDir) throw Error('請在 Terminal Grid 桌面版建立 AP 測項。');
    if (!/^[A-Za-z0-9_.:\[\]%-]{1,128}$/.test(values.serial)) throw Error('請輸入有效的 USB 裝置序號。');
    if (/[\x00-\x1f"]/.test(folder + values.python + appDir + (values.adbPath || ''))) throw Error('路徑不可包含引號或控制字元。');
    if (preset.state === 'connected' && (!values.ssid || /[\x00-\x1f]/.test(values.ssid) || new TextEncoder().encode(values.ssid).length > 32))
      throw Error('請輸入 1–32 bytes 的有效 SSID。');
    if (values.bssid && !/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(values.bssid)) throw Error('BSSID 格式應為六組十六進位數字。');
    if (!/^\d+$/.test(values.timeout) || +values.timeout < 3 || +values.timeout > 300) throw Error('等待時間須為 3–300 秒。');
    function join(path, file) { return path.replace(/[\\/]+$/, '') + '\\' + file; }
    function quote(value) { return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"'; }
    var args = [join(appDir, 'tools\\wait_wifi_ap.py'), '--adb=' + (values.adbPath || (folder ? join(folder, 'adb.exe') : 'adb.exe')),
      '--serial=' + values.serial, '--state=' + preset.state, '--timeout=' + values.timeout];
    if (preset.state === 'connected') {
      args.push('--ssid=' + values.ssid);
      if (values.bssid) args.push('--bssid=' + values.bssid);
    }
    var tab = { id: 'ap-status', name: preset.title, shell: 'Custom', exe: values.python || 'python.exe', args: args.map(quote).join(' ') };
    var instruction = preset.state === 'connected'
      ? '請在手機連到指定 AP（' + values.ssid + '），完成後繼續檢查。'
      : '請在手機中斷目前 AP 連線並保持 Wi-Fi 開啟，完成後繼續檢查。';
    return { format: 'terminal-grid-flow', version: 1, name: preset.title,
      workspace: { name: preset.title, rows: 1, cols: 1, slots: [{ activeTabId: tab.id, tabs: [tab] }] },
      steps: [{ action: 'pause', slot: 0, tabId: tab.id, text: instruction },
        { action: 'stop', slot: 0, tabId: tab.id },
        { action: 'start', slot: 0, tabId: tab.id, delayMs: 100 },
        { action: 'exit', slot: 0, tabId: tab.id, timeoutMs: +values.timeout * 1000 + 15000 }] };
  }
  function parse(text, existing, flows) {
    if (typeof text !== 'string' || text.length > 1024 * 1024) throw Error('測項檔案上限為 1 MB。');
    text = text.replace(/^\uFEFF/, '').trim();
    var separator = text.split(/\r?\n/, 1)[0].includes('\t') ? '\t' : ',';
    var rows = [], row = [], value = '', quoted = false, closed = false;
    function cell() { row.push(value.trim()); value = ''; closed = false; }
    function record() { cell(); if (row.some(Boolean)) rows.push(row); row = []; }
    for (var index = 0; index < text.length; index++) {
      var c = text[index];
      if (quoted) {
        if (c === '"' && text[index + 1] === '"') { value += '"'; index++; }
        else if (c === '"') { quoted = false; closed = true; }
        else value += c;
      } else if (c === separator) cell();
      else if (c === '\r' || c === '\n') {
        if (c === '\r' && text[index + 1] === '\n') index++;
        record();
      } else if (c === '"' && !value && !closed) quoted = true;
      else if (c === '"' || closed) throw Error('欄位引號格式不正確。');
      else value += c;
    }
    if (quoted) throw Error('有欄位的引號尚未關閉。');
    record();
    var header = (rows.shift() || []).map(function (name) { return name.toLowerCase(); });
    if (!header.includes('code') || !header.includes('title') || new Set(header).size !== header.length || !rows.length)
      throw Error('請提供不重複的欄名、code、title 及至少一筆測項。');
    if (existing.length + rows.length > 256) throw Error('匯入後超過 256 筆測項上限。');
    var used = new Set(existing.map(function (item) { return item.code.toLowerCase(); }));
    return rows.map(function (fields, index) {
      function get(name) { return fields[header.indexOf(name)] || ''; }
      function invalid(message) { throw Error('第 ' + (index + 1) + ' 筆：' + message); }
      if (fields.length > header.length) invalid('欄位數超過標題。');
      var code = get('code'), title = get('title'), usb = get('usbcount'), selected = serials(get('serials'));
      if (!code || code.length > 32 || !title || title.length > 120) invalid('編號或名稱空白／超過長度限制。');
      if (used.has(code.toLowerCase())) invalid('編號重複：' + code);
      used.add(code.toLowerCase());
      if (usb && !/^(?:[0-9]|1[0-6])$/.test(usb)) invalid('USB 台數須為 0–16。');
      if (selected.length > 16 || selected.some(function (serial) { return !/^[A-Za-z0-9_.:\[\]%-]{1,128}$/.test(serial); }))
        invalid('USB 序號無效。');
      var mode = get('feasibility').toLowerCase() || 'pending';
      if (!['pending', 'auto', 'assisted', 'external'].includes(mode)) invalid('可行性必須填 pending、auto、assisted 或 external。');
      var notes = [['roles', '裝置角色'], ['prerequisites', '前置條件'], ['expected', '驗收條件'], ['notes', '步驟']]
        .filter(function (pair) { return get(pair[0]); }).map(function (pair) { return pair[1] + '\n' + get(pair[0]); }).join('\n\n');
      var flow = get('flow'), matching = flows.filter(function (item) { return item.name === flow; });
      if (flow && matching.length !== 1) invalid('flow 必須是唯一且已儲存的流程名稱。');
      if (notes.length > 4000 || get('toolsfolder').length > 4096) invalid('測項說明或資料夾路徑超過上限。');
      return { code: code, title: title, notes: notes, feasibility: mode, usbCount: Number(usb), serials: selected.join(', '),
        flowId: flow ? matching[0].id : '', toolsFolder: get('toolsfolder') };
    });
  }
  root.TerminalGridTestCases = { parse: parse, serials: serials, defaults: defaults, makeDefault: makeDefault, createApFlow: createApFlow,
    usbDevices: usbDevices, chooseDevices: chooseDevices };
}(typeof window === 'undefined' ? globalThis : window));
