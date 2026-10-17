/**
 * dsh-approval-notify-macos —— 审批时发 macOS 系统通知。
 *
 * 只提醒，不作答：
 *   本插件在 `approval/request` 瀑布事件（waterfall）里排在最前面，**只观察、不作答**：
 *   监听到请求后先“火一只通知”、立刻 `return next()`，把决定权原样交还给真正负责
 *   应答的监听器（桌面界面 `dsh-client-ui-approval`）。监听器返回的是 `next()` 的结果，
 *   既不会改写成 allow/reject，也不会延迟或替代审批流程。
 *
 * 不变量（改这里之前请先确认它们都还成立）：
 *   ① 绝不抛错：通知链路里的任何异常（命令不存在、日志写不进去、超时、解析失败）都吞掉，
 *      `next()` 照常被调用一次并返回其结果。
 *   ② 绝不阻塞：不 `await` 发通知的过程；子进程全部异步执行，5 秒超时强杀
 *      （可用 `DSH_APPROVAL_NOTIFY_TIMEOUT_MS` 覆盖）。terminal-notifier 失败/超时时
 *      用 osascript 补发一次，补发同样发生在后台，`next()` 不等它。
 *   ③ 节流状态属于一次 `apply()` 调用（同一插件实例内共享），不同 `apply()` 互不影响。
 *   ④ 只用 Node 内置模块，零依赖；不联网、不读用户文件、不记录工具参数（本来也拿不到）。
 */
