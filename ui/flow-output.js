(function (root) {
  'use strict';
  function create() {
    var decoder = new TextDecoder(), pending = '', lines = [], escape = '', count = 0, truncated = false;
    function feed(bytes) {
      // Keep parser state across UTF-8 and ANSI chunk boundaries.
      for (var char of decoder.decode(bytes, { stream: true })) {
        if (escape === 'esc') {
          escape = char === '[' ? 'csi' : (']P^_'.includes(char) ? 'string' : '');
        } else if (escape === 'csi') {
          if (char >= '@' && char <= '~') escape = '';
        } else if (escape === 'string') {
          if (char === '\x1b') escape = 'end';
          else if (char === '\x07') escape = '';
        } else if (escape === 'end') {
          escape = char === '\\' ? '' : 'string';
        } else if (char === '\x1b') {
          escape = 'esc';
        } else if (char === '\n') {
          lines.push(pending); count += pending.length + 1; pending = '';
        } else if (char === '\b') {
          pending = pending.slice(0, -1);
        } else if (char >= ' ' || char === '\t') {
          if (pending.length < 32000) pending += char;
        }
      }
      if (count > 262144 || lines.length > 8192) {
        var remove = 0;
        while (count > 245760 || lines.length - remove > 8000) count -= lines[remove++].length + 1;
        lines.splice(0, remove); truncated = true;
      }
    }
    return {
      feed: feed,
      text: function () { return (truncated ? '[較早輸出已超過終端快取上限]\r\n' : '') + (lines.length ? lines.join('\r\n') + '\r\n' : '') + pending; },
      hasPingReply: function () {
        return lines.some(function (line) { return /^\s*[1-9]\d* bytes from\s+\S+.*\b(?:icmp_)?seq[= ]\d+/i.test(line); });
      },
      hasLine: function (text) {
        return lines.some(function (line) { return line.trim() === text; });
      },
      match: function (literal, sent) {
        if (!literal) return false;
        return lines.some(function (line) {
          if (!line.includes(literal)) return false;
          // Windows and Android shell prompts may precede the echoed command.
          return !sent || !line.trimEnd().endsWith(sent.trimEnd());
        });
      }
    };
  }
  function iperfResult(text) {
    var result = '', completed = '', error = '', awaitingReport = false, iperf2 = false;
    var aggregate = false, streams = new Set(), evidence = [], recent = [], totals = new Map();
    function remember(line) { evidence.push(line.trim().slice(0, 1000)); evidence = evidence.slice(-8); }
    for (var rawLine of text.split(/\r?\n/)) {
      var line = rawLine.trim();
      var command = /(?:^|[>#$]|shell:)\s*(?:.*?\s)?(?:"[^"]*[\\/]|[^\s]*[\\/])?(iperf3?)(?:\.exe)?"?(?=\s).*\s(?:-c\s|--client(?:\s|=))/i.exec(line);
      if (command || /^(?:Connecting to host|Client connecting to|Accepted connection from)\b/i.test(line)) {
        result = ''; completed = ''; error = ''; awaitingReport = false; aggregate = false;
        streams.clear(); totals.clear(); evidence = []; recent = [];
        iperf2 = command ? command[1].toLowerCase() === 'iperf' : /^Client connecting to\b/i.test(line);
      }
      if (line) { recent.push(line.slice(0, 1000)); recent = recent.slice(-4); }
      if (/iperf3?: error|connection refused|network is unreachable|broken pipe|interrupt(?:ed|ion)|connection reset by peer|unable to connect|^\^C$|(?:command )?not found|not recognized as an internal/i.test(line)) {
        result = ''; completed = ''; awaitingReport = false; error = line.slice(0, 200);
        evidence = []; remember(line); continue;
      }
      if (error) continue;
      // Require an actual iperf report row and a nonzero measured interval.
      var row = /^\[\s*(SUM|\d+)\]\s+(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s+sec\b.*?\b(\d+(?:\.\d+)?\s+[KMGT]?bits\/sec)\b/i.exec(line);
      var summary = row && Number(row[2]) === 0 && Number(row[3]) > 0;
      if (summary && (/\breceiver\s*$/i.test(line) || awaitingReport)) {
        var sum = row[1].toUpperCase() === 'SUM';
        if (sum || !aggregate) result = row[4];
        if (!sum) streams.add(row[1]);
        aggregate = aggregate || sum;
        completed = awaitingReport ? 'iperf 伺服器回報' : 'iperf3 receiver 摘要';
        remember(line);
        // iperf 2 can report multiple streams after Server Report.
      } else if (/^iperf Done\.$/i.test(line)) {
        completed = completed || 'iperf Done. 完成訊息'; remember(line);
      } else if (/^Server Report:$/i.test(line)) {
        awaitingReport = true; iperf2 = true; remember(line);
      }
      if (iperf2 && summary) totals.set(row[1].toUpperCase(), { rate: row[4], line: line });
      if (!completed && iperf2 && totals.size && /^(?:PS )?(?:[A-Za-z]:\\|\\\\)[^>]*>\s*$|^[\w.-]+:\/.* [#$]\s*$/.test(line)) {
        var total = totals.get('SUM') || (totals.size === 1 ? totals.values().next().value : null);
        completed = 'iperf 累計速率及返回提示字元';
        if (total) { result = total.rate; remember(total.line); }
        else totals.forEach(function (item) { remember(item.line); });
        remember(line);
      }
    }
    var incompleteAggregate = streams.size > 1 && !aggregate;
    if (incompleteAggregate) result = '';
    var state = error ? 'interrupted' : completed ? 'completed' : 'insufficient';
    var status = error ? '找到中斷／錯誤訊息 · 輸出有錯誤 · ' + error : completed ? '找到完成摘要 · ' + completed : '輸出不足 · 未找到 iperf 完成摘要';
    if (incompleteAggregate) status += ' · 多條串流缺少 SUM，吞吐量請核對 Log';
    return { rate: result, state: state, status: status, lines: evidence.length ? evidence : recent };
  }
  root.TerminalGridFlowOutput = { create: create, iperfResult: iperfResult };
}(typeof window === 'undefined' ? globalThis : window));
