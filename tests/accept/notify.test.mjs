// 验收测试（Claude 编写，执行者不得修改）：node --test "tests/accept/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import plugin, { apply, buildNotification, appleScriptFor } from '../../lib/index.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-notify-')), 'n.log');
const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 假的 cordis ctx：记录 ctx.on 的注册
function fakeCtx() {
  const regs = [];
  return { regs, on(name, fn, opts) { regs.push({ name, fn, opts }); return () => {}; } };
}
function listenerOf(config, env = {}) {
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const ctx = fakeCtx();
  apply(ctx, config);
  const reg = ctx.regs.find((r) => r.name === 'approval/request');
  return { ctx, reg, listener: reg?.fn };
}
function withEnv(env, fn) {
  const old = {};
  for (const k of Object.keys(env)) { old[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  return Promise.resolve(fn()).finally(() => { for (const k of Object.keys(old)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } });
}

test('默认导出包含 apply', () => {
  assert.equal(typeof plugin.apply, 'function');
  assert.equal(plugin.apply, apply);
});

test('apply 只注册一个 approval/request 监听器，且 prepend', () => {
  const ctx = fakeCtx();
  apply(ctx, {});
  const regs = ctx.regs.filter((r) => r.name === 'approval/request');
  assert.equal(regs.length, 1);
  assert.equal(typeof regs[0].fn, 'function');
  assert.equal(regs[0].opts?.prepend, true);
});

test('监听器原样返回 next() 的结果，next 只调用一次', () => withEnv({ DSH_APPROVAL_NOTIFY_LOG: tmp(), DSH_APPROVAL_NOTIFY_FRONT: 'com.apple.finder' }, async () => {
  const { listener } = listenerOf({});
  let calls = 0;
  const sentinel = Promise.resolve('allowed-once');
  const out = listener({ toolName: 'bash', reason: '需要联网' }, () => { calls++; return sentinel; });
  assert.equal(await out, 'allowed-once');
  assert.equal(calls, 1);
}));

test('通知出错也绝不抛错（日志路径不可写）', () => withEnv({ DSH_APPROVAL_NOTIFY_LOG: '/nonexistent-dir/xyz/n.log', DSH_APPROVAL_NOTIFY_FRONT: 'com.apple.finder' }, async () => {
  const { listener } = listenerOf({});
  let out;
  assert.doesNotThrow(() => { out = listener({ toolName: 'bash' }, () => 'rejected'); });
  assert.equal(await out, 'rejected');
}));

test('dry-run 写日志：标题、副标题、正文、提示音', () => withEnv({ DSH_APPROVAL_NOTIFY_LOG: tmp(), DSH_APPROVAL_NOTIFY_FRONT: 'com.apple.finder' }, async () => {
  const f = process.env.DSH_APPROVAL_NOTIFY_LOG;
  const { listener } = listenerOf({ sound: 'Ping' });
  await listener({ toolName: 'bash', reason: 'raw reason', displayReason: '需要访问网络' }, () => 'allowed-once');
  await sleep(300);
  const got = lines(f);
  assert.equal(got.length, 1);
  assert.equal(got[0].title, 'DeepSeek Harness');
  assert.equal(got[0].subtitle, '⚠️ 有操作等你批准');
  assert.equal(got[0].body, 'bash：需要访问网络', '优先用 displayReason');
  assert.equal(got[0].sound, 'Ping');
}));

test('buildNotification 正文规则', () => {
  assert.equal(buildNotification({ toolName: 'write', reason: '写入工作区外' }).body, 'write：写入工作区外');
  assert.equal(buildNotification({ toolName: 'write' }).body, 'write');
  assert.equal(buildNotification({}).body, '未知操作');
  assert.equal(buildNotification({ toolName: 'bash', reason: '  第一行\n第二行  ' }).body, 'bash：第一行 第二行');
  const long = buildNotification({ toolName: 'bash', reason: '很'.repeat(500) }).body;
  assert.ok(long.length <= 160, `正文 ${long.length} 字超过 160`);
  assert.ok(long.endsWith('…'));
  const n = buildNotification({ toolName: 'x' });
  assert.equal(n.title, 'DeepSeek Harness');
  assert.equal(n.subtitle, '⚠️ 有操作等你批准');
});

test('displayReason 是中英文字典时优先取中文', () => {
  assert.equal(buildNotification({ toolName: 'bash', displayReason: { en: 'Allow this', zh: '允许本次操作' } }).body, 'bash：允许本次操作');
  assert.equal(buildNotification({ toolName: 'bash', displayReason: { en: 'Allow this' } }).body, 'bash：Allow this');
  assert.ok(!buildNotification({ toolName: 'bash', displayReason: { en: 'x', zh: 'y' } }).body.includes('[object Object]'));
});

test('appleScriptFor 转义引号和反斜杠', () => {
  const s = appleScriptFor({ title: 'T', subtitle: 'S', body: 'say "hi" \\ ok', sound: 'Glass' });
  assert.ok(s.startsWith('display notification "'), s);
  assert.ok(s.includes('say \\"hi\\" \\\\ ok'), s);
  assert.ok(s.includes('with title "T"') && s.includes('subtitle "S"') && s.includes('sound name "Glass"'), s);
});

test('dsh 在前台时不通知；notifyWhenFocused 时照发', () => withEnv({ DSH_APPROVAL_NOTIFY_LOG: tmp(), DSH_APPROVAL_NOTIFY_FRONT: 'com.deepseek.dsh' }, async () => {
  const f = process.env.DSH_APPROVAL_NOTIFY_LOG;
  const a = listenerOf({});
  await a.listener({ toolName: 'bash' }, () => 'x');
  await sleep(300);
  assert.equal(lines(f).length, 0, '前台是 dsh 时不应通知');
  const b = listenerOf({ notifyWhenFocused: true });
  await b.listener({ toolName: 'bash' }, () => 'x');
  await sleep(300);
  assert.equal(lines(f).length, 1, 'notifyWhenFocused 时应通知');
}));

test('节流：默认 3 秒内只发一条；throttleMs:0 不节流', () => withEnv({ DSH_APPROVAL_NOTIFY_LOG: tmp(), DSH_APPROVAL_NOTIFY_FRONT: 'com.apple.finder' }, async () => {
  const f = process.env.DSH_APPROVAL_NOTIFY_LOG;
  const a = listenerOf({});
  for (let i = 0; i < 3; i++) await a.listener({ toolName: 'bash' }, () => 'x');
  await sleep(300);
  assert.equal(lines(f).length, 1);
  const b = listenerOf({ throttleMs: 0 });
  for (let i = 0; i < 3; i++) await b.listener({ toolName: 'bash' }, () => 'x');
  await sleep(300);
  assert.equal(lines(f).length, 4, '新的 apply 有独立的节流状态，且不节流时 3 条全发');
}));

test('打包信息：ESM、零依赖、bundle patch 注册', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'dsh-approval-notify-macos');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml');
  assert.ok(!pkg.dependencies || Object.keys(pkg.dependencies).length === 0, '不应有运行时依赖');
  const patch = fs.readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8');
  assert.match(patch, /insert/);
  assert.match(patch, /name:\s*['"]?dsh-approval-notify-macos['"]?/);
  assert.ok(fs.existsSync(path.join(ROOT, 'README.md')));
});