import { spawn } from 'node:child_process';
import { accessSync, appendFileSync, constants, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** dsh 桌面版的 bundle id：前台是它时，审批框已经在用户眼前了。 */
const DSH_BUNDLE_ID = 'com.deepseek.dsh';

/** 通知标题 / 副标题。 */
const TITLE = 'DeepSeek Harness';
const SUBTITLE = '⚠️ 有操作等你批准';

/** 正文最大长度（按 UTF-16 码元计，与 JS `String#length` 一致）。 */
const MAX_BODY_LENGTH = 160;

/** 截断标记。 */
const ELLIPSIS = '…';

/** 子进程默认超时（毫秒）。 */
const CHILD_TIMEOUT_MS = 5000;

/**
 * 子进程定时器的最长等待时间。Node 的 Timeout 上限是 2^31-1 毫秒，超了会**变成 1ms**
 * （必被杀），所以过大的超时要夹到上限。
 */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** 默认提示音（macOS 系统声音名）。 */
const DEFAULT_SOUND = 'Glass';

/** 默认节流间隔（毫秒）。 */
const DEFAULT_THROTTLE_MS = 3000;

/** 测试开关：写日志代替真正发通知。 */
const ENV_LOG = 'DSH_APPROVAL_NOTIFY_LOG';

/** 测试开关：模拟前台 App 的 bundle id，设置后不再调用 lsappinfo。 */
const ENV_FRONT = 'DSH_APPROVAL_NOTIFY_FRONT';

/** 测试开关：指定 terminal-notifier 路径（设置了就只用它）。 */
const ENV_TN = 'DSH_APPROVAL_NOTIFY_TN';

/** 测试开关：指定 osascript 路径。 */
const ENV_OSASCRIPT = 'DSH_APPROVAL_NOTIFY_OSASCRIPT';

/** 测试开关：子进程超时毫秒数（夹在 [MIN, MAX] 之间）。 */
const ENV_TIMEOUT_MS = 'DSH_APPROVAL_NOTIFY_TIMEOUT_MS';

/** 超时环境变量的合法范围（毫秒）。 */
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 60000;

/** 系统命令的绝对路径（不依赖 PATH，避免被卷进奇怪的 shell 环境）。 */
const LSAPPINFO = '/usr/bin/lsappinfo';
const OSASCRIPT = '/usr/bin/osascript';

/**
 * `terminal-notifier` 的候选安装位置。如果 dsh 进程自己的 PATH 里也有它，
 * 同样接受（给非 Homebrew 安装方式留一条路）。
 */
const TERMINAL_NOTIFIER_CANDIDATES = [
  '/opt/homebrew/bin/terminal-notifier',
  '/usr/local/bin/terminal-notifier',
];

// ---------------------------------------------------------------------------
// 通知文案
// ---------------------------------------------------------------------------

/** 把任意值归一成一个字符串（非字符串返回 undefined）。 */
function asString(value) {
  return typeof value === 'string' ? value : undefined;
}

/**
 * 取出一条可读的展示文案。
 *
 * 审批请求里的 `displayReason` 按契约是“本地化展示文案”，但实测 dsh 的发送方
 * （例如沙箱升权 `@deepseek-ai/dsh-sandbox`）传的是 `{ en, zh }` 语言字典，
 * 由界面端 `locale.resolveText` 按语言挑选。通知里没法调用界面端的解析，
 * 所以这里自己挑：优先中文（系统语言是中文时），否则英文，最后回退到任意字符串值；
 * 遇到纯字符串则直接用。
 * @param {unknown} displayReason - 审批请求里的 displayReason。
 * @returns {string | undefined} 挑选后的文案。
 */
function pickDisplayReason(displayReason) {
  const plain = asString(displayReason);
  if (plain !== undefined) return plain;
  if (displayReason === null || typeof displayReason !== 'object') return undefined;

  // 语言偏好：LANG / LC_ALL 是中文环境时优先 zh，否则优先 en。
  const lang = `${process.env.LC_ALL ?? ''} ${process.env.LC_MESSAGES ?? ''} ${process.env.LANG ?? ''}`.toLowerCase();
  const preferZh = /zh/.test(lang) || lang.trim() === '';
  const order = preferZh ? ['zh', 'en'] : ['en', 'zh'];
  for (const key of order) {
    const value = asString(displayReason[key]);
    if (value !== undefined && value.trim() !== '') return value;
  }
  // 兜底：任意一个字符串值。
  for (const value of Object.values(displayReason)) {
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return undefined;
}

/** 归一化空白：换行等所有空白折成单个空格，并去掉首尾空白。 */
function collapseWhitespace(text) {
  return text.replace(/\s+/g, ' ').trim();
}

/** 按码元截断到上限，超出时以 `…` 结尾，保证总长 ≤ 上限。 */
function truncate(text, max) {
  if (text.length <= max) return text;
  return text.slice(0, max - ELLIPSIS.length) + ELLIPSIS;
}

/**
 * 由审批请求构造通知内容。
 * @param {object} req - `approval/request` 的请求对象（agent/toolName/reason/displayReason/…）。
 * @returns {{ title: string, subtitle: string, body: string }}
 */
export function buildNotification(req) {
  const r = req !== null && typeof req === 'object' ? req : {};

  const toolName = collapseWhitespace(asString(r.toolName) ?? '') || '未知操作';
  const reason = collapseWhitespace(pickDisplayReason(r.displayReason) ?? asString(r.reason) ?? '');

  const body = truncate(reason === '' ? toolName : `${toolName}：${reason}`, MAX_BODY_LENGTH);
  return { title: TITLE, subtitle: SUBTITLE, body };
}

// ---------------------------------------------------------------------------
// AppleScript
// ---------------------------------------------------------------------------

/** 转义 AppleScript 双引号字符串里的 `\` 和 `"`。 */
function escapeAppleScript(text) {
  return String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * 生成 `osascript -e` 用的脚本。
 * @param {{ title: string, subtitle: string, body: string, sound: string }} n - 通知内容。
 * @returns {string} AppleScript 源码。
 */
export function appleScriptFor(n) {
  const safe = n !== null && typeof n === 'object' ? n : {};
  const body = escapeAppleScript(safe.body ?? '');
  const title = escapeAppleScript(safe.title ?? '');
  const subtitle = escapeAppleScript(safe.subtitle ?? '');
  const sound = escapeAppleScript(safe.sound ?? '');
  return `display notification "${body}" with title "${title}" subtitle "${subtitle}" sound name "${sound}"`;
}

// ---------------------------------------------------------------------------
// 异步子进程助手
// ---------------------------------------------------------------------------

/**
 * 创建一个不保活事件循环的超时定时器；超过 Node 上限时夹到上限。
 * @param {() => void} fn - 超时回调。
 * @param {number} ms - 延时。
 * @returns {ReturnType<typeof setTimeout>}
 */
function unrefTimer(fn, ms) {
  const timer = setTimeout(fn, Math.min(ms, MAX_TIMER_MS));
  timer.unref?.();
  return timer;
}

/**
 * 解析子进程超时：默认 5 秒，可用 `DSH_APPROVAL_NOTIFY_TIMEOUT_MS` 覆盖，
 * 取值夹在 [100, 60000] 毫秒之间（非法值回退默认；超范围夹到边界）。
 * 每次调用时读取，方便测试在运行期切换。
 * @returns {number} 毫秒。
 */
function childTimeoutMs() {
  const raw = process.env[ENV_TIMEOUT_MS];
  if (typeof raw !== 'string' || raw.trim() === '') return CHILD_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n)) return CHILD_TIMEOUT_MS;
  return Math.min(Math.max(Math.round(n), MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
}

/**
 * 异步执行一个命令并收集 stdout / 退出码；永不 reject（结果用对象表示，
 * 以便区分“启动失败 / 退出码非 0 / 超时 / 被杀”）。
 * 超过超时时间时 `SIGKILL` 强杀。
 * @param {string} file - 可执行文件绝对路径。
 * @param {string[]} args - 参数数组（不经过 shell，天然免注入）。
 * @returns {Promise<{ ok: boolean, stdout: string | null, code: number | null, signal: string | null, timedOut: boolean, error: Error | null }>}
 */
function runCapture(file, args) {
  return new Promise((resolve) => {
    let done = false;
    let child;
    let timedOut = false;
    // 超时强杀。定时器 unref：子进程在跑时由它自己保活，结束后不拖住事件循环。
    const timer = unrefTimer(() => {
      timedOut = true;
      try {
        child?.kill('SIGKILL');
      } catch {
        /* 进程可能已经退出 */
      }
      settle({ ok: false, stdout: null, code: null, signal: null, timedOut, error: null });
    }, childTimeoutMs());

    function settle(value) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    }

    try {
      child = spawn(file, args, { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        out += chunk;
      });
      // 启动失败（命令不存在、没有执行权限……）走这里。
      child.on('error', (error) => settle({ ok: false, stdout: null, code: null, signal: null, timedOut, error }));
      // 注意：超时后 kill 会让 close 以 signal 到达，`done` 保证只 settle 一次。
      child.on('close', (code, signal) =>
        settle({ ok: !timedOut && code === 0, stdout: code === 0 ? out : null, code, signal: signal ?? null, timedOut, error: null }),
      );
    } catch (error) {
      settle({ ok: false, stdout: null, code: null, signal: null, timedOut, error });
    }
  });
}

/**
 * 异步执行一个命令，拿到“成功/失败”的结论；永不抛错。
 * unref 后不拖住事件循环（即使用户随后关掉了 dsh，命令自己会跑完并自行超时退出）。
 * @param {string} file - 可执行文件绝对路径。
 * @param {string[]} args - 参数数组。
 * @returns {Promise<{ ok: boolean, timedOut: boolean }>}
 */
function spawnQuiet(file, args) {
  return new Promise((resolve) => {
    let done = false;
    let child;
    const timer = unrefTimer(() => {
      try {
        child?.kill('SIGKILL');
      } catch {
        /* 已退出 */
      }
      settle({ ok: false, timedOut: true });
    }, childTimeoutMs());

    function settle(result) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    }

    try {
      child = spawn(file, args, { stdio: 'ignore' });
      child.on('error', () => settle({ ok: false, timedOut: false }));
      child.on('close', (code) => settle({ ok: code === 0, timedOut: false }));
      child.unref();
    } catch {
      settle({ ok: false, timedOut: false });
    }
  });
}

// ---------------------------------------------------------------------------
// 前台 App 检测
// ---------------------------------------------------------------------------

/**
 * 从 `lsappinfo info -only bundleid …` 的输出里解析 bundle id。
 * 不同系统版本的输出形态：
 *   (`bundleID="com.deepseek.dsh"` / `"bundleID"="com.deepseek.dsh"` / `"CFBundleIdentifier"="…"`)
 * 解析规则：找键名含 `bundleid`（不区分大小写）的那一行，取 `=` 之后引号里的值。
 * @param {string} text - lsappinfo 输出。
 * @returns {string | undefined} bundle id；解析不出时 undefined。
 */
export function parseFrontBundleId(text) {
  if (typeof text !== 'string') return undefined;
  for (const line of text.split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq);
    if (!/bundleid/i.test(key)) continue;
    const quoted = /"([^"]*)"/.exec(line.slice(eq + 1));
    if (quoted) return quoted[1].trim();
  }
  return undefined;
}

