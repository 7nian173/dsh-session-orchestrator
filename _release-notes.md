## dsh-session-bridge · v0.1.0 首个发布

让 DeepSeek Harness 里的多个会话可以互相创建、互相跳转、互相写信。

### 适配基线

| 项 | 版本 |
|---|---|
| DeepSeek Harness（社区版） | `0.2.2-rc.1` |

版本号取自本机正在运行的实例，是当前的兼容基线。

### 安装

桌面版只能用插件管理器，profile `desktop` 由 Electron 独占管理：

```
plugin_manager action=install_bundle target=<插件目录绝对路径>
```

非桌面 profile 可以一条命令装完：

```
dsh plugin --profile <环境名> add github:7nian173/dsh-session-orchestrator
```

也可以下载下面的 tgz 离线安装：

```
pnpm add <下载路径>/dsh-session-orchestrator-0.1.0.tgz
```

### 附件

- `dsh-session-orchestrator-0.1.0.tgz` 是 `npm pack` 产物，12 个文件，含 `lib/`、`tools/`、`docs/`、两版 README 与协议
- `Source code` 压缩包由 GitHub 自动生成

### 里面有什么

- 建会话、交棒、界面跳转，跳转带一次性返回按钮
- 工作区信箱：信件落在工作区，投递只推三行索引，正文不进消息
- 会话群：按阈值自动成组，交集合并，另有建会话时开的专用通道
- 11 个模型工具、20 个队列 action
- 自检脚本 `tools/mail-push-test.mjs`，34 项断言

### 已知代价

- 会在目标工作区根目录建信箱目录 `.dsh-mail/`
- 每次投递多一条宿主注入，约 96 tokens，插件侧消不掉
- 信封头由插件维护，手改会被下一次状态变化覆盖

### 许可

CC BY-NC 4.0，可改、须署名、禁商用。带非商业条款的协议不属于 OSI 开源，请按「源码可见」理解。

架构图：[https://7nian173.github.io/dsh-session-orchestrator/architecture.html](https://7nian173.github.io/dsh-session-orchestrator/architecture.html)
