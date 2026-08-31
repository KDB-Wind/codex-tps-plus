# Codex TPS Plus：第四阶段延迟 TTFT 与 OTel 会话参考

v0.4.0 保留同步 Stop 的即时吞吐行，并在同一个 Stop 事件下增加官方后台命令 Hook。
后台进程最多等待 10 秒，直到当前 turn 的 `task_complete` 出现在 transcript 中，然后只把
`time_to_first_token_ms`、`duration_ms`、哈希 turn ID 和时间来源写入状态文件。

同步处理器还有一条补偿路径：记录当前轮之前，检查最近一个已完成 turn 的
`task_complete`。如果对应状态尚无 TTFT，就复用相同的原子替换逻辑回填。因此没有加载
异步处理器的历史会话，或异步处理器偶发未运行，也会在下一轮自动恢复“上轮 TTFT”。

## 显示时序

同步 Stop 运行时当前 `task_complete` 尚未落盘，因此第一轮不会伪造 TTFT。后台回填完成后：

- `$tps` 可以查询最新一轮 TTFT；
- 下一轮自动状态行可以显示 `上轮 TTFT`；
- 会话 JSON 提供有测量轮次的 TTFT 算术平均，缺失值不按零处理。

后台 Hook 不返回 `systemMessage`，不会启动新 turn，也不会给模型增加上下文。读取限制与
同步解析器一致：默认从 transcript 尾部开始，最多 16 MiB；格式变化、超时、缺字段或
状态目录不可写时静默降级。

## 发布前实机回归

在 Windows、Codex CLI 0.149.1、Node.js 24.14.0 的新交互式会话中，发布候选完成了两轮
受控回归：

- TUI 明确加载并运行两个 Stop Hook；
- 第一轮同步显示请求内吞吐和整轮吞吐；
- `task_complete` 落盘后，后台 Hook 自动回填 TTFT 和完成时长；
- 第二轮自动状态行显示上一轮 TTFT；
- 自动化回放证明缺失异步回填时，后续同步 Stop 也会补写上一轮 TTFT；
- 两轮均未出现 Hook failed。

第一次回归曾暴露 Windows 安装缓存目录联接问题：`process.argv[1]` 保留调用路径，而
`import.meta.url` 使用真实路径，字符串比较导致后台入口静默跳过。修复后入口统一比较
规范化 realpath，并增加通过目录联接执行 Hook 的跨平台回归测试。

## 升级后的历史会话

发布候选还验证了版本缓存被删除的场景。同步 Stop 会把生产 Hook 依赖按内容哈希保存到
不含版本号的 `PLUGIN_DATA/runtime`，最多保留 5 份；Hook 命令在原 `PLUGIN_ROOT` 不存在时
转由稳定调度器执行。自动化测试覆盖三条路径：正常 Stop 自动播种、缓存与快照都缺失时
严格输出空 JSON，以及缓存删除后同步吞吐与异步 TTFT 均能从快照继续工作。

这个机制不会让旧会话热加载新的 Hook 定义或技能；它只保证更新清理缓存后不再因为脚本
路径消失而报退出码 1。新版本能力仍以新会话为加载边界。

## OTel 边界

`status.mjs --otel-capture <dir>` 可以读取现有本地 OTLP 捕获并展示
`1000 / service TBT_ms`。该值固定标记为 `OTel 会话参考（未归轮）`，不会写成当前轮 TPS。
只有未来观测到并验证 request/turn join key 后，才考虑更细的自动归属。

OTLP `.bin` 仍是潜在敏感原始数据。读取现有捕获是显式 opt-in；生产 Hook 不启动接收器、
不修改用户的 Codex OTel 配置，也不默认保存任何 OTLP body。
