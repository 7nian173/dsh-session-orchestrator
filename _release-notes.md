## dsh-session-bridge · v0.1.1

让 DeepSeek Harness 里的多个会话可以互相创建、互相跳转、互相写信。

### 适配基线

| 项 | 版本 |
|---|---|
| DeepSeek Harness（官方桌面端） | `0.2.2-rc.3` |
| 内置运行时 | Node `24.21.0` / pnpm `11.28.5` |

版本号取自本机正在运行的官方实例，是当前的兼容基线。

### 这一版改了什么

- **适配官方 0.2.2-rc.3**，在官方实例上跑通完整链路
- **新增 `TARGET_ARCHIVED`**：目标会话已归档时直接报错，不再退回 `prompt` 投进死信箱
- **投递回执带 `scheduleError`**：`schedule` 通道失败时能看到真实原因
- 文档去掉社区版口径，环境依赖表按官方实例的实际版本重写

### 安装

桌面版只能用插件管理器：

```
plugin_manager action=install_bundle target=<插件目录绝对路径>
```

非桌面 profile 一条命令：

```
dsh plugin --profile <环境名> add github:7nian173/dsh-session-orchestrator
```

离线安装用下面的 tgz：

```
pnpm add <下载路径>/dsh-session-orchestrator-0.1.1.tgz
```

### 附件

- `dsh-session-orchestrator-0.1.1.tgz`，12 个文件，含 `lib/`、`tools/`、`docs/`、两版 README 与协议

### 已知代价

- 会在目标工作区根目录建信箱目录 `.dsh-mail/`
- 每次投递多一条宿主注入，约 96 tokens，插件侧消不掉
- 信封头由插件维护，手改会被下一次状态变化覆盖

### 许可

CC BY-NC 4.0，可改、须署名、禁商用。带非商业条款的协议不属于 OSI 开源，请按「源码可见」理解。

架构图：[https://7nian173.github.io/dsh-session-orchestrator/architecture.html](https://7nian173.github.io/dsh-session-orchestrator/architecture.html)
