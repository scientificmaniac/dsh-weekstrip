<div align="center">

![dsh-weekstrip 宣传图](docs/banner.zh.png)

# dsh-weekstrip

为 **DSH Desktop** / **DSH NEXT** / **官方 0.2.1-rc.5 客户端**（DeepSeek Harness）准备的社区补丁：
在 **设置 → 账号与余额** 下方增加一块本地用量面板，包含 Token 统计、近 7 天用量与活跃度。

![License: MIT](https://img.shields.io/badge/License-MIT-blue) ![DSH Desktop / NEXT](https://img.shields.io/badge/DSH%20Desktop%20%2F%20NEXT-0.2.1--rc.2%20%7C%20rc.4%20%7C%20rc.5-4D6BFE) ![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933) ![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)

简体中文 · [English](README.en.md)

</div>

> [!NOTE]
> 这是社区补丁，不是 DeepSeek 官方功能。它只修改你自己机器上 DSH 安装目录里的那个账号设置 bundle：<br>
> **loose 布局**（旧版 DSH Desktop）直接改 `resources/app/...` 下的文件；**asar 布局**（DSH NEXT 与
> 0.2.1-rc.5 起的官方客户端）把整个应用打进 `resources/app.asar`，补丁会把改好的 bundle 放进
> `resources/app.asar.unpacked/...`，并且只在归档头里把该条目标记为 unpacked。<br>
> asar 内的实际路径随构建变化（`node_modules/...` 或 `dsh/node_modules/...`），补丁按路径后缀自动定位。<br>
> 应用升级会替换安装文件，补丁随之失效，重跑一次即可；`revert` 可以逐字节还原。

浅色 / 深色静态预览：[`docs/preview.html`](docs/preview.html)（下载后用浏览器打开）。

## 效果图

![中文界面效果图](docs/screenshot.zh.png)

## 新增内容

| 卡片 | 内容 | 数据来源 |
| --- | --- | --- |
| **Token 统计** | 累计计费 tokens、四段构成条（输入 / 缓存命中 / 缓存写入 / 输出）及占比、模型请求数 | 官方 `tokenUsage` 会话投影；缺失时退回 `contextActivity` 按天账本 |
| **近 7 天用量** | 每个本地日历日一根柱、7 天合计与日均 | `contextActivity.days`（dsh-context 注册的按天账本） |
| **活跃度** | 近 7 天强度格、活跃天数 x/7、连续天数、回合数、工具调用数 | 同上（`requests` / `turns` / `toolCalls`） |

- 口径为**全部会话**（含子代理会话，且不重复计入父会话）。
- 按**浏览器本地时区**切日；跨零点自动重算，无需刷新。
- 只读本机会话数据，面板自身不发起网络请求；唯一的外部请求是可选的
  `POST api/dsh-context/backfill`（同源、dsh-context 插件的回填路由）。

## 环境要求

| | |
| --- | --- |
| DSH Desktop / DSH NEXT / 官方客户端 | 已安装的桌面版；锚点针对 **0.2.1-rc.2**（loose 布局）、**0.2.1-rc.4**（DSH NEXT，asar 布局）与 **0.2.1-rc.5**（官方客户端，asar 内 `dsh/` 前缀）验证 |
| Node.js | **18 或更高**（仅补丁脚本需要） |
| dsh-context 插件 | 可选。未安装时：累计 Token 仍可用，按天窗口/活跃度可能为空 |

## 安装

补丁改的是安装目录里的账号设置 bundle，两种安装布局都支持：

| 布局 | 目标 | 写入方式 |
| --- | --- | --- |
| loose（旧版 DSH Desktop） | `<resources>/app/node_modules/@deepseek-ai/dsh-client-ui-settings-account/lib/client.js` | 备份后原地替换该文件 |
| asar（DSH NEXT / 0.2.1-rc.5 官方客户端） | `<resources>/app.asar` 内的同一条目（归档根下或 `dsh/` 下，按后缀自动定位） | 补丁写进 `<resources>/app.asar.unpacked/...`，并只重写归档头把该条目标记为 `unpacked`（数据区不动） |

显式传 `resources` 目录、`app.asar` 路径，或用环境变量：

```powershell
# Windows 默认在 %LOCALAPPDATA%\Programs\... 下；自定义目录（例如 E:\DSHDesktop）就传它下面的 resources
node src/patch.mjs status --resources "<install>/resources"   # 自动识别两种布局
node src/patch.mjs verify --resources "<install>/resources"   # 只校验锚点与语法，不写文件
node src/patch.mjs apply  --resources "<install>/resources"   # 备份后打补丁
```

```powershell
# 也可以直接指定目标
node src/patch.mjs apply --asar "<install>/resources/app.asar"          # asar 布局
node src/patch.mjs apply --bundle "<...>/lib/client.js"                # loose 布局（或 asar 内路径）

# 或用环境变量
$env:DSH_RESOURCES_ROOT = "<install>/resources"   # PowerShell
$env:DSH_ASAR = "<install>/resources/app.asar"
$env:DSH_ACCOUNT_BUNDLE = "<...>/lib/client.js"
```

`apply` 是幂等的：已打补丁会直接跳过。每次写入前都会备份到 `backups/`，并在替换前用
`node --check` 做语法门禁。asar 布局下如果归档头放不下新内容（例如归档没有 integrity 冗余），
会自动退化成「整份归档重写」，此时需要先完全退出 DSH。

然后**完全退出并重新启动 DSH**（Web 外壳在 host 启动时对插件 bundle 做快照，刷新页面不会重新读取），
打开 **设置 → 账号与余额**。

### 自定义安装位置

自动探测覆盖默认位置（Windows 的 `%LOCALAPPDATA%\Programs\DSH Desktop`、`DSH NEXT` 与 `Program Files`；
macOS 的 `/Applications`；Linux 的 `/opt`、`/usr/lib`、`~/.local/share`）。如果 `status` 提示找不到 bundle，
按上面的方式传 `--resources` / `--asar` / `--bundle`。

如果你用的是源码启动或全局 npm 安装的 DSH，把 `--bundle` 指向那份安装里的
`node_modules/@deepseek-ai/dsh-client-ui-settings-account/lib/client.js`。

## 回滚与升级

```powershell
node src/patch.mjs revert --resources "<install>/resources"   # 还原最近一次备份
```

- 备份在 `backups/`（已被 .gitignore 忽略）：
  - loose 布局：`client.js.<时间戳>.bak`（整个 bundle 文件）；
  - asar 布局：`app.asar.<时间戳>.hdr` + `.json`（原始归档头，写入时数据区未改动，所以回滚能把归档
    恢复成**逐字节一致**的原样）；若走了整份重写，则保存 `app.asar.<时间戳>.bak`。
- 回滚会同时删掉 `app.asar.unpacked` 里由补丁创建的覆盖文件。
- 如果安装文件在打补丁后被更新/替换（`revert` 会比对归档大小），回滚会拒绝执行，避免把旧归档头写进新归档——
  此时重装或更新后重新 `apply` 即可。
- 应用升级会替换安装文件（asar 布局会整份换掉 `app.asar`），补丁随之消失——重跑一次 `apply` 即可。
- 若新版本的 bundle 结构变了，锚点将无法匹配：`apply` 会以
  `anchor "<name>" matched 0 time(s)` 中止，且**不修改文件**。此时应补充锚点表（或提 PR），不要强行套用。

## 实现方式

账号设置页是一个 `settings.section` slot 条目，自身没有子 slot，所以面板通过五处锚点修改已编译的
client bundle 插入：

1. `en` / `zh` 账号字典追加面板文案；
2. 在 `AccountSection` 区域前插入自包含模块（`src/snippet.js`）；
3. 原组件更名为 `AccountSectionMain`；
4. 新增 `AccountSection`，用 `Fragment` 同时渲染原组件与用量面板；
5. `settings.section` 注册项的注入里追加 `refreshSessions`（回填后重新读取会话列表）。

面板读取框架的 `useSessions` 标准钩子（root scope 标准 kit），自带错误边界（面板出错不会连累账号与余额卡片），
钩子缺失时整块不渲染。

### 打包形态：loose 布局与 asar 布局

账号设置 bundle 在不同构建里的存放方式不同，`apply` 会按布局选择写入方式：

- **loose**（旧版 DSH Desktop）：`resources/app/` 是解包目录，备份后原地改写 `lib/client.js`。
- **asar**（DSH NEXT、0.2.1-rc.5 起的官方客户端）：整个应用打进 `resources/app.asar`。Electron 的 asar
  读取器会把 header 中 `unpacked: true` 的条目改从 `resources/app.asar.unpacked/<path>` 读取（原生模块
  就是这么发布的）。补丁因此只做两件事：把改好的 bundle 写到对应的 `.unpacked` 路径；重写归档头
  （约 5 MB）把该条目标记为 unpacked、刷新 `size`、去掉已失效的 `integrity`。归档数据区完全不动，
  回滚只需写回原始头部，恢复后与打补丁前**逐字节一致**。
- asar 内的目录前缀不固定：`0.2.1-rc.4`（DSH NEXT）是归档根的 `node_modules/...`，`0.2.1-rc.5`
  （官方客户端）把运行时嵌在 `dsh/` 下面（`dsh/node_modules/...`）。补丁按
  `node_modules/@deepseek-ai/dsh-client-ui-settings-account/lib/client.js` 后缀遍历归档头定位，
  两种前缀都能命中。若归档里出现**两份**同名 bundle，补丁会中止并列出候选，要求用
  `--bundle "<install>/resources/app.asar/<path>"` 指定，不会猜测。

这条路径依赖 Electron 自身的 asar 语义，并已实测：`0.2.1-rc.5` 官方客户端的宿主进程由
`DeepSeek Harness.exe` 以 `ELECTRON_RUN_AS_NODE=1` 启动，读取客户端 bundle 时走 Electron 的 asar 垫片，
`readFileSync` / `stat` 都会命中 `.unpacked` 覆盖；该客户端启用了 asar 的 `unpacked` 机制，
但**没有**开启 `EnableEmbeddedAsarIntegrityValidation`，所以重写头部不会触发完整性校验。

## 开发与测试

```powershell
npm run check          # CI 门禁：语法 + 补丁引擎测试 + 聚合逻辑测试（无需安装）
npm run engine-test    # 锚点处理、插入、幂等、拒绝路径、安装路径探测、asar 头往返/覆盖/回滚
npm run logic-test     # 窗口 / 连续天数 / 四桶 / 敌意数据降级
npm run load-test      # 按 __ModuleLoader__ 协议执行补丁后 bundle（需要安装）
npm run render-test    # 用 React 垫片渲染面板并断言文案与数字
npm run preview        # 重新生成 docs/preview.html（浅色 + 深色，中文）；加 -- --locale en 生成英文版
```

需要真实安装的测试在找不到安装时会以退出码 0 跳过；对 asar 布局的安装跑加载/渲染测试时传
`-- --resources "<install>/resources"`，它会从 `app.asar`（或已打的 `.unpacked` 覆盖）里读 bundle。
已验证版本登记在 `src/anchors.mjs` 的 `VERIFIED_VERSIONS` 中。

## 兼容性

| DSH 版本 | 状态 |
| --- | --- |
| `0.2.1-rc.2` | 已验证（loose 布局，锚点端到端测试） |
| `0.2.1-rc.4` | 已验证（DSH NEXT，asar 布局，含覆盖与回滚往返） |
| `0.2.1-rc.5` | 已验证（官方客户端，asar 内 `dsh/` 前缀，含覆盖与回滚往返） |
| 其它版本 | 会尝试套用；锚点移动则安全中止 |

## 许可与隐私

- 许可：[MIT](LICENSE)。与 DeepSeek 无关联；“DeepSeek Harness”“DSH”等标识归其所有者。
- 补丁只修改**你本机的安装**，不附带任何 DSH 代码、修改后的 bundle 或二进制。
- 无遥测、无远程存储：面板只读浏览器里已有的会话投影，另可选调用本地插件同源的回填路由。
- 第三方声明：[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 致谢

- [dsh-context](https://github.com/bowenliang123/dsh-context)：提供了本面板使用的按天活动投影、回填路由与视觉语言。
- DSH 团队：公开了客户端包与源码布局（MIT）。

参与贡献：[CONTRIBUTING.md](CONTRIBUTING.md)
