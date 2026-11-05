'use strict';
const assert = require('node:assert/strict');
require('../ui/default-commands.js');
const d = globalThis.TerminalGridDefaults;
assert.equal(d.packs.length, 10);
assert.equal(new Set(d.packs.map(p => p.id)).size, 10);
const all = d.packs.flatMap(p => p.commands);
for (const p of d.packs) {
  assert.ok(p.builtin && p.commands.length && p.commands.length <= 128);
  for (const c of p.commands) {
    assert.ok(c.name && c.description && c.command && !/[\r\n\x00]/.test(c.command));
    for (const token of c.command.match(/\{\{[A-Z_]+\}\}/g) || []) assert.ok(d.fields[token.slice(2, -2)]);
  }
}
for (const verb of ['install', 'push', 'pull', 'bugreport']) assert.ok(all.some(c => c.command.includes(' ' + verb + ' ')));
assert.deepEqual(d.keys('adb -s {{SERIAL}} push {{LOCAL_SOURCE}} {{REMOTE_PATH}}'), ['SERIAL', 'LOCAL_SOURCE', 'REMOTE_PATH']);
assert.equal(d.resolve('adb install {{APK_FILE}}', { APK_FILE: 'C:\\測試 folder\\a.apk' }, 'CMD'), 'adb install "C:\\測試 folder\\a.apk"');
assert.equal(d.resolve('{{LOCAL_FOLDER}}', { LOCAL_FOLDER: 'C:\\' }, 'CMD'), '"C:\\."');
assert.equal(d.resolve('{{APK_FILE}}', { APK_FILE: "C:\\a'b$test.apk" }, 'PowerShell'), "'C:\\a''b$test.apk'");
for (const bad of ['', 'a\r\nb', 'a"b', 'C:\\%TEMP%\\a', 'C:\\a!b']) assert.throws(() => d.resolve('{{APK_FILE}}', { APK_FILE: bad }, 'CMD'));
assert.throws(() => d.resolve('{{APK_FILE}}', { APK_FILE: 'a.apk' }, 'Custom'));
assert.throws(() => d.resolve('{{UNKNOWN}}', {}, 'CMD'));
console.log('Default catalog: ' + d.packs.length + ' packs, ' + all.length + ' commands; templates, quoting and invalid paths passed.');
