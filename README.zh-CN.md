# @lifangjin/opencode-session-title-plugin

[![npm version](https://img.shields.io/npm/v/@lifangjin/opencode-session-title-plugin.svg)](https://www.npmjs.com/package/@lifangjin/opencode-session-title-plugin)

[English](./README.md) | 简体中文

过滤 opencode 会话标题生成时无关的 system prompt 注入，节省 token 开销。

## 为什么需要

每次新建 opencode 会话都会触发一次后台 LLM 调用来生成简短标题。该调用使用 opencode 内置的 `title` agent，其 prompt 是一段固定的约 1KB 字符串，以 `</examples>` 结尾：

```
You are a title generator. You output ONLY a thread title. Nothing else.
...
```

其他插件（`@cortexkit/opencode-magic-context`、`oh-my-opencode-slim`、项目 `AGENTS.md`、skill 指南、MCP 指令等）会 hook `experimental.chat.system.transform`，向**每一次** LLM 调用追加项目记忆、会话历史、skill 列表等上下文——包括标题生成。这些上下文对生成一个 50 字符的标题毫无用处，却在新会话创建时浪费数千 token。

本插件检测标题生成调用，将 system prompt 剥离为仅剩 `PROMPT_TITLE`，让小模型只看到它真正需要的内容。

## 工作原理

插件 hook 了两个钩子：

- `experimental.chat.system.transform` —— 当任意 system 字符串包含标记 `"You are a title generator"` 时，用提取出的 `PROMPT_TITLE`（从开头到 `</examples>` 的全部内容）替换整个 system 数组，丢弃其他所有条目。
- `experimental.chat.messages.transform` —— 当 user 消息包含 `"Generate a title for this conversation"`（title agent 的前缀）时，丢弃其他插件注入的 `system`/`developer` 角色消息。

检测基于内容而非 agent 名称，因为 `experimental.chat.system.transform` 只接收 `{ sessionID, model }`（不含 agent 名），`experimental.chat.messages.transform` 接收 `{}`。title agent 的 prompt 是 opencode 核心中的常量（`packages/core/src/plugin/agent.ts`），因此标记是稳定的。

## 安装

### 作为已发布包

```jsonc
// ~/.config/opencode/opencode.json
{
  "plugin": [
    "@lifangjin/opencode-session-title-plugin"
  ]
}
```

### 带选项

```jsonc
{
  "plugin": [
    ["@lifangjin/opencode-session-title-plugin", { "debug": true }]
  ]
}
```

### 从源码构建（本地开发）

1. 构建：

   ```sh
   bun install
   bun run build
   ```

2. 软链接到 opencode 的插件目录：

   ```sh
   ln -s "$(pwd)" ~/.config/opencode/plugins/opencode-session-title-plugin
   ```

   或复制构建产物：

   ```sh
   cp dist/index.js ~/.config/opencode/plugins/opencode-session-title-plugin.js
   ```

3. 在 `opencode.json` 中注册：

   ```jsonc
   {
     "plugin": ["./plugins/opencode-session-title-plugin.js"]
   }
   ```

## 选项

| 选项             | 类型      | 默认值  | 说明                                                        |
| ---------------- | --------- | ------- | ---------------------------------------------------------- |
| `debug`          | `boolean` | `false` | 将检测和过滤决策输出到 stderr。                              |
| `enabled`        | `boolean` | `true`  | 总开关。设为 `false` 则仅检测不修改。                        |
| `filterMessages` | `boolean` | `true`  | 同时过滤 `experimental.chat.messages.transform` 的 system 条目。 |
| `notify`         | `boolean` | `true`  | 标题生成后显示 TUI toast，报告节省的 token 数。               |
| `notifyTimeout`  | `number`  | `30`    | 轮询生成标题的最长等待秒数，超时后放弃 toast。                |

### 标题就绪 toast

`notify` 开启时（默认），插件在过滤后轮询 `session.get`，一旦标题从默认值变为真实值就触发 `tui.showToast`：

```
Session title ready
"<generated title>" | title call saved ~1234 tokens
```

hook 在 LLM 调用前触发，因此插件无法同步获知最终标题——它每秒轮询一次，最多持续 `notifyTimeout` 秒。token 节省量按 `(原始 system 字符数 - 过滤后字符数) / 4` 估算并取整。toast 使用 opencode SDK 的 `client.tui.showToast` API，仅在 TUI 连接时渲染（无头模式静默跳过）。

## 为标题生成使用更便宜的模型

本插件只过滤 system prompt。opencode 调用哪个模型生成标题由 opencode 自身控制——没有任何 plugin hook 能覆盖它（`experimental.chat.system.transform` 接收的 `model` 是只读的；prepare 闭包使用原始值）。

opencode title agent 的模型优先级（来源：`packages/opencode/src/session/prompt.ts` 中的 `SessionPrompt.ensureTitle`）：

1. `agent.title.model` —— 在内置 `title` agent 上通过配置设置（最高优先级）
2. `small_model` —— 全局轻量模型配置
3. 主会话模型 —— 兜底（最贵）

要仅为标题生成固定一个便宜模型，在 `opencode.json` 中添加：

```jsonc
{
  "agent": {
    "title": {
      "model": "omlx/Qwen3.6-35B-A3B-8bit"
    }
  }
}
```

`model` 值是 `"provider/model-id"` 字符串，引用已在 `opencode.json` 中配置的 provider。这与本插件天然搭配：便宜模型只看到 `PROMPT_TITLE`（插件剥离了其余内容），每次标题调用的 token 成本降至接近零。

如果想对所有轻量任务（标题、摘要、压缩）统一使用一个便宜模型，在顶层设置 `small_model`：

```jsonc
{
  "small_model": "omlx/Qwen3.6-35B-A3B-8bit"
}
```

在 opencode 日志中验证生效模型：新建会话时 `stream` 行的 `modelID` 字段应显示配置的模型。

## 验证

新建一个 opencode 会话。开启 `debug: true` 后，检查 opencode 日志：

```
[session-title-filter] title generation detected, original system entries: N sizes: [...]
[session-title-filter] filtered system entries: 1 total chars: ~1200
```

`total chars` 应在 1200 左右（`PROMPT_TITLE` 的大小）。如果远大于此，说明其他插件仍在向同一 system 字符串注入——请带日志输出提交 issue。

## 兼容性

- opencode with `@opencode-ai/plugin` >= 1.4.0
- 使用的 hook：`experimental.chat.system.transform`、`experimental.chat.messages.transform`
- 检测标记（`"You are a title generator"`）绑定 opencode 内置的 `PROMPT_TITLE`。如果 opencode 修改了 title agent 的 prompt，需更新 `src/index.ts` 中的 `TITLE_MARKER`。

## License

MIT
