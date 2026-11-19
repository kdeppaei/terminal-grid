(function (root) {
  'use strict';
  function serials(value) { return Array.from(new Set(value.split(/[\s,，]+/).filter(Boolean))); }
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
  root.TerminalGridTestCases = { parse: parse, serials: serials };
}(typeof window === 'undefined' ? globalThis : window));
