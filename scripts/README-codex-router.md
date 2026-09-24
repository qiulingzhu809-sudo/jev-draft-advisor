# Codex × Jev 模型分流器

`codex-router.mjs` 将一条任务文本发送给 TypeSafe/Jev，得到任务类型、推理深度和高风险概率，再由本地规则推荐 Codex 模型与 reasoning effort。它不会读取 Codex 桌面输入框、修改当前任务或保存任务文本。

## 使用

在本仓库根目录执行，`TYPESAFE_API_KEY` 保存在被 Git 忽略的 `.env` 中：

```sh
node --env-file=.env scripts/codex-router.mjs '解释一下 JavaScript 的 map'
node --env-file=.env scripts/codex-router.mjs --json '修复登录竞态并补充测试'
node --env-file=.env scripts/codex-router.mjs --run --priority=balanced '修复登录竞态并补充测试'
```

为避免命令行历史记录保留任务内容，也可以从 stdin 输入：

```sh
printf '%s' '修复登录竞态并补充测试' | node --env-file=.env scripts/codex-router.mjs --json
```

只有显式加 `--run`，才会启动**新的**非交互式 Codex CLI 任务：

```sh
printf '%s' '修复登录竞态并补充测试' | node --env-file=.env scripts/codex-router.mjs --run
```

从其他项目目录使用时，给脚本和 `.env` 传入绝对路径，新的 `codex exec` 会以该项目目录运行。不要传入密码、API Key、身份证号或未脱敏的简历；任务文本会发送到 TypeSafe 服务。输入上限为 8000 字符。

## 路由策略

| Jev 判断 | 默认模型 / 强度 |
| --- | --- |
| 简短问答 | `gpt-5.6-luna` / `low` |
| 日常开发 | `gpt-5.6-terra` / `medium` |
| 复杂编码 | `gpt-5.6-sol` / `high` |
| 开放研究或架构设计 | `gpt-6-astra` / `high` |

“深度推理”可能提升档位或强度；高风险概率达到 0.7 时至少使用 `gpt-6-astra / high`，并标记人工复核。此阈值是初始策略，尚未针对个人任务集校准。模型可用性取决于你的 Codex 账号和客户端。即使使用最高档，脚本也不能保证任务结果正确。

策略先确定最低能力档位，再选满足门槛的模型。`balanced`（默认）、`cost`、`speed` 选最低满足档位；`quality` 提高一档作为质量余量。速度排序和能力门槛只是基于官方定性的初始假设，不是实测基准，因此目前三个优先级会得到相同模型。输出的 Codex credit 费率是每百万输入/输出 token 的公开档位，不是本次任务的精确费用；上下文、缓存、工具调用和实际输出都会改变消耗。真正优化需收集自己的任务集，对成功率、延迟和实际 credit 做对比后再校准门槛。[Codex 模型](https://learn.chatgpt.com/docs/models) · [Codex 计费](https://learn.chatgpt.com/docs/pricing) · [模型选择方法](https://developers.openai.com/api/docs/guides/model-selection)

桌面 App 目前不能由此脚本拦截发送动作或自动切换**正在运行**的任务。若只想在桌面 App 使用建议，先运行默认模式，再手动选择推荐的模型与强度。