/**
 * 查询当前前台 App 的 bundle id。
 * 检测失败（命令不存在/超时/解析不出）返回 `undefined` —— 调用方按“不在前台”处理，
 * 宁可多提醒。
 * @returns {Promise<string | undefined>}
 */
async function frontBundleId() {
  // 测试开关：直接给出答案，不调用 lsappinfo。
  const simulated = process.env[ENV_FRONT];
  if (typeof simulated === 'string' && simulated !== '') return simulated.trim();

  const front = await runCapture(LSAPPINFO, ['front']);
  if (!front.ok || !front.stdout) return undefined;
  const asn = front.stdout.trim().split(/\s+/).pop();
  if (!asn) return undefined;

  // 用 ASN 查询：只传 bundle id 时，lsappinfo 会返回“最近使用过该 id 的任意 App”，
  // 即便它不在前台，所以要先把“谁是前台”固定下来再查它的 bundle id。
  const info = await runCapture(LSAPPINFO, ['info', '-only', 'bundleid', asn]);
  return parseFrontBundleId(info.stdout ?? '');
}

// ---------------------------------------------------------------------------
// 发送
// ---------------------------------------------------------------------------

/**
 * 找 terminal-notifier。
 * - 设置了测试开关 `DSH_APPROVAL_NOTIFY_TN`：只用它；文件不存在视为没找到（不执行）。
 * - 否则依次看候选路径，再看进程 PATH。
 * @returns {string | undefined}
 */
