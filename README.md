# DocAgent 服务端

> 基于 Node.js + Express + LangChain 的智能文档处理后端服务。

## 概述

DocAgent 服务端是一个多文档感知的 AI Agent 后端，支持通过自然语言对 `.docx` 文档进行查找、替换、格式化等操作。系统采用 **SSE 流式输出**，提供实时的思考过程、工具调用和生成结果展示。

**核心能力**：接收用户自然语言需求 → AI 分析意图 → 制定执行计划 → 调用 SuperDoc SDK 操作文档 → 验证结果 → 流式输出全过程。

## 功能特性

### AI 工作流模式

- **四阶段流水线**：Analyze（分析意图）→ Plan（制定计划）→ Execute（执行操作）→ Generate（生成回答）→ Validate（验证结果）
- **工具调用**：内置 5 个 SDK 工具（查找文本、替换文本、全部替换、获取全文、保存文档）
- **重试机制**：执行失败时自动重试（最多 3 次），失败时提示用户介入
- **记忆管理**：跨请求保留操作历史，支持上下文关联

### Chat 对话模式

- 直接读取文档内容 → LLM 流式生成回答
- 适用于文档问答、内容总结等对话式场景
- 支持文档文本缓存，避免重复读取

### 文档管理

- `.docx` 文件上传（Multer 多文件支持）
- 文档元数据管理（增删查）
- 实时协作（基于 `@superdoc-dev/superdoc-yjs-collaboration` + y-websocket）
- 会话管理：自动创建/复用文档编辑会话

### 流式输出

- 思考过程实时流式推送（过滤后端 JSON，仅展示用户可见内容）
- 工具调用带中间 Loading 状态
- 生成内容逐 token 流式到达前端

## 技术栈

| 类别 | 技术 |
|------|------|
| 运行时 | Node.js + TypeScript |
| Web 框架 | Express 5 |
| AI/LLM | LangChain + ChatOpenAI（支持智谱/DeepSeek/OpenAI） |
| 文档操作 | `@superdoc-dev/sdk` (SuperDoc SDK) |
| 实时协作 | `@superdoc-dev/superdoc-yjs-collaboration` + WebSocket |
| 文件上传 | Multer |
| 配置管理 | dotenv |

## 快速开始

### 环境要求

- Node.js ≥ 18
- pnpm（包管理器）

### 安装与配置

```bash
cd doc-agent-server
pnpm install
```

配置 `.env` 文件（参考 `.env`）：

```env
PORT=3000
COLLAB_WS_PORT=1234

# AI 配置（至少配置一个厂商）
ZHIPUAI_API_KEY=your_key_here
DEEPSEEK_API_KEY=your_key_here
```

### 启动服务

```bash
pnpm dev
```

服务默认运行在 `http://localhost:3000`，协作 WebSocket 运行在 `ws://localhost:1234`。

## API 端点

### AI Agent

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/ai/agent/message` | 发送消息（SSE 流式返回） |
| `GET` | `/api/ai/agent/status` | 查询 Agent 状态 |
| `POST` | `/api/ai/agent/reset` | 重置对话记忆 |

### 文档管理

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/docs/upload` | 上传 .docx 文件 |
| `GET` | `/api/docs/list` | 文档列表 |
| `DELETE` | `/api/docs/:id` | 删除文档 |
| `POST` | `/api/docs/cleanup` | 批量清理 |
| `GET` | `/api/docs/events` | SSE 文档更新事件 |

### 文档操作

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/doc-operations/find` | 查找文本 |
| `POST` | `/api/doc-operations/replace` | 替换文本 |
| `GET` | `/api/doc-operations/text/:id` | 获取文档纯文本 |
| `POST` | `/api/doc-operations/save/:id` | 保存文档 |

### SSE 事件格式

后端发送流式事件，每行一个事件，格式为 `[type]content`：

| 事件 | 格式 | 说明 |
|------|------|------|
| 阶段开始 | `[phase:analyze]` | 进入分析阶段 |
| 阶段结束 | `[phase:analyze:end]` | 分析阶段结束 |
| 思考过程 | `[thought]xxx` | AI 思考内容（已过滤 JSON） |
| 内容输出 | `[content]xxx` | 用户可见摘要 |
| Chat 内容 | `[chat]xxx` | Chat 模式流式文本 |
| 工具开始 | `[tool_start]name\|args` | 工具调用开始 |
| 工具调用 | `[tool]name\|args` | 工具调用详情 |
| 工具结果 | `[tool_result]✓ xxx` | 工具执行结果 |
| 文档目标 | `[phase:start]doc_target\|name` | 确定目标文档 |
| 总结 | `[summary]{json}` | 最终总结 |
| 错误 | `[error]xxx` | 错误消息 |

## 架构说明

```
src/
├── app.ts                    # Express 应用入口
├── server.ts                 # HTTP + WebSocket 服务启动
├── config/                   # 配置管理
├── types/                    # TypeScript 类型定义
├── routes/
│   ├── aiRoutes.ts           # AI 路由
│   ├── docRoutes.ts          # 文档上传/管理路由
│   └── docOperationsRoutes.ts # 文档操作路由
├── ai/
│   ├── agent/
│   │   └── globalAgent.ts    # ★ 核心：全局 Agent（单例）
│   ├── service/
│   │   └── aiService.ts      # SSE 流式输出封装
│   ├── core/
│   │   ├── llm.ts            # LLM 工厂（多厂商支持）
│   │   └── memory.ts         # 记忆管理
│   ├── tools/
│   │   ├── analyzeTool.ts    # 需求分析 Tool
│   │   ├── planTool.ts       # 任务规划 Tool
│   │   ├── executeTool.ts    # 智能执行 Tool（LLM + SDK Tools）
│   │   ├── validateTool.ts   # 结果验证 Tool
│   │   └── sdkTools.ts       # 5 个 SDK 操作工具
│   └── workflow/             # LangGraph 工作流（备用）
└── services/
    ├── cliRunner.ts          # SDK 客户端单例
    ├── docServices.ts        # 文档元数据 CRUD
    ├── fileRegistry.ts       # 文件注册表
    ├── editor/
    │   ├── index.ts          # Editor 统一入口
    │   └── editorOperations.ts # 查找/替换/获取文本
    └── session/
        ├── index.ts          # Session 统一入口
        └── sessionManager.ts # 会话管理器
```

### 核心调用链

```
HTTP POST /api/ai/agent/message
  → aiService.runAgentMessage()
    → GlobalAgent.streamProcess()
      ├── 解析用户输入 + 确定目标文档
      ├── Analyze（LLM 流式分析）
      ├── Plan（LLM 流式规划）
      ├── Execute（ExecuteTool 调用 SDK Tools）
      ├── Generate（LLM 流式生成回答）
      └── Validate（LLM 流式验证 + 重试决策）
```

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | HTTP 服务端口 | `3000` |
| `COLLAB_WS_PORT` | 协作 WebSocket 端口 | `1234` |
| `ZHIPUAI_API_KEY` | 智谱 AI API Key | - |
| `DEEPSEEK_API_KEY` | DeepSeek API Key | - |

## License

MIT
