(function (root) {
  'use strict';
  var guide = {
    version: '3.19.2', updated: '2026-11-20',
    sections: [
      { name: '本版更新', paragraphs: [
        ['Default 自動帶入設定', '開啟 NAN 或 AP 範本會偵測已授權的 USB 手機。從下拉選單確認一次後，仍在線的裝置會照上次角色帶入；若缺少其中一台，請重新選擇。ADB 資料夾、iperf 執行檔，以及 AP 測試參數會在本機保留。'],
        ['Default 測項選單', '從「自動化 → 本機測項（TC）」選 Default 範本。內建 NAN／NDP IPv6 Ping、Ping 後選擇傳輸、iperf3、iperf 2、Quick Share、重插重建，以及 AP 連線與斷線八項。設定裝置後會建立可編輯的本機測項、流程和工作區。按預檢執行或加入批次佇列才會啟動測試。'],
        ['Default 所需的人工操作', '請依提示建立或重建 NDP、選擇 Quick Share 測試檔，或切換 AP。固定 iperf 預設傳送 1.3 GB，兩端需準備相符版本。AP 需 Python 3.9+，用 ADB 檢查 SSID／BSSID 或確認 Wi-Fi 開啟但未連線。移動程式資料夾或換電腦後，請重新建立 AP 範本以更新本機路徑。'],
        ['批次續跑與收證', '本機測項可預覽匯入 UTF-8 CSV 或 TSV。勾選測項後按順序預檢、預覽並執行；失敗或取消時停止。可在每題前後加入手機 Log 提示，為各終端指定同一個資料夾並各自保存逐行時間戳 Log。'],
        ['流量中操作', '在 NAN 精靈填入 iperf 傳輸中的操作，第一筆區間輸出到達後依提示按開始與完成。流程記錄操作前、中、後收到的樣本；傳輸提早結束會停止這個檢查點。'],
        ['AP 狀態檢查', '隨包 tools/wait_wifi_ap.py 檢查指定手機的連線或斷線狀態。可選用本機測試腳本切換 AP，或手動切換後由流程等候成功。'],
        ['本機測項（TC）', '從「自動化」開啟本機測項，貼上純文字敘述與驗收條件，再連結已儲存流程。指定最少 USB 台數或必要序號時，預檢會以 ADB 能辨識為 USB 的已授權裝置核對。陳述與分類儲存在本機設定，執行前仍會預覽流程。'],
        ['Ping 成功後選擇傳輸', 'NAN／NDP 精靈預設收到本次 DUT2 的 IPv6 Ping 回覆後，才顯示 iperf3、iperf 2 與 Quick Share。預設 1.3 GB（1,300,000,000 bytes）。iperf 選項會啟動 DUT1 Server，確認監聽後從 DUT2 傳輸，完成時停止該 Server。Quick Share 請在手機選檔並確認收件。'],
        ['Python 雙機驗證', '精靈可勾選「先執行 Python 雙機驗證」。指定 Python 3.9 以上的執行檔，或留空使用 PATH。GUI 會呼叫隨包附上的 tools/nan_verify.py，讀取兩端 Aware 介面並由 DUT2 發出兩個 Ping 封包。'],
        ['由 IPv6 產生 DUT2 指令', '資料暫存中對 DUT1 的最新 IPv6 按右鍵，選產生 ping6 或 iperf3，再選已進入 DUT2 adb shell 的終端。scope 來自 DUT2 最近查詢，iperf3 預填 -f m -n 1300M。填入輸入列後按 Enter 送出。'],
        ['最近查詢與歷史', '資料暫存依終端分組。辨識到 ifconfig、ip addr 或 ipconfig 查詢時，該終端舊值轉入歷史區。重新讀到介面時也會更新該介面的記錄。補全與 DUT2 產生器使用最近結果，NDP 重建後請重新查詢。'],
        ['收藏與釘選', '終端完整右鍵選單的「存到我的常用…」可收藏框選文字。指令庫按 ☆ 釘選，終端選單頂端最多顯示 15 個釘選項目，其餘可從指令庫取用。'],
        ['Pull 記住下載位置', '/data/debuglogger 與 /sdcard/log 分別記住上次套用的本機資料夾。參數視窗顯示裝置、手機來源和本機目的地，按套用後保存位置。'],
        ['截圖附完成證據', 'F8 顯示完成摘要、中斷／錯誤或輸出不足，附對應 Log 節錄。有可辨識的有效摘要時帶入吞吐量，PASS／FAIL 由你依 TC 選擇。'],
        ['直接新增指令或文字片段', '在任何 Default 指令包按「＋ 新增指令」即可存到「我的常用」。類型選「文字片段」，可以原樣插入 %aware_data0、設備別名等單行文字。'],
        ['Wi-Fi Aware 介面擷取', '建立 NDP 後，在發送端手機終端執行 ifconfig 或 ip addr。資料暫存會顯示 %aware_data0 等介面及來源。可複製、拖入或右鍵存成常用文字片段。'],
        ['IPv6 scope 補全', '在 IPv6 後鍵入 %，用 Tab 套用建議，或按 Ctrl+Space 選擇。本格來源優先。連線重建後可再次查詢，確認選的是發送端介面。'],
        ['ADB 抓 Log', '從更多開啟「ADB 抓 Log」。選已授權裝置，直接修改預填的 /data/debuglogger/ 或 /sdcard/log，或按「瀏覽手機」選檔案／資料夾。本機目的路徑可輸入或選資料夾。插入後按終端 Enter 開始下載。'],
        ['終端 Log 保留', '切換 IPv6 自動擷取時會保留近期終端輸出和手動標記。'],
        ['手機控制／scrcpy', '在更多選「手機控制／scrcpy」，選已授權的裝置後可開啟獨立鏡像或喚醒螢幕。可選含 adb.exe 與 scrcpy.exe 的資料夾。App 搜尋與 SysDump 也在這個視窗。'],
        ['Samsung SysDump', '選「將 *#9900# 帶入撥號器」，再看手機是否進入 SysDump。如果只開了撥號畫面，在 Samsung 電話鍵盤清空後手動鍵入 *#9900#。完成 Run dumpstate/logcat 與 Copy to sd card 後可 Pull /sdcard/log。'],
        ['智慧指令建議', '從指令庫、本次歷史與資料暫存找出可用建議。輸入 ipref3 可選 iperf3。框選指令的一部分後按 Ctrl+Space，可只替換選取的字。'],
        ['可跳欄位的範本', '在輸入列或草稿鍵入 iperf3，再按 Ctrl+Space 選 client 範本。先填主機位址，按 Tab 填秒數，Shift+Tab 回前一欄。'],
        ['快速截圖與 Log', '選取終端按 F8，填 Excel 工作表、TC、PASS／FAIL。自動帶入可辨識的 iperf 吞吐量與完成證據，儲存到資料目錄的 evidence，以同名 PNG 和 .log 配對。'],
        ['錄製、搜尋與標記', '終端完整選單可開啟「檢視／匯出終端 Log」，開始錄製後將原始輸出化為檔案記錄，並可在近期文字中搜尋、加入標記及清除畫面。錄製檔位於 terminal-logs。'],
        ['流程進度與結果', '設定等待輸出、失敗文字、正常退出、逾時與延長等待次數。每次流程將摘要寫至 runs，失敗時標出步驟。文字條件比對完整輸出行。'],
        ['NAN／NDP 驗收', '先選含 adb.exe 的資料夾並核對兩台序號。已有兩個鏡像時可勾選「使用已開啟的 scrcpy 視窗」。人工檢查點可放在啟動 Wi-Fi Aware 前、建立 NDP 前、Ping 成功且尚未傳輸時及傳輸完成後。介面填 auto 時，流程會在建立 NDP 後偵測兩端介面，再以 DUT1 IPv6 和 DUT2 scope 執行。可加入中斷、重插與重建。'],
        ['參數帶入整個流程', '可在執行前套用同名參數；若兩個步驟需要不同值，請在參數視窗取消勾選。可選項來自已授權手機、本機網卡、暫存與終端啟動資料夾。'],
        ['拖曳換格與跨區移動', '拖曳格子標題交換整格；拖曳分頁加入另一格。右鍵標題或分頁可複製設定、剪下貼上、選擇工作區／格子與關閉分頁。移動保留執行程序與畫面。'],
        ['框選後直接改字／刪字', 'CMD、PowerShell、可辨識的 Android mksh 提示字元可編輯未送出的字串。含組合字、表情符號或自訂提示字元請用輸入列／草稿。'],
        ['BAT 拖入即執行', '把本機 .bat／.cmd 拖到某一格，在該格新增 CMD 分頁並直接執行原檔；也可從更多或每格 ⋯ 選檔執行。'],
        ['說明隨版本更新', '本視窗提供本版功能、檔案規則、快捷鍵與更新方式，離線也能閱讀。'],
        ['保留原本的工作配置', '更新沿用本機工作區、自建指令與流程；內建 Default 包更新，不覆蓋個人包。']
      ] },
      { name: '操作規則', paragraphs: [
        ['選 ADB 資料夾', '偵測不到 adb.exe 時，選含 adb.exe 的 Platform Tools 或 scrcpy 資料夾。請解鎖手機並允許 USB 偵錯；/data/debuglogger/ 是否可讀取由手機權限決定。'],
        ['.bat／.cmd：執行原檔', '拖到哪格就在那格新增分頁，以檔名命名。拖到空白區使用目前工作區選取的格子，沒有選取時用第 01 格。多檔各開一頁獨立執行，容量不足則不開始。'],
        ['BAT 的工作目錄與等待', '使用原檔所在的本機資料夾，不改寫或逐行拆解腳本；變數、迴圈、相對路徑與 pause 由 CMD 處理。pause 請點終端按鍵；結束後保留輸出。網路分享上的 BAT 請先複製到本機。'],
        ['BAT 的保存與重跑', '保存的是原檔路徑，原檔移動後需重新選檔。重開程式只載入配置；手動按該分頁「啟動／重新啟動」才重跑。齒輪設定可改路徑，或清除路徑恢復一般終端。'],
        ['.tgridflow：JSON 流程資料', '包含工作區排列、終端設定與流程步驟，可用文字編輯器查看。匯入／拖入後先檢視，再按執行。可指定多格啟動、輸入、等待秒數、人工等待與停止；人工等待完成後按「繼續」。'],
        ['流程與 BAT 搭配', '流程可啟動已設定 BAT 的分頁，但「啟動終端」不等於等待 BAT 完成；需要先後順序時加入人工等待。匯出流程只攜帶 BAT 路徑，分享時須另附 BAT 與相關檔案。'],
        ['.tgridcmd：指令包資料', '匯入後加入個人指令庫，不會執行。插入或拖曳指令只填入文字，由使用者按 Enter；DEVICE_SERIAL、IP 與路徑範本會先開選擇視窗。'],
        ['工作區與分頁', '上方 ＋ 新工作區建立另一套網格；每格 ＋ 新增同格終端。最多 12 個工作區、每區 16 格、每格 8 頁、同時 64 個終端。縮小格數會保留隱藏格。'],
        ['複製與移動的範圍', '複製設定會新建尚未啟動的分頁，使用已設定的啟動資料夾；不會讀取 shell 中臨時 cd 的路徑。移動保留原程序、目前目錄、輸出及輸入列。最後一頁移走或關閉後，原格補一個空白終端。'],
        ['移動與自動化', '同工作區移動會更新已存流程的終端目標；被流程引用的分頁需先修改流程目標，才能跨工作區移動，也可改用複製。流程執行、啟動／停止或對話框操作期間請先完成再移動。'],
        ['NAN／裝置檔案', '更多可開 NAN／NDP 雙手機流程及裝置檔案 cfg／Logs。NAN 流程依提示操作手機；cfg 編輯寫回先備份再驗證，一般 Push 不自動備份。']
      ] },
      { name: '快捷鍵', shortcuts: [
        ['Ctrl+Space', '開啟補全清單。↑／↓ 選擇，Tab 套用，Esc 關閉。手動開啟的清單也可按 Enter 套用。'],
        ['Tab / Shift+Tab', '在輸入列／草稿的指令範本中跳到下一欄／上一欄。'],
        ['Ctrl+C', '終端有選取時複製；沒有選取時送出中斷，例如停止 Ping。'],
        ['Ctrl+Shift+C', '複製終端選取文字。'],
        ['Ctrl+V / Ctrl+Shift+V / Shift+Insert', '貼上到終端游標；多行貼上會先確認。'],
        ['右鍵', '快速模式：有選取就複製並解除選取，無選取就貼上。更多可切回一般選單。'],
        ['Shift+右鍵 / Shift+F10', '開啟完整終端選單；每格 ⋯ 亦可開啟。'],
        ['Backspace / Delete', '框選目前可辨識的指令字串時原位刪除；歷史輸出不能編輯。'],
        ['F8', '保存當前終端截圖及文字 Log。PASS／FAIL 由測試者填寫，程式另顯示找到的完成證據。'],
        ['Ctrl＋點格子標題', '選取多格，再右鍵剪下／複製所選格各一個作用中分頁；Esc 清除選取。'],
        ['Ctrl+Z', '格子標題或工具列上復原布局操作。關閉後只復原分頁設定。'],
        ['框選後直接打字', '取代目前指令選取內容。Android mksh 可用 Home／End、Ctrl+←／→ 移動游標。'],
        ['標題／分頁右鍵', '管理分頁的複製、剪下、跨工作區移動與關閉；終端文字區仍保留快速複貼。'],
        ['輸入列 Enter / ↑ / ↓', 'Enter 送出；↑／↓ 瀏覽本次輸入列指令紀錄。一般游標、框選、刪除與貼上皆可使用。'],
        ['Esc', '關閉選單／對話框，或離開單格放大。']
      ], paragraphs: [['原位替換範圍', '支援可辨識提示字元的單行指令，包含常用中文。組合字、表情符號及複雜互動程式請用輸入列／草稿。']] },
      { name: '更新與資料', paragraphs: [
        ['補全歷史', '本次開啟程式期間記住最多 120 筆手動送出的可辨識指令。更多選單可清除補全歷史與關閉建議。原本各格歷史仍可透過方向鍵取用。'],
        ['像更新遊戲一樣保留配置', '下載新版 ZIP 並完整解壓縮。從新資料夾執行 Update.cmd，選原本程式資料夾，更新會備份後覆蓋程式並重開；也可關閉程式後手動覆蓋原資料夾。'],
        ['哪些內容會保留', '工作區、終端分頁設定、自建指令與流程在 %LOCALAPPDATA%\\TerminalGridIntegrated\\layout.json；介面偏好在同目錄的 WebView2 資料夾。自訂 TERMINALGRID_DATA_DIR 時沿用該目錄。'],
        ['哪些內容不是永久紀錄', '執行中的程序、終端畫面輸出及本次輸入列歷史不會跨重開恢復；重要測試輸出請先另存 Log。更新需先結束執行中的測試。'],
        ['備份與原檔', '更新前備份配置及被替換的程式檔；不刪除額外檔案。BAT 原檔與手機 Log 仍在使用者選擇的位置，不會加入公開下載包。']
      ] }
    ]
  };
  guide.render = function (dialog) {
    var doc = dialog.ownerDocument, content = dialog.querySelector('.modal-content'); content.textContent = '';
    doc.getElementById('helpButton').textContent = '本版操作／快捷說明';
    doc.getElementById('helpTitle').textContent = '操作與快捷說明';
    dialog.querySelector('.eyebrow').textContent = 'TERMINAL GRID ' + guide.version + ' · ' + guide.updated;
    var nav = doc.createElement('div'); nav.className = 'help-nav'; nav.setAttribute('role', 'tablist'); content.appendChild(nav);
    var panels = [];
    guide.sections.forEach(function (section, index) {
      var button = doc.createElement('button'); button.className = 'button quiet'; button.type = 'button'; button.textContent = section.name;
      button.setAttribute('role', 'tab'); button.id = 'help-tab-' + index; button.setAttribute('aria-controls', 'help-panel-' + index); nav.appendChild(button);
      var panel = doc.createElement('section'); panel.id = 'help-panel-' + index; panel.className = 'help-panel'; panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', button.id); content.appendChild(panel); panels.push(panel);
      if (section.shortcuts) {
        var table = doc.createElement('table'); table.className = 'help-keys';
        section.shortcuts.forEach(function (row) { var tr = doc.createElement('tr'), key = doc.createElement('th'), description = doc.createElement('td'); key.scope = 'row'; key.textContent = row[0]; description.textContent = row[1]; tr.append(key, description); table.appendChild(tr); }); panel.appendChild(table);
      }
      (section.paragraphs || []).forEach(function (row) { var h = doc.createElement('h3'), p = doc.createElement('p'); h.textContent = row[0]; p.textContent = row[1]; panel.append(h, p); });
      button.addEventListener('click', function () { select(index); });
    });
    function select(index) { panels.forEach(function (panel, i) { panel.hidden = i !== index; nav.children[i].setAttribute('aria-selected', String(i === index)); nav.children[i].tabIndex = i === index ? 0 : -1; }); }
    nav.addEventListener('keydown', function (event) { if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return; event.preventDefault(); var i = Array.from(nav.children).indexOf(doc.activeElement); i = (i + (event.key === 'ArrowRight' ? 1 : -1) + panels.length) % panels.length; select(i); nav.children[i].focus(); });
    select(0);
  };
  if (typeof module === 'object' && module.exports) module.exports = guide; else root.TerminalGridHelp = guide;
}(typeof window === 'object' ? window : globalThis));