function findTerminalNotifier() {
  const override = process.env[ENV_TN];
  if (typeof override === 'string' && override.trim() !== '') {
    const file = override.trim();
    try {
      return existsSync(file) ? file : undefined;
    } catch {
      return undefined;
    }
  }
  for (const candidate of TERMINAL_NOTIFIER_CANDIDATES) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      /* 忽略 */
    }
  }
  const pathDirs = (process.env.PATH ?? '').split(':').filter(Boolean);
  for (const dir of pathDirs) {
    const candidate = join(dir, 'terminal-notifier');
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* 继续找 */
    }
  }
  return undefined;
}

/** 找 osascript：测试开关 `DSH_APPROVAL_NOTIFY_OSASCRIPT` 优先，默认 `/usr/bin/osascript`。 */
function osascriptPath() {
  const override = process.env[ENV_OSASCRIPT];
  if (typeof override === 'string' && override.trim() !== '') return override.trim();
  return OSASCRIPT;
}

/**
 * 真正发通知（日志模式除外）。永不抛错、永不阻塞调用方：返回的 Promise 只为测试而存在，
 * 监听器本身不会 await 它。
 * @param {{ title: string, subtitle: string, body: string }} notification - 通知内容。
 * @param {string} sound - 提示音名。
 * @returns {Promise<void>}
 */
async function deliver(notification, sound) {
  const full = { ...notification, sound };

  // ① 测试开关：追加一行 JSON，不执行任何命令。
  const logPath = process.env[ENV_LOG];
  if (typeof logPath === 'string' && logPath !== '') {
    try {
      appendFileSync(logPath, `${JSON.stringify(full)}\n`, 'utf8');
    } catch {
      /* 吞掉：写不进去就算了 */
    }
    return;
  }

  // ② terminal-notifier：点击通知会切回 dsh。
  let notifier;
  try {
    notifier = findTerminalNotifier();
  } catch {
    notifier = undefined;
  }
  if (notifier !== undefined) {
    let result = { ok: false };
    try {
      result = await spawnQuiet(notifier, [
        '-title', full.title,
        '-subtitle', full.subtitle,
        '-message', full.body,
        '-sound', full.sound,
        '-activate', DSH_BUNDLE_ID,
        '-group', 'dsh-approval',
      ]);
    } catch {
      /* 吞掉：当作失败，走补发 */
    }
    // 退出码为 0 就算成功；启动失败 / 退出码非 0（例如没有通知权限时退出码 3）/
    // 超时，都落到下面的 osascript 补发。
    if (result.ok) return;
  }

  // ③ osascript：没找到 terminal-notifier，或 terminal-notifier 失败/超时，补发一次。
  //    osascript 也失败就算了，不再重试。
  await spawnQuiet(osascriptPath(), ['-e', appleScriptFor(full)]);
}

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

