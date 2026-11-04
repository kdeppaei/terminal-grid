'use strict';
// Exercises the public screen-selection API with deterministic output callback
// ordering; real mouse selection and native shell editing have separate suites.
var assert = require('node:assert/strict');
var fs = require('node:fs');
var path = require('node:path');
var vm = require('node:vm');
var sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../ui/live-replace.js'), 'utf8'), sandbox);
var create = sandbox.window.TerminalGridLiveReplace.create;
var passed = 0, failed = 0;
function test(name, run) {
  try { run(); passed++; console.log('PASS ' + name); }
  catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack); }
}

function fixture(command, cursorOffset) {
  command = command || '000111000';
  var prefix = 'C:\\test>', cols = 24, text = prefix + command;
  var cursor = prefix.length + (cursorOffset === undefined ? command.length : cursorOffset);
  var rows = [], selection, selectedText, sent = [], generation = 1;
  for (var offset = 0; offset < text.length; offset += cols) {
    (function (rowText, wrapped) {
      rows.push({ isWrapped: wrapped, getCell: function (column) {
        return { getWidth: function () { return 1; }, getChars: function () { return rowText[column] || ''; } };
      } });
    }(text.slice(offset, offset + cols), offset > 0));
  }
  var terminal = {
    cols: cols,
    buffer: { active: { type: 'normal', baseY: 0, cursorY: Math.floor(cursor / cols),
      cursorX: cursor % cols, length: rows.length, getLine: function (row) { return rows[row]; } } },
    getSelectionPosition: function () { return selection; },
    hasSelection: function () { return !!selection; },
    getSelection: function () { return selectedText || ''; },
    clearSelection: function () { selection = null; selectedText = ''; },
    focus: function () {}
  };
  var live = create(terminal, {
    isRunning: function () { return true; }, getShell: function () { return 'CMD'; },
    getGeneration: function () { return generation; },
    send: function (data) { sent.push(data); live.input(); return true; }
  });
  function point(index) { return { x: index % cols, y: Math.floor(index / cols) }; }
  function select(start, end, content) {
    selection = { start: point(prefix.length + start), end: point(prefix.length + end) };
    selectedText = content === undefined ? command.slice(start, end) : content;
  }
  select(3, 6);
  return { live: live, select: select, sent: sent, nextGeneration: function () { generation++; live.reset(); } };
}

test('a stable current command can capture and replace only the selected text without executing', function () {
  var f = fixture(), selected = f.live.capture();
  assert.equal(selected.selected, '111');
  var result = f.live.replace(selected, '222');
  assert.equal(result.ok, true);
  assert.equal(result.command, '000222000');
  assert.equal(f.sent.length, 1);
  assert.equal(/[\r\n]/.test(f.sent[0]), false);
});

test('an old output callback cannot acknowledge input sent after that output was queued', function () {
  var f = fixture(), oldOutput = f.live.output();
  f.live.input();
  f.live.parsed(oldOutput);
  assert.equal(f.live.capture(), null, 'the visible screen still predates the latest input');
  var currentOutput = f.live.output();
  assert.equal(f.live.capture(), null, 'new echo must finish parsing first');
  f.live.parsed(currentOutput);
  assert.equal(f.live.capture().selected, '111');
});

test('an output received before a second input cannot release the second input echo guard', function () {
  var f = fixture();
  f.live.input();
  var firstEcho = f.live.output();
  f.live.input();
  f.live.parsed(firstEcho);
  assert.equal(f.live.capture(), null);
  var secondEcho = f.live.output();
  f.live.parsed(secondEcho);
  assert.equal(f.live.capture().selected, '111');
});

test('a callback from the previous session cannot consume a new session pending output', function () {
  var f = fixture(), previousOutput = f.live.output();
  f.nextGeneration();
  var newOutput = f.live.output();
  f.live.parsed(previousOutput);
  assert.equal(f.live.capture(), null, 'new session output is still pending');
  f.live.parsed(newOutput);
  assert.equal(f.live.capture().selected, '111');
});

test('all pending output must parse even after the latest input echo arrives', function () {
  var f = fixture(), olderOutput = f.live.output();
  f.live.input();
  var currentEcho = f.live.output();
  f.live.parsed(currentEcho);
  assert.equal(f.live.capture(), null, 'another output callback remains pending');
  f.live.parsed(olderOutput);
  assert.equal(f.live.capture().selected, '111');
});

test('explicit selection cancellation invalidates an already captured clipboard target', function () {
  var f = fixture(), target = f.live.capture();
  f.live.invalidate();
  assert.equal(f.live.replace(target, '222').ok, false);
  assert.equal(f.sent.length, 0);
});

test('contiguous selections can span a wrapped command row', function () {
  var f = fixture('a'.repeat(20) + '111' + 'b'.repeat(20));
  f.select(12, 25);
  assert.equal(f.live.capture().selected, 'a'.repeat(8) + '111bb');
});

test('a rectangular selection cannot delete the unselected text inside its bounding range', function () {
  var f = fixture('a'.repeat(43));
  // The same columns in consecutive rows visually select six characters, but
  // their bounding start/end coordinates encompass a much larger interval.
  f.select(3, 30, 'aaa\r\naaa');
  assert.equal(f.live.capture(), null);
  assert.equal(f.sent.length, 0);
});

test('trailing input spaces beyond a middle cursor prevent an ambiguous tail replacement', function () {
  var f = fixture('000111000   ', 3);
  var target = f.live.capture();
  assert.equal(target, null, 'screen cells alone cannot establish the real input end');
  assert.equal(f.live.replace(target, '222').ok, false);
  assert.equal(f.sent.length, 0);
});

test('a cursor at the true input end allows replacement while retaining trailing spaces', function () {
  var f = fixture('000111000   ', 12), target = f.live.capture();
  assert.equal(target.selected, '111');
  assert.equal(target.command, '000111000   ');
  var result = f.live.replace(target, '222');
  assert.equal(result.ok, true);
  assert.equal(result.command, '000222000   ');
  assert.equal(f.sent.length, 1);
  assert.equal(/[\r\n]/.test(f.sent[0]), false);
});

test('explicit erased-tail spaces are conservatively rejected at the visible text end', function () {
  // These cells can represent shell erasure or genuine trailing input. Treating
  // them as known input would risk deleting or reconstructing the wrong tail.
  var f = fixture('000111000   ', 9);
  assert.equal(f.live.capture(), null);
  assert.equal(f.sent.length, 0);
});

console.log('Live replacement state: ' + passed + ' passed, ' + failed + ' failed.');
if (failed) process.exitCode = 1;
