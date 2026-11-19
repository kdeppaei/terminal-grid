'use strict';
const assert = require('node:assert/strict');
require('../ui/nan-workflow.js');
const create = globalThis.TerminalGridNan.create;
const v = { dut1: 'DUT_ONE', dut2: 'DUT_TWO', if1: 'aware_data1', if2: 'aware_data0', tool: 'iperf3', bin1: '/data/local/tmp/iperf3', bin2: 'iperf3', amount: '1300M', port: '5201', folder: 'C:\\工具 folder\\' };
const flow = create(v), share = create({ ...v, tool: 'share' });
assert.equal(flow.workspace.slots[5].tabs.length, 2);
assert.deepEqual(flow.steps.filter(s => s.action === 'start').map(s => s.slot), [0, 1, 3, 2, 4]);
assert.deepEqual(share.steps.filter(s => s.action === 'start').map(s => s.slot), [0, 1, 3]);
assert.equal(share.steps.filter(s => s.action === 'pause').length, 2);
assert.ok(!JSON.stringify(flow).includes('fe80::'), 'dynamic IPv6 must not be baked into saved flows');
assert.match(flow.workspace.slots[3].tabs[0].args, /--folder "C:\\工具 folder\\\\"$/);
for (const patch of [{ dut2: v.dut1 }, { if2: 'aware_data0;reboot' }, { bin1: 'iperf3 && reboot' }, { amount: '0' }, { port: '70000' }, { folder: 'D:\\bad\npath' }]) assert.throws(() => create({ ...v, ...patch }));

const runtimeOptions = { ...v, tool: 'choose', amount: '1300000000' };
const selectable = create(runtimeOptions);
assert.deepEqual(selectable.steps.filter(s => s.action === 'start').map(s => s.tabId), ['nan-mirror1', 'nan-mirror2', 'nan-ping']);
assert.deepEqual(selectable.steps.slice(-2).map(s => [s.action, s.tabId, s.text]), [
  ['output', 'nan-ping', 'bytes from'], ['nanTransfer', 'nan-ping', '1300000000']
]);
const [configure, connect] = selectable.steps.filter(s => s.action === 'pause');
assert.match(configure.text, /啟動 Wi-Fi Aware.*尚未建立 NDP/);
assert.match(connect.text, /建立 NDP.*發布.*訂閱.*新發現.*驗證 IPv6/);
const [server3, server2] = selectable.workspace.slots[2].tabs;
const [client3, client2] = selectable.workspace.slots[4].tabs;
assert.deepEqual([server3.id, server2.id, client3.id, client2.id], ['nan-server', 'nan-server-iperf2', 'nan-traffic', 'nan-traffic-iperf2']);
for (const tab of [server3, client3]) assert.match(tab.args, /--tool "iperf3".*--amount "1300000000" --port "5201"/);
for (const tab of [server2, client2]) assert.match(tab.args, /--tool "iperf".*--amount "1300000000" --port "5001"/);
assert.match(create({ ...runtimeOptions, bin2Iperf2: '/data/local/tmp/iperf' }).workspace.slots[4].tabs[1].args, /--bin2 "\/data\/local\/tmp\/iperf"/);
assert.throws(() => create({ ...runtimeOptions, amount: '1300M' }));
assert.throws(() => create({ ...runtimeOptions, bin2Iperf2: 'iperf;reboot' }));

const python = create({ ...runtimeOptions, usePython: true, pythonPath: 'C:\\QA Tools\\python.exe', recovery: true });
const firstPing = python.steps.findIndex(s => s.action === 'start' && s.tabId === 'nan-ping');
assert.deepEqual(python.steps.slice(firstPing - 2, firstPing + 3).map(s => [s.action, s.tabId]), [
  ['start', 'nan-python-probe'], ['exit', 'nan-python-probe'], ['start', 'nan-ping'],
  ['output', 'nan-ping'], ['nanTransfer', 'nan-ping']
]);
assert.match(python.workspace.slots[3].tabs[1].args, /^--mode python-probe .* --python "C:\\QA Tools\\python\.exe"$/);
assert.equal(python.steps.filter(s => s.action === 'nanTransfer').length, 1);
assert.equal(python.steps.filter(s => s.action === 'stop' && s.tabId === 'nan-traffic-iperf2').length, 2);
assert.throws(() => create({ ...runtimeOptions, usePython: true, pythonPath: 'C:\\bad"path.exe' }));
const existingMirrors = create({ ...runtimeOptions, reuseMirrors: true, recovery: true });
assert.deepEqual(existingMirrors.steps.filter(s => s.action === 'start').map(s => s.tabId), ['nan-ping', 'nan-ping']);
assert.ok(existingMirrors.steps.every(s => !s.tabId.startsWith('nan-mirror') || s.action === 'pause'));
assert.ok(existingMirrors.steps.some(s => s.action === 'pause' && s.text.includes('重新開啟因拔線關閉的 scrcpy')));
const checkpointOptions = { beforeStart: '確認測試環境', beforeNdp: '確認兩端設定\n記下生效時間', beforeTransfer: '先開始收證', afterTransfer: '核對接收端紀錄' };
const withCheckpoints = create({ ...runtimeOptions, ...checkpointOptions, recovery: true });
const firstPreparation = withCheckpoints.steps.findIndex(s => s.text === configure.text);
assert.equal(withCheckpoints.steps[firstPreparation - 1].text, '啟動 Wi-Fi Aware 前\n' + checkpointOptions.beforeStart);
assert.deepEqual(withCheckpoints.steps.slice(firstPreparation, firstPreparation + 3).map(s => s.text), [
  configure.text, '建立 NDP 前\n' + checkpointOptions.beforeNdp, connect.text
]);
const choice = withCheckpoints.steps.findIndex(s => s.action === 'nanTransfer');
assert.equal(withCheckpoints.steps[choice - 2].action, 'output');
assert.equal(withCheckpoints.steps[choice - 1].text, '傳輸前\n' + checkpointOptions.beforeTransfer);
assert.equal(withCheckpoints.steps[choice + 1].text, '傳輸完成後\n' + checkpointOptions.afterTransfer);
assert.equal(withCheckpoints.steps.filter(s => s.text?.startsWith('建立 NDP 前')).length, 2);
assert.equal(withCheckpoints.steps.filter(s => s.text?.startsWith('傳輸完成後')).length, 1);
const fixedWithCheckpoints = create({ ...v, ...checkpointOptions });
assert.equal(fixedWithCheckpoints.steps.at(-2).action, 'exit');
assert.equal(fixedWithCheckpoints.steps.at(-1).text, '傳輸完成後\n' + checkpointOptions.afterTransfer);
console.log('NAN workflow: preset and post-Ping choices, optional Python, preparation order, routing, and validation passed.');
