# WeChat Group Bot

面向普通微信群的文字聊天与群聊总结机器人，基于 **DeepSeek Harness SDK、MimicWX 和 SQLite 持久队列**。设计运行于 Linux 服务器，不需要操作者一直开着本地电脑。

> 本仓库是脱敏后的源码快照，并非开箱即用的发行包。独立聊天/总结 worker 已有代码和独立测试，真实部署验收仍需完成。图片识别和自动 UI 取图已关闭；微信登录资料、聊天数据库、凭据、DSH 运行时及定制 MimicWX 源码均未包含。

## 功能

| 功能 | 说明 |
|---|---|
| 日常聊天 | 通过真实 @ 元数据触发，普通群消息只入库 |
| 显式总结 | `/总结`、`/summary`，支持指定日期 |
| 并行总结 | 分批提取事实、有限并发归并、持久化中间结果 |
| 独立处理通道 | chat worker 与 summary coordinator 分别领取任务 |
| 成员身份与记忆 | 使用稳定成员 ID，避免按昵称合并身份 |
| 联网搜索 | chat 专用搜索工具及执行前工具预算 |
| 可追溯输出 | 总结保留来源消息 ID、覆盖范围和缺失说明 |
| 可靠发送 | 持久 outbox、单发送器、发送确认与 uncertain 状态 |

## 群内使用

```text
@机器人 你好，简单介绍一下自己
/总结
/summary
/总结 2026-10-28
/summary 2026-10-28
```

@ 需要从微信成员列表选择，手打 `@昵称` 不等于真实 @。当前代码默认总结 **Asia/Shanghai 前一天全天**；带日期时总结指定日期。普通文字、引用或代码块中的命令字样不应触发总结。最终行为以路由代码和配置为准。

## 架构

```text
微信群消息 → ingest → reliability.db → 确定性路由
                                          ├─ chat worker
                                          │    └─ 群聊天 Session / 成员记忆
                                          └─ summary coordinator
                                               ├─ 并行批次提取
                                               ├─ 有界事实归并
                                               └─ 来源校验 / 分段渲染
                                          ↓
                                     持久 outbox
                                          ↓
                                     单发送器 → 微信
```

总结的并行任务使用独立 SDK Session，不依赖模型自行创建原生 DSH subagent。减少单次输入与输出大小需要分批和有界归并；并发数决定同时运行多少批，不能替代 token 限制。

示例配置使用批次并发 2、归并并发 2、全局模型并发 4，总结为聊天保留一个模型槽位。每批最多 30 条消息、18,000 字符，并受估算 token 限制。总体输入上限为 1,000 条/200,000 字符；达到限制必须标注覆盖不足。最终输出按 5,000 字符分段。以上是可配置默认值，不是服务容量保证。

## 目录

```text
bridge/               路由、数据库、聊天/总结 worker、记忆与 outbox
harness/              SDK runner 和独立测试
deploy/               历史 Compose 示例、镜像构建文件与工具策略
scripts/              Linux 运维脚本
docs/                 架构、测试记录和设计说明
config.example.json   脱敏配置示例
PROJECT_SUMMARY.md    项目归纳
```

## 获取与本地检查

```bash
git clone https://github.com/NakashimaYuki0912/wechat-bot.git
cd wechat-bot
node --check bridge/agent-worker.js
node --check harness/sdk-runner.mjs
```

推荐 Node.js 24；项目使用 `node:sqlite`。`bridge/package.json` 没有声明第三方 npm 依赖，但真实模型运行需要另行准备 DSH SDK 运行时和授权。

Windows 可以阅读、编辑和执行语法检查。原测试环境是 Linux，部分测试路径使用 POSIX 写法，不保证可直接在 Windows 运行。

下列独立测试使用临时数据库、fixture 或 fake SDK，不调用真实模型、不发送微信消息；请在 Linux 环境运行：

```bash
node harness/worker-isolation-test.mjs
node harness/capacity-test.mjs
node harness/summary-pipeline-test.mjs
node harness/independent-tests.mjs
node harness/memory-test.mjs
node harness/web-search-test.mjs
```

`scheduler-test.mjs` 和 `bridge-routing-test.mjs` 还依赖已有数据库来克隆 schema，无法仅凭本导出包运行。历史测试报告不等于公开源码在新环境已完成端到端验收。

## 部署前提

当前代码来自 Linux 微信 **4.1.13.26**、DSH **0.2.1-rc.2** 的定制集成。生产部署需要自行准备：

1. 已登录的 Linux 微信，以及具备消息读取、接收游标和发送确认能力的定制 MimicWX。普通官方账号 API 或 iLink ClawBot 不能直接替代。
2. 项目使用的 `wechat-ingest` 等定制 Rust 组件；本仓库不包含其 `sources/`。
3. `runtime/` 下的 DSH/Node 运行时、对应 profile 与独立保存的 DeepSeek 授权。
4. 私有配置 `config/env.sh`、`data/mimicwx/config.toml`、实际 `deploy/compose.yaml` 及所需镜像/安装包。
5. 按 [独立 worker 设计](docs/split-worker-architecture.md) 配置聊天和总结服务。

`deploy/compose.example.yaml` 是历史单 agent 示例，尚未构成完整的双 worker 部署模板。Dockerfile 需要未附带的定制源码及安装包，`.dockerignore` 也需按实际构建上下文调整。因此不能仅复制配置后直接执行 `scripts/up.sh`，也不能假设示例镜像公开可拉取。

配置参考：

```bash
mkdir -p data/bridge
cp config.example.json data/bridge/config.json
```

示例账号、群 ID 和管理员均为占位内容。实际服务参数应在自己的环境检查，勿上传登录资料。

## 可靠性与限制

- 按账号、群和源消息去重，重放不应再次产生模型任务。
- chat 与 summary Session 分离；总结固定时间范围与快照，排队期间不混入后来的消息。
- 批次和归并结果落库；截断可有界拆分，失败保留证据。部分总结必须明确标注。
- 单发送器负责微信 UI；`sent=true` 不代表群内确认。`uncertain` 不盲目重发，避免重复。
- 进程超时/终止不能证明远端模型已取消或停止计费。
- 独立 worker 可以解除应用队列阻塞，仍可能共享账号限流、网络和服务器资源。
- 当前只处理文本。图片、表情、语音等未解析内容不能作为已理解事实。
- 群成员别名来源可能缺失；稳定 ID 才是身份键，联系人显示名不冒充群别名。
- 示例配置关闭了累计预算强制开关；其中的预算数值不代表实际费用硬上限。

## 数据与发布边界

公开包不包含微信资料、真实群聊数据库、登录二维码、API token、密钥、会话授权或服务器配置。运行数据与凭据应保存在忽略目录，不进入 Git。部署前请自行评估群成员知情、日志保留和外部模型处理范围。

相关项目：[SQLite](https://sqlite.org/)。定制组件与依赖版本以实际部署为准。

## 许可证

本仓库暂未指定许可证。公开可见不等于授予开源使用许可；如需复用或分发，请先联系仓库作者并遵守上游组件的各自许可证。
