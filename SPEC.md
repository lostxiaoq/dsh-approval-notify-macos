# dsh-approval-notify-macos — 审批时发 macOS 系统通知

DeepSeek Harness（dsh）插件。每当 dsh 需要用户审批一个操作（例如沙箱升权、敏感工具调用），弹一条 macOS 通知提醒用户回到 dsh 处理。**只提醒，不作答**：不能改变、延迟或替代原有的审批流程。

## 背景：dsh 的审批机制（已调研，可直接用）

- 审批服务是内置包 `@deepseek-ai/dsh-user-approval`。它把每个审批请求通过 **`approval/request` 瀑布事件（waterfall）** 依次交给各个监听器：监听器返回一个结果就算作答，否则调用 `next()` 交给下一个。最终应答者是桌面界面（`dsh-client-ui-approval`）。
- 请求对象 `req` 的字段：`agent`、`toolName`（工具名）、`reason`（原因，可选）、`displayReason`（本地化展示文案，可选）、`callId`（可选）、`signal`（AbortSignal，可选）。**没有工具参数**。
- **`displayReason` 实际是 `{ en, zh }` 字典**（执行者实现时发现，例如沙箱升权传 `{en:"Allow this operation with …", zh:"允许本次操作使用 … 权限：…"}`），也可能是纯字符串：字符串直接用，字典优先取 `zh`，没有就取 `en`。
- 插件用 `ctx.on("approval/request", listener, { prepend: true })` 注册，`prepend: true` 保证排在最终应答者前面（参考 `@vectorize-io/hindsight-coding-agents` 的 `ctx.on("agent/pre-step", …, { prepend: true })`）。
- 插件包结构参考本机已装的 `~/.dsh/profiles/desktop/node_modules/dsh-plugin-wallpaper-engine`：ESM（`"type": "module"`），入口导出 `apply(ctx, config)`，并 `export default { apply }`；`package.json` 里 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`；`cordis.patch.yml` 用 `insert` 注册一行。
- 原有审批服务源码可读：用 `ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" -e "…"` 读取 `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-user-approval/README.zh.md` 和 `lib/index.js`。

## 文件与接口（验收测试按这里写，名字必须一致）

```
package.json        name: "dsh-approval-notify-macos"，type: module，main: lib/index.js，零依赖（不要 dependencies）
cordis.patch.yml    - insert: [ { id: approval-notify, name: dsh-approval-notify-macos } ]
lib/index.js        插件本体
README.md           中文说明：做什么、怎么装、配置项、测试开关
```

`lib/index.js` 必须导出：

- `apply(ctx, config = {})`：调用一次 `ctx.on("approval/request", listener, { prepend: true })`。节流状态属于这一次 `apply`（每次调用 `apply` 都是独立状态）。
- `buildNotification(req)` → `{ title, subtitle, body }`
  - `title`：`"DeepSeek Harness"`
  - `subtitle`：`"⚠️ 有操作等你批准"`
  - `body`：`"<toolName>：<displayReason（按上面规则取文本） ?? reason>"`；没有原因时只写工具名；没有工具名用 `"未知操作"`。去掉首尾空白，换行替换成空格，**最多 160 个字符**（超出截断并以 `…` 结尾，总长仍 ≤160）。
- `appleScriptFor(n)` → 用于 `osascript -e` 的脚本字符串：`display notification "<body>" with title "<title>" subtitle "<subtitle>" sound name "<sound>"`，三个文本里的 `\` 和 `"` 都要转义（`\` → `\\`，`"` → `\"`）。
- `export default { apply }`

## 监听器行为

`listener(req, next)`：

1. **先**安排发通知（火了就走，不等待结果），**再** `return next()`，原样返回 `next()` 的结果。
2. **绝不抛错**：发通知过程中任何异常（命令不存在、日志文件写不进去、超时）都吞掉，`next()` 照常调用并返回。
3. **绝不阻塞**：不能 `await` 发通知的过程；子进程用 `spawn`/`execFile` 异步执行，5 秒超时。
4. `next` 只调用一次。

