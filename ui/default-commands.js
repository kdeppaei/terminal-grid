(function (root) {
  'use strict';
  // Built-in reference templates are separate from editable/exported user packs.
  var packs = [];
  function prepare(text) {
    return text.replace(/\bDEVICE_SERIAL\b/g, '{{SERIAL}}').replace(/\b192\.0\.2\.10\b/g, '{{TARGET_IPV4}}')
      .replace(/\b192\.0\.2\.20\b/g, '{{LOCAL_IPV4}}').replace(/2001:db8::10\b/g, '{{TARGET_IPV6}}')
      .replace(/\bSERVER_IP\b/g, '{{TARGET_IP}}').replace(/\bLOCAL_IP\b/g, '{{LOCAL_IP}}').replace(/\bDEVICE_IP\b/g, '{{TARGET_IP}}');
  }
  function pack(id, name, rows) {
    packs.push({ id: '@default-' + id, name: 'Default · ' + name, builtin: true,
      commands: rows.map(function (r, i) { return { id: id + '-' + i, name: r[0], command: prepare(r[1]), description: r[2] }; }) });
  }
  pack('adb-basic', 'ADB／常用', [
    ['版本與說明', 'adb version', '需先安裝 Android Platform Tools 並加入 PATH。'],
    ['裝置清單', 'adb devices -l', '確認序號、device／unauthorized 狀態。'],
    ['安裝 APK（選檔）', 'adb -s {{SERIAL}} install {{APK_FILE}}', '選本機 APK；手機需允許 USB 偵錯。'],
    ['覆蓋安裝 APK（保留資料）', 'adb -s {{SERIAL}} install -r {{APK_FILE}}', '選 APK；簽章需相容，保留既有 app 資料。'],
    ['Push 檔案／資料夾', 'adb -s {{SERIAL}} push {{LOCAL_SOURCE}} {{REMOTE_PATH}}', '選本機來源，填裝置目的路徑；可能覆寫同名檔案。'],
    ['Pull 檔案／資料夾', 'adb -s {{SERIAL}} pull {{REMOTE_PATH}} {{LOCAL_FOLDER}}', '填裝置來源，選本機目的資料夾；可能覆寫同名檔案。'],
    ['Android 版本', 'adb -s DEVICE_SERIAL shell getprop ro.build.version.release', '將 DEVICE_SERIAL 換成 adb devices 的序號。'],
    ['Build fingerprint', 'adb -s DEVICE_SERIAL shell getprop ro.build.fingerprint', '記錄測試韌體版本。'],
    ['即時 logcat', 'adb -s DEVICE_SERIAL logcat -v threadtime', '持續輸出，Ctrl+C 結束。'],
    ['儲存 logcat', 'adb -s DEVICE_SERIAL logcat -d -v threadtime > logcat.txt', 'CMD／PowerShell；將目前 buffer 存到工作目錄，覆寫同名檔。'],
    ['Bugreport（選目的資料夾）', 'adb -s {{SERIAL}} bugreport {{LOCAL_FOLDER}}', '擷取診斷資訊，可能耗時，包含裝置紀錄。'],
    ['IP 與 IPv6', 'adb -s DEVICE_SERIAL shell ip addr', '查詢介面；可配合資料暫存擷取 IPv6。']
  ]);
  pack('adb-advanced', 'ADB／進階', [
    ['無線偵錯配對', 'adb pair 192.0.2.10:37123', 'Android 11+ 無線偵錯；改成手機顯示的配對 IP／port，互動輸入配對碼。'],
    ['連接無線裝置', 'adb connect 192.0.2.10:42123', '改成手機顯示的偵錯 IP／port，與配對 port 不同。'],
    ['中斷指定無線裝置', 'adb disconnect 192.0.2.10:42123', '修改成目標 IP／port。'],
    ['App 清單', 'adb -s DEVICE_SERIAL shell pm list packages -3', '列出第三方 package 名稱。'],
    ['App 資訊', 'adb -s DEVICE_SERIAL shell dumpsys package PACKAGE_NAME', '替換 package 名稱。'],
    ['App 記憶體', 'adb -s DEVICE_SERIAL shell dumpsys meminfo PACKAGE_NAME', '查看指定 app 的記憶體統計。'],
    ['App 畫面效能', 'adb -s DEVICE_SERIAL shell dumpsys gfxinfo PACKAGE_NAME framestats', '查看繪圖／frame 統計，依 Android 版本而異。'],
    ['Activity 狀態', 'adb -s DEVICE_SERIAL shell dumpsys activity activities', '查詢目前 Activity。'],
    ['Wi-Fi 診斷', 'adb -s DEVICE_SERIAL shell dumpsys wifi', '依廠商與系統版本可能限制資訊。'],
    ['裝置截圖', 'adb -s DEVICE_SERIAL shell screencap -p /sdcard/sqa-screen.png', '寫到裝置；接著用 Pull 取回。'],
    ['裝置錄影', 'adb -s DEVICE_SERIAL shell screenrecord --time-limit 30 /sdcard/sqa-video.mp4', '錄製 30 秒到裝置；接著用 Pull 取回。'],
    ['Port forward', 'adb -s DEVICE_SERIAL forward tcp:8080 tcp:8080', '建立本機到裝置的轉送；需確認 port 可用。'],
    ['移除指定 forward', 'adb -s DEVICE_SERIAL forward --remove tcp:8080', '只移除本機 8080 的轉送。'],
    ['啟動 Activity', 'adb -s DEVICE_SERIAL shell am start -W -n PACKAGE_NAME/ACTIVITY_NAME', '換成有效 component；會啟動 app 並回報耗時。'],
    ['強制停止 App', 'adb -s DEVICE_SERIAL shell am force-stop PACKAGE_NAME', '會中斷目標 app 的執行，請先確認 package。']
  ]);
  pack('scrcpy-basic', 'scrcpy／常用', [
    ['版本', 'scrcpy --version', '需另行安裝 scrcpy；裝置需允許 ADB 偵錯。'],
    ['指定裝置鏡像', 'scrcpy -s DEVICE_SERIAL', '多裝置時指定序號；鏡像視窗由 scrcpy 開啟。'],
    ['選唯一 USB 裝置', 'scrcpy --select-usb', '僅有一個 USB 裝置時適用。'],
    ['選唯一 TCP/IP 裝置', 'scrcpy --select-tcpip', '先透過 adb connect 連線。'],
    ['限制解析度', 'scrcpy -s DEVICE_SERIAL --max-size=1280', '限制長邊，降低編碼與傳輸負載。'],
    ['限制 FPS', 'scrcpy -s DEVICE_SERIAL --max-fps=30', '最高 30 FPS；實際取決於裝置。'],
    ['設定碼率', 'scrcpy -s DEVICE_SERIAL --video-bit-rate=4M', '4 Mbps 視訊碼率。'],
    ['關閉音訊', 'scrcpy -s DEVICE_SERIAL --no-audio', '只鏡像畫面。']
  ]);
  pack('scrcpy-advanced', 'scrcpy／進階', [
    ['錄影（選目的資料夾）', 'scrcpy -s {{SERIAL}} --record={{LOCAL_FOLDER}}/sqa-record.mp4', '錄影含可用音訊；Ctrl+C 結束，先確認同名檔。'],
    ['只錄視訊', 'scrcpy -s {{SERIAL}} --no-audio --record={{LOCAL_FOLDER}}/sqa-video.mkv', '選錄影目的資料夾。'],
    ['唯讀鏡像', 'scrcpy -s DEVICE_SERIAL --no-control', '禁止從電腦控制手機。'],
    ['關閉手機螢幕', 'scrcpy -s DEVICE_SERIAL --turn-screen-off', '裝置畫面關閉，鏡像持續；依裝置支援。'],
    ['保持喚醒', 'scrcpy -s DEVICE_SERIAL --stay-awake', '連接電源時保持喚醒。'],
    ['H.265 編碼', 'scrcpy -s DEVICE_SERIAL --video-codec=h265', '需要裝置有對應 encoder。'],
    ['列出編碼器', 'scrcpy -s DEVICE_SERIAL --list-encoders', '依裝置查詢可用影音 encoder。'],
    ['裁切畫面', 'scrcpy -s DEVICE_SERIAL --crop=1080:960:0:0', 'width:height:x:y，請依裝置尺寸調整。']
  ]);
  pack('iperf2-basic', 'iperf 2／常用', [
    ['版本', 'iperf --version', 'iperf 2 與 iperf3 不互通；兩端需使用相同系列。'],
    ['TCP Server', 'iperf -s -p 5001', '伺服端；Ctrl+C 停止，確認防火牆允許測試。'],
    ['TCP Client', 'iperf -c 192.0.2.10 -p 5001 -t 30 -i 1', '替換 server IP；每秒報告，持續 30 秒。'],
    ['UDP Server', 'iperf -s -u -p 5001', 'iperf 2 的 UDP server 需加 -u。'],
    ['UDP Client 10M', 'iperf -c 192.0.2.10 -u -b 10M -t 30 -i 1', '目標 10 Mbps；兩端皆需 UDP 模式。'],
    ['四條 TCP stream', 'iperf -c 192.0.2.10 -P 4 -t 30 -i 1', '四條並行串流可能增加負載。']
  ]);
  pack('iperf2-advanced', 'iperf 2／進階', [
    ['同時雙向', 'iperf -c 192.0.2.10 -d -t 30 -i 1', '雙向測試需 client 也能接受反向連線。'],
    ['輪流雙向', 'iperf -c 192.0.2.10 -r -t 30 -i 1', '先正向再反向，需確認防火牆。'],
    ['綁定本機 IP', 'iperf -c 192.0.2.10 -B 192.0.2.20 -t 30', '兩個位址皆需改成實際 server／本機介面。'],
    ['IPv6', 'iperf -V -c 2001:db8::10 -t 30 -i 1', 'server 也需 IPv6；link-local 請使用正確 scope。'],
    ['UDP datagram 1200 bytes', 'iperf -c 192.0.2.10 -u -b 10M -l 1200 -t 30', '依 MTU 與測試需求調整。'],
    ['加強統計', 'iperf -c 192.0.2.10 -e -t 30 -i 1', '需要支援 enhanced reporting 的 iperf 2 版本。']
  ]);
  pack('iperf3-basic', 'iperf3／常用', [
    ['版本', 'iperf3 --version', '兩端使用 iperf3，與 iperf 2 不互通。'],
    ['Server', 'iperf3 -s -p 5201', 'TCP／UDP 測試共用 server，Ctrl+C 停止。'],
    ['TCP Client', 'iperf3 -c 192.0.2.10 -p 5201 -t 30 -i 1', '替換 server IP，測試 30 秒。'],
    ['反向 TCP', 'iperf3 -c 192.0.2.10 -R -t 30 -i 1', '由 server 傳送到 client。'],
    ['UDP Client 10M', 'iperf3 -c 192.0.2.10 -u -b 10M -t 30 -i 1', '控制通道仍需 TCP 5201，資料使用 UDP。'],
    ['四條並行 TCP', 'iperf3 -c 192.0.2.10 -P 4 -t 30 -i 1', '四條並行 stream。']
  ]);
  pack('iperf3-advanced', 'iperf3／進階', [
    ['同時雙向', 'iperf3 -c 192.0.2.10 --bidir -t 30 -i 1', '需要雙方版本支援 --bidir；先查 --help。'],
    ['IPv6', 'iperf3 -6 -c 2001:db8::10 -t 30 -i 1', '替換 IPv6；link-local 請補 scope。'],
    ['綁定本機 IP', 'iperf3 -c 192.0.2.10 -B 192.0.2.20 -t 30', '修改 server 與本機介面 IP。'],
    ['JSON 報告', 'iperf3 -c 192.0.2.10 -t 30 -J > iperf3-result.json', 'CMD／PowerShell；結束後輸出 JSON，覆寫同名檔。'],
    ['排除暖機', 'iperf3 -c 192.0.2.10 -O 3 -t 30 -i 1', '省略前 3 秒的統計。'],
    ['UDP datagram 1200 bytes', 'iperf3 -c 192.0.2.10 -u -b 10M -l 1200 -t 30', '依 MTU 調整，避免分片影響。'],
    ['只服務一次', 'iperf3 -s -1', '完成一個 client 測試後 server 結束。'],
    ['TCP window', 'iperf3 -c 192.0.2.10 -w 256K -t 30', '設定 socket buffer，實際上限受 OS 限制。']
  ]);
  pack('network-basic', 'Windows 網路／常用', [
    ['網路介面', 'ipconfig /all', 'Windows CMD／PowerShell。'],
    ['IPv4 Ping（自選 IP）', 'ping -n 10 192.0.2.10', '插入時可直接選擇已偵測的 IPv4；也可手動輸入，送 10 次。'],
    ['IPv6 Ping（自選 IP／介面）', 'ping -6 -n 10 2001:db8::10', '插入時可選 IPv6；link-local 會自動帶 Windows IPv6 介面 scope（例如 %12），清單同時顯示 WLAN／LAN 名稱。'],
    ['路由表', 'route print', '查詢路由，不修改設定。'],
    ['DNS 查詢', 'nslookup example.com', '替換測試網域。'],
    ['路由追蹤', 'tracert -d 192.0.2.10', '不反查 DNS。']
  ]);
  pack('network-advanced', 'Windows 網路／進階', [
    ['TCP port', 'Test-NetConnection 192.0.2.10 -Port 5201', '僅 PowerShell；替換目標 IP／port。'],
    ['TCP 連線', 'Get-NetTCPConnection', '僅 PowerShell；查看 TCP 狀態。'],
    ['介面統計', 'Get-NetAdapterStatistics', '僅 PowerShell。'],
    ['鄰居表', 'Get-NetNeighbor', '僅 PowerShell；查看 IPv4／IPv6 鄰居。'],
    ['監聽 port 與 PID', 'netstat -ano', 'Windows CMD／PowerShell。'],
    ['介面 MTU', 'netsh interface ipv4 show subinterfaces', '只查詢，不修改 MTU。']
  ]);
  var fields = {
    SERIAL: ['ADB 裝置序號', 'device', ''], APK_FILE: ['本機 APK', 'apk', ''],
    TARGET_IP: ['遠端目標 IP', 'ip', ''], TARGET_IPV4: ['遠端目標 IPv4', 'ipv4', ''], TARGET_IPV6: ['遠端目標 IPv6（含 scope）', 'ipv6', ''],
    LOCAL_IP: ['本機綁定 IP', 'local', ''], LOCAL_IPV4: ['本機綁定 IPv4', 'local4', ''],
    LOCAL_SOURCE: ['本機來源檔案／資料夾', 'source', ''], LOCAL_FOLDER: ['本機目的資料夾', 'folder', ''],
    REMOTE_PATH: ['裝置路徑', 'text', '/sdcard/Download/test.dat']
  };
  function quote(value, shell) {
    if (!value || /[\x00-\x1f\x7f"]/.test(value)) throw Error('請填入單行路徑或參數，不可含雙引號。');
    if (shell === 'PowerShell' || shell === 'PowerShell 7') return "'" + value.replace(/'/g, "''") + "'";
    if (shell !== 'CMD') throw Error('路徑範本請使用 CMD 或 PowerShell 終端。');
    if (/[%!]/.test(value)) throw Error('CMD 可能展開路徑中的 % 或 !；此路徑請改用 PowerShell。');
    // A quoted Windows directory ending in backslash needs no escaping for CMD built-ins,
    // but adb/scrcpy use CRT-style parsing: remove a trailing separator except drive roots.
    if (/\\$/.test(value)) value = value.replace(/\\+$/, '') + '\\.';
    return '"' + value + '"';
  }
  function keys(text) { return Array.from(new Set((text.match(/\{\{[A-Z][A-Z0-9_]*\}\}/g) || []).map(function (s) { return s.slice(2, -2); }))).filter(function (k) { return fields[k]; }); }
  function resolve(text, values, shell) { return text.replace(/\{\{([A-Z][A-Z0-9_]*)\}\}/g, function (_, key) { if (!fields[key]) throw Error('未知範本欄位：' + key); return quote(values[key], shell); }); }
  root.TerminalGridDefaults = { packs: packs, fields: fields, keys: keys, resolve: resolve, prepare: prepare };
}(typeof window === 'undefined' ? globalThis : window));
