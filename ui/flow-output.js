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
    var lines = text.split(/\r?\n/), result = '', completed = '', error = '', awaitingReport = false, iperf2Total = '', aggregate = false;
    for (var line of lines) {
      if (/(?:^|[>#$]|shell:)\s*(?:.*?\s)?(?:"[^"]*[\\/]|[^\s]*[\\/])?iperf3?(?:\.exe)?"?(?=\s).*\s(?:-c\s|--client(?:\s|=))/i.test(line)
          || /^\s*(?:Connecting to host|Client connecting to)\b/i.test(line)) {
        result = ''; completed = ''; error = ''; awaitingReport = false; iperf2Total = ''; aggregate = false;
      }
      if (/iperf3?: error|connection refused|network is unreachable|broken pipe|interrupt(?:ed|ion)|connection reset by peer|unable to connect|^\s*\^C\s*$/i.test(line)) {
        result = ''; completed = ''; awaitingReport = false; error = line.trim().slice(0, 240); continue;
      }
      var rate = /([\d.,]+\s+[KMGT]?bits\/sec)\b/i.exec(line);
      if (rate && /\breceiver\s*$/i.test(line) && !error) {
        var sum = /^\s*\[SUM\]/i.test(line);
        if (sum || !aggregate) result = rate[1];
        aggregate = aggregate || sum;
        completed = '找到 iperf3 receiver 摘要';
      } else if (/^\s*iperf Done\.\s*$/i.test(line) && !error) {
        completed = completed ? completed + '及完成訊息' : '找到 iperf Done. 完成訊息';
      } else if (/Server Report:/i.test(line) && !error) {
        awaitingReport = true;
      }
      if (awaitingReport && rate) {
        completed = '找到 iperf 伺服器回報'; result = rate[1]; awaitingReport = false;
      }
      if (rate && /\b0\.0-\s*\d+\.\d+\s+sec\b/.test(line)) iperf2Total = rate[1];
      if (!completed && !error && iperf2Total && /^(?:PS )?(?:[A-Za-z]:\\|\\\\)[^>]*>\s*$|^[\w.-]+:\/.* [#$]\s*$/.test(line)) {
        completed = '已返回提示字元，找到 iperf 累計速率，請核對 Log';
        result = iperf2Total;
      }
    }
    return { rate: result, status: error ? '輸出有錯誤：' + error : (completed || '目前輸出未找到 iperf 完成摘要') };
  }
  root.TerminalGridFlowOutput = { create: create, iperfResult: iperfResult };
}(typeof window === 'undefined' ? globalThis : window));
