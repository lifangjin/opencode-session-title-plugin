# @lifangjin/opencode-session-title-plugin

[![npm version](https://img.shields.io/npm/v/@lifangjin/opencode-session-title-plugin.svg)](https://www.npmjs.com/package/@lifangjin/opencode-session-title-plugin)

[English](./README.md) | 简体中文

过滤 opencode 会话标题生成时无关的 system prompt 注入，节省 token 开销。

## 为什么需要

每次新建 opencode 会话都会触发一次后台 LLM 调用来生成简短标题。该调用使用 opencode 内置的 `title` agent，其 prompt 是一段固定的约 2KB 字符串，以 `</examples>` 结尾：

```
You are a title generator. You output ONLY a thread title. Nothing else.
...
```

其他插件（`@cortexkit/opencode-magic-context`、`oh-my-opencode-slim`、项目 `AGENTS.md`、skill 指南、MCP 指令等）会 hook `experimental.chat.system.transform`，向**每一次** LLM 调用追加项目记忆、会话历史、skill 列表等上下文--包括标题生成。这些上下文对生成一个 50 字符的标题毫无用处，却在新会话创建时浪费数千 token。

本插件检测标题生成调用，将 system prompt 剥离为仅剩 `PROMPT_TITLE`，让小模型只看到它真正需要的内容。

## 工作原理

插件 hook 了 `experimental.chat.system.transform`：

1. **检测**：当任意 system 字符串包含完整句子 `"You are a title generator. You output ONLY a thread title. Nothing else."`（opencode `PROMPT_TITLE` 的首行）时，判定为标题生成调用。必须使用完整句子--短标记如 `"You are a title generator"` 会匹配其他 agent 系统提示词中的注释引用，导致误触发。

2. **提取**：从匹配的 system 条目中提取纯 `PROMPT_TITLE`--从 `TITLE_MARKER` 到 `</examples>`（含）的全部内容。其他插件前缀注入的内容（orchestrator 提示词、项目记忆等）被丢弃。

3. **替换**：system 数组原地替换为 `[pureTitle]`（mutation 模式 hook）。

4. **弹窗**：立即计算 token 节省量（`originalTokens - filteredTokens`）并弹出 TUI toast--无轮询，无等待。

检测基于内容而非 agent 名称，因为 `experimental.chat.system.transform` 只接收 `{ sessionID, model }`（不含 agent 名）。title agent 的 prompt 是 opencode 核心中的常量（`packages/core/src/plugin/agent.ts`），因此标记是稳定的。

> **注意**：不使用 `experimental.chat.messages.transform`。该 hook 只在 `SessionPrompt.run` 和 `SessionCompaction.process` 中触发，不在 `LLM.run` / `ensureTitle` 中触发--因此标题生成调用时它从不执行。

## 安装

### 作为已发布包

```jsonc
// ~/.config/opencode/opencode.json
{
  "plugin": [
    "@lifangjin/opencode-session-title-plugin@latest"
  ]
}
```

### 带选项

```jsonc
{
  "plugin": [
    ["@lifangjin/opencode-session-title-plugin@latest", { "debug": true }]
  ]
}
```

### 从源码构建（本地开发）

```jsonc
{
  "plugin": [
    ["/path/to/opencode-session-title-plugin", { "debug": true }]
  ]
}
```

构建：`bun install && bun run build`

## 选项

| 选项      | 类型      | 默认值  | 说明                                                                                    |
| --------- | --------- | ------- | -------------------------------------------------------------------------------------- |
| `debug`   | `boolean` | `false` | 将检测/过滤详情写入 `~/.local/share/opencode/log/session-title-filter.log` 和 stderr。同时将完整 system 内容 dump 到带时间戳的 `.txt` 文件（最多保留 10 个）。 |
| `enabled` | `boolean` | `true`  | 总开关。设为 `false` 则仅检测不修改。                                                    |
| `notify`  | `boolean` | `true`  | 计算完 token 节省量后立即显示 TUI toast。                                                 |

### Toast

`notify` 开启时（默认），插件在过滤后立即弹窗--无轮询，无延迟：

```
Session title filter
Title call saved 3018 tokens
```

token 节省量使用 [gpt-tokenizer](https://github.com/niieani/gpt-tokenizer) 精确计算：根据 hook 中的 `model` 字段选择 tokenizer encoding（GPT-4/3.5 用 cl100k_base，GPT-4o/o1/o3 用 o200k_base），对 OpenAI 模型精确，其他模型以 cl100k_base 近似（±5%）。LLM retry 导致的重复弹窗按 session 60 秒去重。

## 为标题生成使用更便宜的模型

本插件只过滤 system prompt。opencode 调用哪个模型生成标题由 opencode 自身控制。

opencode title agent 的模型优先级（来源：`packages/opencode/src/session/prompt.ts` 中的 `SessionPrompt.ensureTitle`）：

1. `agent.title.model` -- 在内置 `title` agent 上通过配置设置（最高优先级）
2. `small_model` -- 全局轻量模型配置
3. 主会话模型 -- 兜底（最贵）

要仅为标题生成固定一个便宜模型，在 `opencode.json` 中添加：

```jsonc
{
  "agent": {
    "title": {
      "model": "aimatespace/sensenova-deepseek-v4-flash"
    }
  }
}
```

这与本插件天然搭配：便宜模型只看到 `PROMPT_TITLE`（插件剥离了其余内容），每次标题调用的 token 成本降至接近零。

## 验证

新建一个 opencode 会话。开启 `debug: true` 后，检查日志文件 `~/.local/share/opencode/log/session-title-filter.log`：

```
[session-title-filter] plugin v0.0.4 loaded, enabled: true notify: true
[session-title-filter]   system[0]: len=16973 head="..." tail="...</examples>\n"
[session-title-filter] title call: model: sensenova-deepseek-v4-flash entries: 1 titleIndex: 0 originalText.len: 16973 originalTokens: 3521
[session-title-filter] filtered: pureTitle.len: 2095 pureTitle.head: "You are a title generator. You output ONLY..." filteredTokens: 503 savedTokens: 3018
[session-title-filter] notify: toast shown, savedTokens: 3018
```

`filteredTokens` 应在 500 左右（`PROMPT_TITLE` 的大小）。如果远大于此，说明其他插件仍在向同一 system 字符串注入--请带日志输出提交 issue。

## 兼容性

- opencode with `@opencode-ai/plugin` >= 1.4.0
- 使用的 hook：仅 `experimental.chat.system.transform`
- 检测标记（`"You are a title generator. You output ONLY a thread title. Nothing else."`）绑定 opencode 内置的 `PROMPT_TITLE`。如果 opencode 修改了 title agent 的 prompt，需更新 `src/index.ts` 中的 `TITLE_MARKER`。

## License

MIT
