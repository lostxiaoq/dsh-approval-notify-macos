# dsh-approval-notify

DeepSeek Harness（dsh）插件：**每当 dsh 需要你审批一个操作**（例如沙箱升权、敏感工具调用）时，弹一条 **macOS 系统通知**，提醒你回到 dsh 窗口处理。

而当你正盯着 dsh 窗口时，审批框本来就看得见，插件会自动安静下来，不打扰你。

> **只提醒，不作答。** 本插件不会批准、不会拒绝，也不会延迟或替代原有的审批流程——它只是在审批请求发生时“顺手喊你一声”。

## 它会做什么

- 监听 dsh 内置审批服务的 `approval/request` 事件（瀑布式事件，waterfall），排在最终应答者（桌面界面）前面；
- 发一条通知后**立刻**把请求原样交给下一个监听器，审批结果完全不受影响；
- 通知内容：
  - 标题：`DeepSeek Harness`
  - 副标题：`⚠️ 有操作等你批准`
  - 正文：`<工具名>：<原因>`，例如 `bash：允许本次操作使用 workspace-write 权限：…`
    - 优先使用审批请求的本地化展示文案（`displayReason`），没有时退回原始原因（`reason`）；
    - 都没有时只写工具名；连工具名都没有时写 `未知操作`；
    - 换行折成空格、去掉首尾空白，最长 160 个字符（超出截断并以 `…` 结尾）。
- 通知会在以下情况被跳过：
  - **dsh 窗口在最前面**——你已经看得到审批框了（可用 `notifyWhenFocused: true` 关闭这一行为）；
  - **节流**——默认 3 秒内只发第一条，连续弹出多个审批时不会刷屏。

它**不会**拦截审批、**不会**记录工具参数（审批请求本身也不携带参数），**不会**联网，**不会**读写你的其他文件。

## 安装

要求：macOS + 已安装的 DeepSeek Harness 桌面版（捆绑 dsh）。插件零依赖，不需要 `npm install` 任何东西。

**方式一：手动装进 dsh 配置目录**

1. 把本目录整个复制（或软链）到 dsh 配置目录的 `node_modules` 下，名字必须是 `dsh-approval-notify`：

   ```sh
   mkdir -p ~/.dsh/profiles/desktop/node_modules
   cp -R /path/to/dsh-approval-notify ~/.dsh/profiles/desktop/node_modules/dsh-approval-notify
   ```

2. 在 `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` 数组里追加一行：

   ```json
   "bundles": [
     "@deepseek-ai/dsh-base",
     "@deepseek-ai/dsh-web-app",
     "dsh-approval-notify"
   ]
   ```

   如果 `package.json` 的 `dependencies` 里有本包名，请保持其版本为 `file:` 或已安装的版本，否则 dsh 启动时会尝试从网络安装。

3. 重启 DeepSeek Harness。

`bundles` 里的每一项都会应用它自己的 `cordis.patch.yml`。本插件的 `cordis.patch.yml` 只有一行插入：

```yaml
- insert:
    - id: approval-notify
      name: 'dsh-approval-notify'
```

**方式二：发到 npm 后由插件管理器安装**

本包的 `package.json` 已声明 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`，发布到 npm 后可直接在 dsh 的插件管理器里安装，无需再手改配置。

## 配置项

在 `~/.dsh/profiles/desktop/cordis.patch.yml`（或你自己的被包含的配置文件）里，按 `id` 覆盖这一行的 `config`：

```yaml
- id: approval-notify
  name: 'dsh-approval-notify'
  config:
    sound: 'Ping'
    throttleMs: 5000
    notifyWhenFocused: false
