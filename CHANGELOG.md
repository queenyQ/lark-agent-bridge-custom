# Changelog

本仓库是个人 fork。以下只记录相对上游的改动，上游历史见
[zarazhangrui/lark-coding-agent-bridge](https://github.com/zarazhangrui/lark-coding-agent-bridge)。

## Custom 3 · v1.1.1 — 2026-11-22

- 新凭据使用固定的本机随机密钥，主机名或网络变化后仍可读取。
- 增加 `secrets migrate --profile <name> --legacy-hostname <previous-hostname>`，支持备份旧密文并迁移至新格式。
- 凭据写入和迁移使用文件锁，缺失密钥或未知存储版本时保留原数据并报错。
- 补充用户目录升级飞书 CLI、更新系统服务路径和凭据备份的说明。

- 修复日志遇到循环引用、过深对象或异常 getter 时可能栈溢出的问题。
- 批次准备失败时保留消息，收到新消息后重试，避免静默丢失或循环重试。
- 补齐中英文命令表中的 `/stop all`；两种中断行为从 custom.1 起已存在。
- 新用户可直接安装本版，无需先装 custom.2 或提供旧密钥；迁移仅用于旧版已有凭据。

## Custom 2 · v1.1.0 — 2026-11-10

- 原生支持 DeepSeek Harness，使用 `--agent dsh` 创建独立飞书机器人。
- 补充 Claude Code、Codex 和 DSH 的独立接入步骤，并随安装包提供 DSH headless 配置示例。

## Custom 1 · v1.0.0 — 2026-10-23

基于上游 `0.7.1`（commit `5898681`）。

### Changed

- **`/stop` 只中断当前轮，保留排队消息**
  - 之前：`intake` 对所有命令统一执行 `pending.cancel(scope)`，`/stop` 会连排队消息一起丢弃。
  - 现在：`/stop` 跳过 `cancel`，排队消息在子进程退出后自动合并为下一轮执行。
  - 位置：`src/bot/channel.ts`（intake 命令分支）。
- **run 结束后立即处理积压**
  - 之前：`unblock()` 重新 arm 一个 600ms 静默窗口。
  - 现在：若有排队消息，直接 `flush()`。
  - 位置：`src/bot/pending-queue.ts`。

### Added

- **`/stop all`**：中断当前轮并清空当前会话的排队消息（即原 `/stop` 的行为）。
  - 位置：`src/commands/index.ts`。

### Why

在飞书里按平常速度连续发送短句时，消息到达间隔实测中位数约 5.6 秒（范围 1.5–8.0 秒）。
上游 600ms 的合并窗口远小于输入间隔，导致绝大多数消息单独成轮：

- 近 4 天 165 轮中，156 轮只含 1 条消息（94.5%）；
- 单轮耗时中位数 54 秒。

曾评估"把静默窗口拉长到 6–8 秒"，但首响延迟不可接受，且仍无法覆盖 8 秒的间隔。
最终选择与终端 Claude Code 一致的语义：

1. 空闲时发消息立即开跑；
2. 运行中收到的消息排队；
3. 中断只停当前轮，排队消息作为下一轮继续；
4. 跑完立即处理积压。

### Known limitations

- 中断不能回滚已经执行的工具操作（文件修改、外部调用等只能止损）。
- 单轮回答很短且输入间隔较长时，仍会逐条响应。这是"立即响应"的固有代价，终端行为相同。

### Upstream

Original project and design by Zara Zhang
([@zarazhangrui](https://github.com/zarazhangrui)). Licensed under MIT;
see [LICENSE](./LICENSE).
