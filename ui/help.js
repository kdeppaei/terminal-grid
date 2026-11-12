(function (root) {
  'use strict';
  var guide = {
    version: '3.11.0', updated: '2026-11-13',
    sections: [
      { name: '本版更新', paragraphs: [
        ['拖曳換格與跨區移動', '拖曳格子標題交換整格；拖曳分頁加入另一格。右鍵標題或分頁可複製設定、剪下貼上、選擇工作區／格子與關閉分頁。移動保留執行程序與畫面。'],
        ['框選後直接改字／刪字', '框選目前尚未送出的 CMD／PowerShell 英文、數字、符號，可直接打字、貼上或按 Backspace／Delete。修正刪除後殘留擦除空白阻擋下一次編輯；歷史輸出仍不可修改。'],
        ['BAT 拖入即執行', '把本機 .bat／.cmd 拖到某一格，在該格新增 CMD 分頁並直接執行原檔；也可從更多或每格 ⋯ 選檔執行。'],
        ['說明隨版本更新', '本視窗提供本版功能、檔案規則、快捷鍵與更新方式，離線也能閱讀。'],
        ['保留原本的工作配置', '更新沿用本機工作區、自建指令與流程；內建 Default 包更新，不覆蓋個人包。']
      ] },
      { name: '操作規則', paragraphs: [
        ['.bat／.cmd：執行原檔', '拖到哪格就在那格新增分頁，以檔名命名。拖到空白區使用目前工作區選取的格子，沒有選取時用第 01 格。多檔各開一頁獨立執行，容量不足則不開始。'],
        ['BAT 的工作目錄與等待', '使用原檔所在的本機資料夾，不改寫或逐行拆解腳本；變數、迴圈、相對路徑與 pause 由 CMD 處理。pause 請點終端按鍵；結束後保留輸出。網路分享上的 BAT 請先複製到本機。'],
        ['BAT 的保存與重跑', '保存的是原檔路徑，原檔移動後需重新選檔。重開程式只載入配置；手動按該分頁「啟動／重新啟動」才重跑。齒輪設定可改路徑，或清除路徑恢復一般終端。'],
        ['.tgridflow：JSON 流程資料', '包含工作區排列、終端設定與流程步驟，可用文字編輯器查看。匯入／拖入後先檢視，再按執行。可指定多格啟動、輸入、等待秒數、人工等待與停止；人工等待完成後按「繼續」。'],
        ['流程與 BAT 搭配', '流程可啟動已設定 BAT 的分頁，但「啟動終端」不等於等待 BAT 完成；需要先後順序時加入人工等待。匯出流程只攜帶 BAT 路徑，分享時須另附 BAT 與相關檔案。'],
        ['.tgridcmd：指令包資料', '匯入後加入個人指令庫，不會執行。插入或拖曳指令只填入文字，由使用者按 Enter；DEVICE_SERIAL、IP 與路徑範本會先開選擇視窗。'],
        ['工作區與分頁', '上方 ＋ 新工作區建立另一套網格；每格 ＋ 新增同格終端。最多 12 個工作區、每區 16 格、每格 8 頁、同時 64 個終端。縮小格數會保留隱藏格。'],
        ['複製與移動的範圍', '複製設定會新建尚未啟動的分頁，使用已設定的啟動資料夾；不會讀取 shell 中臨時 cd 的路徑。移動保留原程序、目前目錄、輸出及輸入列。最後一頁移走或關閉後，原格補一個空白終端。'],
        ['移動與自動化', '同工作區移動會更新已存流程的終端目標；被流程引用的分頁需先修改流程目標，才能跨工作區移動，也可改用複製。流程執行、啟動／停止或對話框操作期間請先完成再移動。'],
        ['NAN／裝置檔案', '更多可開 NAN／NDP 雙手機流程及裝置檔案 cfg／Logs。NAN 流程依提示人工操作 APK；cfg 編輯寫回先備份再驗證，一般 Push 不自動備份。']
      ] },
      { name: '快捷鍵', shortcuts: [
        ['Ctrl+C', '終端有選取時複製；沒有選取時送出中斷，例如停止 Ping。'],
        ['Ctrl+Shift+C', '複製終端選取文字。'],
        ['Ctrl+V / Ctrl+Shift+V / Shift+Insert', '貼上到終端游標；多行貼上會先確認。'],
        ['右鍵', '快速模式：有選取就複製並解除選取，無選取就貼上。更多可切回一般選單。'],
        ['Shift+右鍵 / Shift+F10', '開啟完整終端選單；每格 ⋯ 亦可開啟。'],
        ['Backspace / Delete', '框選目前可辨識的指令字串時原位刪除；歷史輸出不能編輯。'],
        ['框選後直接打字', '取代目前指令選取內容，不按 Enter；含中文指令或 Android shell 請使用下方輸入列／草稿編輯。'],
        ['標題／分頁右鍵', '管理分頁的複製、剪下、跨工作區移動與關閉；終端文字區仍保留快速複貼。'],
        ['輸入列 Enter / ↑ / ↓', 'Enter 送出；↑／↓ 瀏覽本次輸入列指令紀錄。一般游標、框選、刪除與貼上皆可使用。'],
        ['Esc', '關閉選單／對話框，或離開單格放大。']
      ], paragraphs: [['原位替換範圍', '目前支援一般 CMD／PowerShell 提示字元的單行 ASCII 指令；複雜互動程式、歷史輸出或含非 ASCII 指令請用輸入列／草稿。更多可顯示或隱藏輸入列。']] },
      { name: '更新與資料', paragraphs: [
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
