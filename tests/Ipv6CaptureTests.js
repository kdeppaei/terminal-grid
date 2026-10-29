'use strict';
var assert = require('node:assert/strict');
var ipv6 = require('../ui/ipv6-capture.js');
var passed = 0;
function test(name, fn) { fn(); passed++; console.log('PASS ' + name); }
function scan(chunks, flush) {
  var entries = [], scanner = ipv6.createScanner(function (entry) { entries.push(entry); });
  chunks.forEach(scanner.feed);
  if (flush) scanner.flush();
  return entries;
}
function addresses(chunks, flush) { return scan(chunks, flush).map(function (entry) { return entry.address; }); }

test('valid compressed, full, scoped, CIDR and embedded IPv4 addresses', function () {
  ['::', '::1', '2001:db8::1', 'fe80::abcd%wlan0', 'fe80::1%15', 'FE80::ABCD%en0.10',
    '2001:db8:1:2:3:4:5:6', '::ffff:192.0.2.128', '2001:db8:0:0:0:0:192.0.2.1', 'fe80::1/64', '::/0', '::1/128']
    .forEach(function (address) { assert.ok(ipv6.isIPv6(address), address); });
  assert.equal(ipv6.normalizeAddress('fe80::123%en0/64'), 'fe80::123%en0');
});
test('reject malformed groups, MACs, timestamps, prefixes, IPv4 and zones', function () {
  ['', '192.0.2.1', '12:34:56', 'aa:bb:cc:dd:ee:ff', '1:2:3:4:5:6:7', '1:2:3:4:5:6:7:8:9',
    '1:2:3:4:5:6:7:8::', 'fe80:::1', 'fe80::1::2', ':1:2:3:4:5:6:7', '1:2:3:4:5:6:7:',
    '12345::1', 'gggg::1', 'fe80::1/129', 'fe80::1/-1', 'fe80::1/64/64', 'fe80::1/foo',
    '::ffff:256.0.0.1', '::ffff:192.00.2.1', '::ffff:192.0.2', '192.0.2.1::', 'fe80::1%',
    'fe80::1%eth0%1', 'fe80::1%eth 0', 'fe80::1%eth0&calc', null]
    .forEach(function (address) { assert.equal(ipv6.isIPv6(address), false, String(address)); });
});
test('Linux ifconfig records the source interface without inventing a scope', function () {
  assert.deepEqual(scan(['wlan0: flags=4163<UP,BROADCAST,RUNNING>  mtu 1500\n',
    '        inet6 fe80::abcd:12ff:fe34:5678  prefixlen 64  scopeid 0x20<link>\n']),
  [{ address: 'fe80::abcd:12ff:fe34:5678', interfaceName: 'wlan0' }]);
});
test('Android and BusyBox ifconfig recognize inet6 addr and compact spacing', function () {
  assert.deepEqual(scan(['aware_data0 Link encap:Ethernet HWaddr 02:11:22:33:44:55\r\n',
    '          inet6 addr: fe80::aabb:ccdd/64 Scope: Link\r\n', '          inet6 addr:2001:db8::1/64 Scope: Global\n']),
  [{ address: 'fe80::aabb:ccdd', interfaceName: 'aware_data0' }, { address: '2001:db8::1', interfaceName: 'aware_data0' }]);
});
test('ip -6 addr separates interfaces and removes peer indexes', function () {
  assert.deepEqual(scan(['2: wlan0: <UP> mtu 1500\n    inet6 fe80::1/64 scope link\n',
    '7: veth0@if8: <UP> mtu 1500\n    inet6 2001:db8::2/128 scope global\n']),
  [{ address: 'fe80::1', interfaceName: 'wlan0' }, { address: '2001:db8::2', interfaceName: 'veth0' }]);
});
test('macOS retains an explicit interface zone', function () {
  assert.deepEqual(scan(['en0: flags=8863<UP,BROADCAST> mtu 1500\n\tinet6 fe80::1234:5678%en0 prefixlen 64 secured scopeid 0x4\n']),
    [{ address: 'fe80::1234:5678%en0', interfaceName: 'en0' }]);
});
test('Windows English and Traditional/Simplified Chinese IPv6 labels', function () {
  assert.deepEqual(scan(['Wireless LAN adapter Wi-Fi:\r\n\r\n   Link-local IPv6 Address . . . . . : fe80::ab12%13(Preferred)\r\n',
    '無線區域網路介面卡 Wi-Fi 2:\n   連結-本機 IPv6 位址 . . . . . . : fe80::cd34%17(偏好選項)\n',
    '无线局域网适配器 WLAN:\n   本地链接 IPv6 地址 . . . . . . : fe80::ef56%6(首选)\n']),
  [{ address: 'fe80::ab12%13', interfaceName: 'Wi-Fi' }, { address: 'fe80::cd34%17', interfaceName: 'Wi-Fi 2' }, { address: 'fe80::ef56%6', interfaceName: 'WLAN' }]);
});
test('other localized IPv6 labels still capture the address', function () {
  assert.deepEqual(addresses(['IPv6-Adresse . . . . . : 2001:db8::1234\nAdresse IPv6 de liaison locale . . : fe80::1234%9\n']), ['2001:db8::1234', 'fe80::1234%9']);
});
test('compact labels and zero-prefix addresses remain intact', function () {
  assert.deepEqual(addresses(['IPv6:fe80::1\nIPv6位址:fe80::2\ninet6 ::1/128\ninet6 ::/0\ninet6 ::ffff:192.0.2.1/128\n']), ['fe80::1', 'fe80::2', '::1', '::', '::ffff:192.0.2.1']);
});
test('only recognizable network labels are scanned; malformed lookalikes are excluded', function () {
  assert.deepEqual(addresses(['ping fe80::1\nrandom 2001:db8::1\ninet6 12:34:56 aa:bb:cc:dd:ee:ff notfe80::1 12345::1 1::2::3 x:fe80::1 :fe80::1 fe80::1extra\ninet 192.0.2.1\n']), []);
});
test('all split positions produce one complete address and never partial addresses', function () {
  var output = 'wlan0: flags=4163<UP> mtu 1500\n    inet6 fe80::1234:abcd%wlan0/64 scope link\r\n';
  var expected = [{ address: 'fe80::1234:abcd%wlan0', interfaceName: 'wlan0' }];
  for (var cut = 0; cut <= output.length; cut++) assert.deepEqual(scan([output.slice(0, cut), output.slice(cut)]), expected, 'split ' + cut);
  assert.deepEqual(scan(output.split('')), expected);
  assert.deepEqual(addresses(['inet6 fe80::1234']), []);
  assert.deepEqual(addresses(['inet6 fe80::1234', ':abcd/64\n']), ['fe80::1234:abcd']);
});
test('flush accepts a complete unterminated line exactly once and reset drops buffered output', function () {
  var entries = [], scanner = ipv6.createScanner(function (entry) { entries.push(entry); });
  scanner.feed('inet6 fe80::1'); scanner.flush(); scanner.flush();
  assert.equal(entries.length, 1);
  scanner.feed('wlan0: flags=1\ninet6 fe80::2'); scanner.reset(); scanner.feed('inet6 fe80::3\n');
  assert.deepEqual(entries, [{ address: 'fe80::1', interfaceName: '' }, { address: 'fe80::3', interfaceName: '' }]);
});
test('ANSI CSI styling may split across chunks and inside an address', function () {
  var output = '\x1b[32minet6\x1b[0m fe80::12\x1b[1m34\x1b[0m/64\r\n';
  assert.deepEqual(addresses(output.split('')), ['fe80::1234']);
  assert.deepEqual(addresses(['\x9b32minet6 fe80::55\x9b0m\n']), ['fe80::55']);
});
test('OSC title/hyperlink payloads, DCS and C1 strings never become captured output', function () {
  var output = '\x1b]0;inet6 fe80::bad\n\x07' +
    '\x1b]8;;https://example.invalid/inet6 fe80::dead\n\x1b\\' +
    'inet6 fe80::1\x1b]8;;\x1b\\\n' +
    '\x1bPinet6 fe80::222\n\x1b\\' +
    '\x9dinet6 fe80::333\n\x9c' +
    '\x1b_inet6 fe80::444\n\x1b\\' +
    'inet6 fe80::2\n';
  assert.deepEqual(addresses(output.split('')), ['fe80::1', 'fe80::2']);
});
test('overlong lines and unbounded escape payloads are discarded without poisoning following output', function () {
  var entries = [], scanner = ipv6.createScanner(function (entry) { entries.push(entry); });
  scanner.feed('inet6 fe80::1 ' + 'x'.repeat(ipv6.maxLineLength * 20));
  scanner.feed('\ninet6 fe80::2\n\x1b]0;');
  for (var i = 0; i < 100; i++) scanner.feed('inet6 fe80::bad\n'.repeat(1000));
  scanner.feed('\x07inet6 fe80::3\n');
  assert.deepEqual(entries.map(function (entry) { return entry.address; }), ['fe80::2', 'fe80::3']);
});
test('CR, LF, CRLF and backspace are supported', function () {
  assert.deepEqual(addresses(['inet6 fe80::1\rinet6 fe80::2\ninet6 fe80::3\r\ninet6 fe80::4x\b\n']), ['fe80::1', 'fe80::2', 'fe80::3', 'fe80::4']);
});
test('new query command clears stale source interface metadata', function () {
  assert.deepEqual(scan(['wlan0: flags=1\ninet6 fe80::1\nC:\\>adb shell ifconfig\ninet6 fe80::2\n']),
    [{ address: 'fe80::1', interfaceName: 'wlan0' }, { address: 'fe80::2', interfaceName: '' }]);
});
test('one network line deduplicates repeated addresses', function () {
  assert.deepEqual(addresses(['inet6 fe80::A fe80::a fe80::b\n']), ['fe80::A', 'fe80::b']);
});
console.log('IPv6 capture: ' + passed + ' tests passed.');
