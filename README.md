# dsh-desktop-web-reload

在 DSH Desktop（Windows）标题栏的「编辑」右侧加一个「刷新」按钮。按下即可重新加载
DSH Desktop 页面 —— 安装完插件、改了配置之后，不用再去翻应用菜单。

**只要有任意对话正在运行，按钮就会变灰并禁止刷新**；点了也会弹出一条提示说明原因。
只有全部静默（没有任何会话在跑）时才允许刷新，避免把正在进行的对话打断。

## 为什么需要它

DSH 的客户端插件是在页面启动时按 profile 加载的。安装完一个插件后，页面不会自己重新
拉取插件包，所以新插件那个界面不会出现。桌面端本来在「应用」菜单里有一个「刷新页面」，
但要点两层菜单。这个插件把同一个动作放到了标题栏一级。

## 安装

```powershell
dsh plugin --profile desktop add link:C:/Users/Thinkbook/Documents/deepseek-harness/plugins/dsh-desktop-web-reload
```

然后把 `dsh-desktop-web-reload` 追加到 `~/.dsh/profiles/desktop/package.json` 的
`dsh.profile.bundles` 数组末尾（`dsh plugin add` 不会自动加这一项）。

**必须重启 DSH Desktop。** profile 的 bundle 列表是 Host 进程启动时读的，所以只刷新页面
不够 —— 重启之后按钮才会出现。之后再用这个按钮刷新页面就不需要重启了。

> 重启只有一条可靠路径：**右键系统托盘图标 →「退出 DeepSeek Harness」**。
> 直接关主窗口（或向它发 `WM_CLOSE`）都会被 shipped 代码拦下来变成「隐藏到托盘」——
> `createWindow` 的 `close` 处理里 `event.preventDefault()` 之后走 `backgroundNotice.close(hide)`，
> 所以窗口只是消失，进程还在。我实测过 `CloseMainWindow()` 和 `WM_CLOSE` 两种方式，
> 窗口句柄都还在，PID 也没变。只有托盘里的「退出」会真正 `app.quit()`。
>
> 另外我也实测过：改 `profiles/desktop/package.json` 的 mtime **不会**让运行中的 Host
> 热加载这个新 bundle（Host 的 config 目录仍然是 198 项、没有本插件那一行）。首次启用
> 必须重启。

## 按钮行为

| 状态 | 按钮 | 点击 |
| --- | --- | --- |
| 所有会话空闲 | 「刷新」用最深的文字色（可刷新就是"亮"的），悬停加背景高亮 | 重新加载页面 |
| 任意会话运行中 | 「刷新」降到最浅的文字色（禁用就是"灰"的），鼠标禁止光标 | 不刷新，在按钮下方弹出提示 |

两种状态的对比刻意拉大：可刷新时用 `--dsw-alias-label-primary`，禁用时用
`--dsw-alias-label-tertiary`，这两个 token 在 shipped 主题里分别是最深和最浅的一档
（浅色主题 `#0f1115` 对 `#81858c`，深色主题 `#f9fafb` 对 `#adb2b8`），所以一眼就能看出
现在能不能刷。因为空闲态本身就用了最深色，悬停时只加背景、不再变文字色。

这两个颜色**不只写在样式表里，还会在运行时解析后内联到按钮上**：插件用
`getComputedStyle(document.documentElement)` 读出 token 的真实取值，再直接写
`button.style.color`。这样做的原因是，如果某个主题没定义该 token，"未设值的变量代入
`color`"在计算值阶段是无效的，声明会被丢掉、按钮退回浏览器默认色 —— 表现就是"看起来
没变"。内联之后就绕开了这条路径；token 读不到时则退回样式表原有的规则，不会把颜色刷成
空白。切换主题会触发 `theme/change`，插件据此重新测量并重绘（按钮不是 React 组件，
不会自己重渲染）。

运行状态跟着会话列表和 Host 的状态推送实时更新（发现标题栏、等它挂载的那段轮询是
150ms 一次），点击的瞬间还会再复查一次，所以状态刚变化、界面还没重绘的那一瞬间也拦得住。

## 它是怎么接进标题栏的

Windows 上这条标题栏是 Electron **preload** 画的，不是 Cordis 插槽：
`app.asar!/lib/preload-app.cjs` 里的 `installWindowsMenu()` 会往 `document.body` 追加一个
`<div data-windows-menu>`，挂一个 **open** 的 shadow root，里面放 `role=menubar` 和
「应用」「编辑」两个按钮。这两个按钮通过 `dsh-desktop:windows-menu` IPC 打开**原生菜单**，
而主进程那边的处理函数把菜单名硬编码成了 `application` 和 `edit`。

