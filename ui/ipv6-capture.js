(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TerminalGridIPv6 = api;
}(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var MAX_LINE_LENGTH = 16384;

  function validIPv4(value) {
    var parts = value.split('.');
    return parts.length === 4 && parts.every(function (part) {
      return /^(?:0|[1-9][0-9]{0,2})$/.test(part) && Number(part) <= 255;
    });
  }

  // Return an address suitable for copying, keeping an explicit zone and removing CIDR.
  // A source interface is metadata; it is never converted into a destination zone.
  function normalizeAddress(value) {
    if (typeof value !== 'string' || !value || value.length > 256) return null;
    var prefix = value.indexOf('/');
    if (prefix >= 0) {
      var length = value.slice(prefix + 1);
      if (!/^[0-9]{1,3}$/.test(length) || Number(length) > 128) return null;
      value = value.slice(0, prefix);
    }
    var zoneIndex = value.indexOf('%'), address = value;
    if (zoneIndex >= 0) {
      if (!/^[A-Za-z0-9_.~-]{1,128}$/.test(value.slice(zoneIndex + 1))) return null;
      address = value.slice(0, zoneIndex);
    }
    if (!address || address.indexOf(':') < 0 || !/^[A-Fa-f0-9:.]+$/.test(address)) return null;
    if (address.indexOf('.') >= 0) {
      var lastColon = address.lastIndexOf(':');
      if (!validIPv4(address.slice(lastColon + 1))) return null;
      address = address.slice(0, lastColon + 1) + '0:0';
    }
    var sides = address.split('::');
    if (sides.length > 2) return null;
    var groups = [];
    for (var i = 0; i < sides.length; i++) {
      if (sides[i]) groups = groups.concat(sides[i].split(':'));
    }
    if (!groups.every(function (part) { return /^[A-Fa-f0-9]{1,4}$/.test(part); })) return null;
    if (sides.length === 1 ? groups.length !== 8 : groups.length >= 8) return null;
    return value;
  }

  function interfaceFromLine(line) {
    var match = /^\s*\d+:\s+([^\s:]+):\s*/.exec(line);
    if (match) return match[1].split('@')[0].slice(0, 128);
    match = /^\s*([^\s:]+):?\s+(?:flags(?:=|\s)|Link encap:)/i.exec(line);
    if (match) return match[1].slice(0, 128);
    // Common English and Chinese ipconfig adapter headings. Other localized
    // headings can still yield addresses, with no inferred interface metadata.
    match = /(?:\badapter\s+|介面卡\s*|網路卡\s*|网适配器\s*|适配器\s*|適配器\s*|網卡\s*|网卡\s*)([^:：]+)[:：]\s*$/i.exec(line);
    return match ? match[1].trim().slice(0, 128) : null;
  }

  function extractLine(line, interfaceName) {
    if (typeof line !== 'string' || line.length > MAX_LINE_LENGTH) return [];
    var marker = /\binet6\b|\bIPv6\b/i.exec(line);
    if (!marker) return [];
    var content = line.slice(marker.index + marker[0].length);
    if (/^inet6$/i.test(marker[0])) content = content.replace(/^\s*addr(?:ess)?\s*:?\s*/i, ' ');
    else content = content.replace(/^\s*(?:位址|地址|address|adresse)\s*[:：]\s*/i, ' ');
    // A colon directly after the label is punctuation, but a leading :: is
    // part of an address. Never strip prefixes from the address tokens below.
    content = content.replace(/^[:：](?=[A-Fa-f0-9]+:)/, ' ');
    var tokens = content.split(/[\s()[\]{},;=<>"'`]+/), result = [], seen = Object.create(null);
    tokens.forEach(function (token) {
      var address = normalizeAddress(token);
      if (address && !seen[address.toLowerCase()]) {
        seen[address.toLowerCase()] = true;
        result.push({ address: address, interfaceName: interfaceName || '' });
      }
    });
    return result;
  }

  function createScanner(onEntry) {
    if (typeof onEntry !== 'function') throw new TypeError('An IPv6 entry callback is required.');
    var line = '', overflow = false, state = 'text', interfaceName = '';

    function finishLine() {
      if (!overflow) {
        var nextInterface = interfaceFromLine(line);
        if (nextInterface !== null) interfaceName = nextInterface;
        // A fresh command/prompt must not inherit an earlier command's interface.
        if (/[>$#]\s*(?:(?:adb\b.*?\bshell\s+)?(?:ifconfig|ipconfig)\b|ip\s+-6\s+(?:addr|address)\b)/i.test(line)) interfaceName = '';
        extractLine(line, interfaceName).forEach(onEntry);
      }
      line = ''; overflow = false;
    }

    function feed(text) {
      if (typeof text !== 'string') return;
      for (var i = 0; i < text.length; i++) {
        var ch = text.charAt(i), code = text.charCodeAt(i);
        if (state === 'string' || state === 'osc') {
          if (code === 0x9c || (state === 'osc' && code === 7)) state = 'text';
          else if (code === 27) state = state === 'osc' ? 'oscEscape' : 'stringEscape';
          continue;
        }
        if (state === 'oscEscape' || state === 'stringEscape') {
          if (ch === '\\' || code === 0x9c || (state === 'oscEscape' && code === 7)) state = 'text';
          else if (code !== 27) state = state === 'oscEscape' ? 'osc' : 'string';
          continue;
        }
        if (state === 'csi') {
          if (code >= 0x40 && code <= 0x7e) state = 'text';
          else if (code === 27) state = 'escape';
          continue;
        }
        if (state === 'escape' || state === 'escapeIntermediate') {
          if (state === 'escape' && ch === '[') state = 'csi';
          else if (state === 'escape' && ch === ']') state = 'osc';
          else if (state === 'escape' && /[PX^_]/.test(ch)) state = 'string';
          else if (code >= 0x20 && code <= 0x2f) state = 'escapeIntermediate';
          else state = code === 27 ? 'escape' : 'text';
          continue;
        }
        if (code === 27) state = 'escape';
        else if (code === 0x9b) state = 'csi';
        else if (code === 0x9d) state = 'osc';
        else if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) state = 'string';
        else if (ch === '\r' || ch === '\n') finishLine();
        else if (code === 8) { if (!overflow) line = line.slice(0, -1); }
        else if (code === 9 || (code >= 0x20 && !(code >= 0x7f && code <= 0x9f))) {
          if (!overflow) {
            if (line.length < MAX_LINE_LENGTH) line += ch;
            else { line = ''; overflow = true; }
          }
        }
      }
    }

    return {
      feed: feed,
      // Use only at a known output boundary; an idle chunk can end mid-address.
      flush: finishLine,
      reset: function () { line = ''; overflow = false; state = 'text'; interfaceName = ''; }
    };
  }

  return {
    createScanner: createScanner,
    extractLine: extractLine,
    normalizeAddress: normalizeAddress,
    isIPv6: function (value) { return normalizeAddress(value) !== null; },
    maxLineLength: MAX_LINE_LENGTH
  };
}));
