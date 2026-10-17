// 验收测试（Claude 编写，执行者不得修改）：terminal-notifier 失败时用 osascript 补发
// 全部用假脚本代替真实命令，不会弹出任何真实通知。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../../lib/index.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 造一个假命令：把收到的参数（每个参数一行）追加到 calls 文件，然后按 behavior 退出
function fakeBin(dir, name, behavior) {
  const calls = path.join(dir, `${name}.calls`);
  const body = {
    ok: 'exit 0',
    fail: 'exit 3',
    hang: 'sleep 30; exit 0',
  }[behavior];
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> "${calls}"; done\nprintf -- '---\\n' >> "${calls}"\n${body}\n`);
  fs.chmodSync(file, 0o755);
  return { file, calls };
}
const callCount = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter((l) => l === '---').length : 0);
const callText = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');

async function run(env, waitMs = 1500) {
  const keys = ['DSH_APPROVAL_NOTIFY_LOG', 'DSH_APPROVAL_NOTIFY_FRONT', 'DSH_APPROVAL_NOTIFY_TN', 'DSH_APPROVAL_NOTIFY_OSASCRIPT', 'DSH_APPROVAL_NOTIFY_TIMEOUT_MS'];
  const old = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    for (const k of keys) delete process.env[k];
    Object.assign(process.env, { DSH_APPROVAL_NOTIFY_FRONT: 'com.apple.finder' }, env);
    const regs = [];
    apply({ on: (name, fn, opts) => regs.push({ name, fn, opts }) }, { throttleMs: 0 });
    const listener = regs.find((r) => r.name === 'approval/request').fn;
    const t0 = Date.now();
    const out = await listener({ toolName: 'bash', displayReason: { zh: '补发测试' } }, () => 'allowed-once');
    const listenerMs = Date.now() - t0;
    await sleep(waitMs);
    return { out, listenerMs };
  } finally {
    for (const k of keys) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; }
  }
}

test('terminal-notifier 成功：不补发', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-ok-'));
  const tn = fakeBin(dir, 'tn', 'ok');
  const osa = fakeBin(dir, 'osa', 'ok');
  const { out } = await run({ DSH_APPROVAL_NOTIFY_TN: tn.file, DSH_APPROVAL_NOTIFY_OSASCRIPT: osa.file });
  assert.equal(out, 'allowed-once');
  assert.equal(callCount(tn.calls), 1, 'terminal-notifier 应被调用一次');
  const args = callText(tn.calls);
  assert.match(args, /-activate\ncom\.deepseek\.dsh/, '应带 -activate com.deepseek.dsh');
  assert.match(args, /补发测试/);
  assert.equal(callCount(osa.calls), 0, '成功时不应补发');
});

test('terminal-notifier 退出码非 0：用 osascript 补发一次', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-fail-'));
  const tn = fakeBin(dir, 'tn', 'fail');
  const osa = fakeBin(dir, 'osa', 'ok');
  await run({ DSH_APPROVAL_NOTIFY_TN: tn.file, DSH_APPROVAL_NOTIFY_OSASCRIPT: osa.file });
  assert.equal(callCount(tn.calls), 1);
  assert.equal(callCount(osa.calls), 1, '应补发一次');
  const osaArgs = callText(osa.calls);
  assert.match(osaArgs, /^-e\n/, 'osascript 应以 -e 传脚本');
  assert.match(osaArgs, /display notification ".*补发测试.*"/);
});

test('terminal-notifier 卡住超时：用 osascript 补发，且监听器不被阻塞', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-hang-'));
  const tn = fakeBin(dir, 'tn', 'hang');
  const osa = fakeBin(dir, 'osa', 'ok');
  const { listenerMs } = await run({ DSH_APPROVAL_NOTIFY_TN: tn.file, DSH_APPROVAL_NOTIFY_OSASCRIPT: osa.file, DSH_APPROVAL_NOTIFY_TIMEOUT_MS: '300' }, 2000);
  assert.ok(listenerMs < 200, `监听器耗时 ${listenerMs}ms，不应等待通知`);
  assert.equal(callCount(osa.calls), 1, '超时后应补发一次');
});

test('terminal-notifier 路径不存在：直接用 osascript', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-none-'));
  const osa = fakeBin(dir, 'osa', 'ok');
  await run({ DSH_APPROVAL_NOTIFY_TN: path.join(dir, 'does-not-exist'), DSH_APPROVAL_NOTIFY_OSASCRIPT: osa.file });
  assert.equal(callCount(osa.calls), 1);
});

test('terminal-notifier 和 osascript 都失败：不抛错、不重试', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-both-'));
  const tn = fakeBin(dir, 'tn', 'fail');
  const osa = fakeBin(dir, 'osa', 'fail');
  const { out } = await run({ DSH_APPROVAL_NOTIFY_TN: tn.file, DSH_APPROVAL_NOTIFY_OSASCRIPT: osa.file });
  assert.equal(out, 'allowed-once');
  assert.equal(callCount(tn.calls), 1);
  assert.equal(callCount(osa.calls), 1, 'osascript 失败后不应再重试');
});

test('dry-run 日志模式下不调用任何命令', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-dry-'));
  const tn = fakeBin(dir, 'tn', 'ok');
  const osa = fakeBin(dir, 'osa', 'ok');
  const log = path.join(dir, 'n.log');
  await run({ DSH_APPROVAL_NOTIFY_LOG: log, DSH_APPROVAL_NOTIFY_TN: tn.file, DSH_APPROVAL_NOTIFY_OSASCRIPT: osa.file }, 500);
  assert.equal(callCount(tn.calls) + callCount(osa.calls), 0);
  assert.ok(fs.readFileSync(log, 'utf8').includes('补发测试'));
});