DSH 现有的插槽里没有这一行（`shell.leading` 只在 macOS 且侧栏折叠时才挂载），也没有任何
客户端 API 可以注册标题栏按钮。所以唯一能碰到这一行的接缝就是 DOM 本身 —— 本插件的
`lib/client.js` 往那个 shadow root 里插一个按钮。

这意味着：

- 插件依赖 shipped 标题栏的 DOM 结构（`data-windows-menu` 宿主、`role=menubar` 那一行、
  以及侧栏发布的 `--dsh-windows-menu-start` 变量）。
- 那一行不存在时插件什么都不做，浏览器里（`dsh web`）也什么都不做。
- **不修改也不用修改 `app.asar`**，所以应用更新最多让按钮暂时消失，不会把壳弄坏。

按钮样式复用标题栏自带的 `--dsw-alias-*` 主题变量和尺寸，所以和「编辑」是同一套外观，
换主题、换语言都会跟着变。

## 目录

```
package.json          插件清单（dsh.client.platform + bundle patch）
cordis.patch.yml      往 profile 里插一行，让加载器解析这个包
lib/index.js          Node 半边：空的，不需要 Host 侧行为
lib/client.js         浏览器半边：注入按钮、判断静默、执行刷新
test/client.mjs       用假 DOM 跑上面那套逻辑，node test/client.mjs
```

## 测试

```powershell
node test/client.mjs
```

不需要浏览器也不需要 DSH 运行时：脚本按客户端的模块加载方式加载 `lib/client.js`，然后
对着一个复刻了 shipped 标题栏的假 DOM 验证按钮位置、静默判断、禁用提示和卸载清理，
共 21 项。

## 已验证到什么程度

- **在真实桌面窗口里渲染（已确认）**：重启 DSH Desktop 后按钮出现在「编辑」右侧，
  位置与样式经使用者目视确认无误。
- **加载与分发（已实测）**：用 `dsh web` 起了个临时 profile 装上本插件，页面 boot graph
  里出现了 `{"id":"dsh-desktop-web-reload","url":"plugins/??dsh-desktop-web-reload/client.js&rev=64ec4802cdcf"}`，
  并且这个 URL 真的以 `200` 返回了插件的 `client.js` 内容（Host 会剥掉源码里的
  `sourceMappingURL`、换成自己的，除此之外与磁盘上的文件一致）。也就是说
  `package.json` + `cordis.patch.yml` + 那一行 insert 的整条链路是通的。
  重启后在**运行中的 Host** 上也确认了这一行：
  `{"id":"include:desktop-web-reload","patchId":"desktop-web-reload","name":"dsh-desktop-web-reload"}`。
- **注入逻辑（已实测）**：`test/client.mjs` 的 21 项断言，覆盖按钮插在「编辑」右侧、
  运行中禁用、点击被拦、空闲时调用 `window.location.reload()`、卸载后恢复原样。
- **静默拦截（未在真机上验证）**：判断逻辑由上面那 21 项断言覆盖（对着与会话目录同构的
  数据），但「真实会话在跑时按钮确实变灰」没有在真机上确认过。
- **真机浏览器自动化（已尝试，环境不允许）**：本来打算用 CDP 驱动 Edge 对着真实页面做
  端到端断言，并给标题栏截图。Edge 起来后确实打印了
  `DevTools listening on ws://127.0.0.1:9336/...`，但本会话的沙箱把这个回环端口挡掉了
  （IPv4 直接 refuse，`[::1]` 返回 502），所以这条路走不通，尝试用的脚手架已删除。

## 已知限制

- **只支持 Windows。** macOS 的标题栏是另一套布局，没有这条 menubar。
- 只刷新页面（重新走一遍页面启动、重新拉取客户端插件包）。它**不会**重启 Host 进程；
  要重启 Host 用「应用」菜单里的「重启应用与 Host」。
- 判断静默看的是客户端会话目录里所有会话的 `running` 标记。这个标记由 Host 推送，覆盖
  桌面端已知的全部会话；但 Host 上的后台作业（jobs、定时任务）如果和任何会话都无关，
  它不会体现在这个标记里。
- 首次启用**必须重启**：往 `dsh.profile.bundles` 里新加一个 bundle 之后，运行中的 Host
  不会自己把它热加载进来（实测过改 `package.json` 的 mtime，Host 的 config 树没有变化）。
  重启一次之后就正常了 —— 之后改 `lib/client.js` 走 HMR 热更新，不需要再重启。