```

也可以直接改本插件的 `cordis.patch.yml`，在 `insert` 的那一行里写 `config`。

| 字段 | 默认 | 含义 |
|---|---|---|
| `sound` | `"Glass"` | 提示音名称（macOS 系统声音，如 `Glass`、`Ping`、`Submarine`、`Hero`、`Funk`；即 `/System/Library/Sounds/*.aiff` 的文件名） |
| `throttleMs` | `3000` | 节流间隔（毫秒）。间隔内**只发第一条，其余跳过**（不排队、不合并后补发）；设为 `0` 表示不节流 |
| `notifyWhenFocused` | `false` | `true` 时即使 dsh 窗口在最前面也照发通知 |

## 通知是怎么发的

按优先级依次尝试：

1. **测试开关**（见下文）：设置 `DSH_APPROVAL_NOTIFY_LOG` 时只写日志，不执行任何命令；
2. **terminal-notifier**：如果在 `/opt/homebrew/bin/terminal-notifier`、`/usr/local/bin/terminal-notifier` 或 dsh 进程的 `PATH` 里找到了它，就用它发：

   ```sh
   terminal-notifier -title … -subtitle … -message … -sound <sound> -activate com.deepseek.dsh -group dsh-approval
   ```

   `-activate com.deepseek.dsh` 表示**点击通知会切回 dsh**（推荐安装：`brew install terminal-notifier`，不装也能用，只是点击通知不会跳转）。
3. **osascript**：兜底使用 `/usr/bin/osascript -e 'display notification … with title … subtitle … sound name …'`。这种方式的局限性：
   - 通知的 App 图标来自“脚本编辑器”（Script Editor）；
   - 点击通知不会切回 dsh；
   - 如果你的 macOS 对“脚本编辑器”关闭了通知权限，就看不到这一条通知。可以在「系统设置 → 通知 → 脚本编辑器」里打开。

所有命令都是异步执行、5 秒超时，且**不经过 shell**（参数以数组形式传入，天然免注入）。

### 前台检测

用 `lsappinfo` 判断当前最前面的 App：

```sh
lsappinfo info -only bundleid "$(lsappinfo front)"
```

解析出前台 App 的 bundle id，等于 `com.deepseek.dsh` 时就跳过本次通知。检测失败（命令不可用、输出格式变了、超时）时按**“不在前台”**处理——宁可多提醒一次，也不要漏掉。

## 测试开关（环境变量）

| 变量 | 作用 |
|---|---|
| `DSH_APPROVAL_NOTIFY_LOG` | 设为文件路径后，不真正发通知，而是往该文件追加一行 JSON：`{"title","subtitle","body","sound"}` |
| `DSH_APPROVAL_NOTIFY_FRONT` | 模拟前台 App 的 bundle id。设置后不再调用 `lsappinfo`，用它判断“dsh 是否在前台” |

手工试一下（不会弹任何系统通知）：

```sh
DSH_APPROVAL_NOTIFY_LOG=/tmp/approval.log \
DSH_APPROVAL_NOTIFY_FRONT=com.apple.finder \
node --input-type=module -e '
  import { apply } from "./lib/index.js";
  const regs = [];
  apply({ on: (name, fn) => regs.push(fn) }, { sound: "Ping" });
  await regs[0]({ toolName: "bash", reason: "需要联网" }, () => "delegated");
'
cat /tmp/approval.log
# {"title":"DeepSeek Harness","subtitle":"⚠️ 有操作等你批准","body":"bash：需要联网","sound":"Ping"}
```

## 开发与测试

```sh
node --test "tests/accept/*.test.mjs"
```

验收测试全部使用上面两个测试开关，不会弹出系统通知。

`lib/index.js` 的导出：

| 导出 | 说明 |
|---|---|
| `apply(ctx, config = {})` | 注册监听器（`ctx.on("approval/request", listener, { prepend: true })`）；节流状态属于这一次 `apply` |
| `buildNotification(req)` | 由审批请求生成 `{ title, subtitle, body }` |
| `appleScriptFor(n)` | 生成 `osascript -e` 用的 AppleScript 脚本（转义 `\` 和 `"`） |
| `default` | `{ apply }` |

## 已知限制

- 只在 macOS 上有意义（`lsappinfo`、`osascript`、macOS 系统声音）。
- “dsh 窗口在最前面”只在 dsh 桌面版（bundle id `com.deepseek.dsh`）下生效。
- 通知正文不包含工具参数（审批请求本身不携带参数）。
- 通知权限由 macOS 管理：如果终端通知被系统关闭，插件不会报错，只是你收不到。

## 许可

MIT