## 什么时候不发

- **dsh 窗口在最前面时不发**（用户已经看得到审批框）：用 `lsappinfo info -only bundleid "$(lsappinfo front)"` 取前台 App 的 bundle id（不同系统版本输出可能是 `bundleID="com.deepseek.dsh"`、`"bundleID"="…"` 或 `"CFBundleIdentifier"="…"`，都要能解析：在键名含 `bundleid` / `CFBundleIdentifier`（不区分大小写）的那一行取 `=` 后引号里的值），等于 `com.deepseek.dsh` 就跳过。配置 `notifyWhenFocused: true` 时照发。检测失败当作「不在前台」（宁可多提醒）。
- **节流**：`throttleMs`（默认 3000）内只发第一条，其余跳过；`throttleMs: 0` 不节流。

## 怎么发

1. 如果设置了环境变量 `DSH_APPROVAL_NOTIFY_LOG=<文件路径>`（测试开关）：往该文件追加一行 JSON `{"title","subtitle","body","sound"}`，**不执行任何命令**。写入可以同步（`appendFileSync`），失败吞掉。
2. 否则，如果找得到 `terminal-notifier`：`terminal-notifier -title … -subtitle … -message … -sound <sound> -activate com.deepseek.dsh -group dsh-approval`（点击通知会切回 dsh）。
   - 查找顺序：环境变量 `DSH_APPROVAL_NOTIFY_TN`（测试开关；设置了就只用它，文件不存在则视为没找到）→ `/opt/homebrew/bin/terminal-notifier` → `/usr/local/bin/terminal-notifier`。
   - **补发**：terminal-notifier 启动失败（spawn 报错）、退出码非 0（例如没有通知权限时退出码 3）、或超时，都改用第 3 步的 `osascript` **补发一次**。退出码为 0 则不补发。
3. 否则（或补发时）用 osascript：`<osascript> -e <appleScriptFor(n)>`，`<osascript>` 默认 `/usr/bin/osascript`，可用环境变量 `DSH_APPROVAL_NOTIFY_OSASCRIPT` 覆盖（测试开关）。osascript 失败就算了，不再重试。
4. 子进程超时默认 5000 毫秒，可用环境变量 `DSH_APPROVAL_NOTIFY_TIMEOUT_MS` 覆盖（测试开关，取值限制在 100–60000），超时用 `SIGKILL` 结束子进程。
5. 整个发送过程仍然**不阻塞监听器**：补发也发生在后台的通知流程里，`next()` 不等它。

## 配置项（cordis.patch.yml 里可写 config）

| 字段 | 默认 | 含义 |
|---|---|---|
| `sound` | `"Glass"` | 提示音名称（macOS 系统声音） |
| `throttleMs` | `3000` | 节流间隔 |
| `notifyWhenFocused` | `false` | dsh 在前台时是否也通知 |

## 测试开关（环境变量）

| 变量 | 作用 |
|---|---|
| `DSH_APPROVAL_NOTIFY_LOG` | 写日志代替真正发通知 |
| `DSH_APPROVAL_NOTIFY_FRONT` | 模拟前台 App 的 bundle id，设置后不再调用 `lsappinfo` |
| `DSH_APPROVAL_NOTIFY_TN` | 指定 terminal-notifier 路径（测试时指向假脚本） |
| `DSH_APPROVAL_NOTIFY_OSASCRIPT` | 指定 osascript 路径（测试时指向假脚本） |
| `DSH_APPROVAL_NOTIFY_TIMEOUT_MS` | 子进程超时毫秒数（100–60000） |

## 约束

- 不联网、不读用户文件、不记录工具参数（本来也拿不到）。
- 只用 Node 内置模块，零依赖。
- 代码清晰，中文注释。