/** 解析数值配置；非法值回退默认。 */
function numberOption(value, fallback, min) {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n) || n < min) return fallback;
  return n;
}

/** 把用户配置归一化（配置文件可能由人手写，宽容处理）。 */
function normalizeConfig(config) {
  const c = config !== null && typeof config === 'object' ? config : {};
  const sound = typeof c.sound === 'string' && c.sound.trim() !== '' ? c.sound.trim() : DEFAULT_SOUND;
  const throttleMs = numberOption(c.throttleMs, DEFAULT_THROTTLE_MS, 0);
  const notifyWhenFocused = c.notifyWhenFocused === true;
  return { sound, throttleMs, notifyWhenFocused };
}

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------

/**
 * 安装插件：注册唯一的 `approval/request` 监听器（prepend，排在最终应答者前面）。
 * @param {object} ctx - cordis 上下文。
 * @param {object} [config] - 插件配置（sound / throttleMs / notifyWhenFocused）。
 */
export function apply(ctx, config = {}) {
  const options = normalizeConfig(config);

  // —— 节流状态：属于这一次 apply，闭包私有 ——
  // `lastNotifiedAt`：上一条成功发出的通知的时间；`pending`：已通过节流判定、正在判定
  // “是否在前台”的请求数。同一个事件循环 tick 里的并发请求必须在同步阶段就完成节流判定，
  // 所以“占位”在 `notify` 的同步部分完成，前台判定异步进行，结束后再释放占位。
  let lastNotifiedAt = -Infinity;
  let pending = 0;

  // —— 配置：在 apply 时快照，运行期改配置不影响本实例 ——
  const throttleMs = options.throttleMs;
  const notifyWhenFocused = options.notifyWhenFocused;
  const sound = options.sound;

  /**
   * 发一条通知的完整判定链：节流 → 前台 → 发送。
   * 整条链都包在 try/catch 里，任何异常都不外溢；调用方不等待它。
   */
  const notify = async (req) => {
    // —— 同步段：节流判定 + 占位 ——
    // 距上一条通知不足 throttleMs，或已有请求正在处理时跳过（只发第一条）。
    if (throttleMs > 0) {
      if (pending > 0 || Date.now() - lastNotifiedAt < throttleMs) return;
    }
    pending += 1;

    // —— 异步段：前台判定 + 发送 ——
    let sent = false;
    try {
      // dsh 窗口在最前面时不发（审批框用户已经看得见），除非配置了 notifyWhenFocused。
      if (!notifyWhenFocused) {
        const front = await frontBundleId();
        if (front === DSH_BUNDLE_ID) return;
      }
      await deliver(buildNotification(req), sound);
      sent = true;
    } catch {
      /* 吞掉：通知失败绝不影响审批 */
    } finally {
      // 只有真正发出过通知才刷新节流时间；被跳过的请求不占用节流名额。
      pending -= 1;
      if (sent) lastNotifiedAt = Date.now();
    }
  };

  /**
   * `approval/request` 瀑布事件监听器。
   * 只观察不作答：先安排通知（不 await），再原样返回 `next()` 的结果。
   * @param {object} req - 审批请求。
   * @param {() => unknown} next - 交给下一个监听器。
   * @returns {unknown} `next()` 的返回值。
   */
  const listener = (req, next) => {
    try {
      // 同步启动通知流程（不 await），再原样返回 next()。`notify` 是 async 函数，
      // 同步段抛错会变成 rejected promise，`.catch` 兜住，杜绝未处理的 rejection。
      notify(req).catch(() => {});
    } catch {
      /* 吞掉 */
    }
    return next();
  };

  ctx.on('approval/request', listener, { prepend: true });
}

export default { apply };
