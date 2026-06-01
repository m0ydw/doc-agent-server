# DocAgent 后端架构导航指南

> 🎯 本文档是后端项目的"导游图"，带你从零理解后端是如何运行的。
> 每个源文件顶部都有详细的导航注释，说明该文件的职责、依赖关系和关键函数。

---

## 🚀 服务启动流程

从 src/server.ts 出发，按以下顺序启动：

`
server.ts 启动
    │
    ├─► 1. 加载配置 (config/index.ts)
    │      └─ 读取环境变量：PORT=3000, COLLAB_WS_PORT=1234
    │
    ├─► 2. 创建 Express 应用 (app.ts)
    │      ├─ helmet: 设置安全 HTTP 头
    │      ├─ CORS: 允许跨域请求
    │      ├─ rateLimit: 限流 120次/分钟
    │      ├─ express.json(): 解析 JSON 请求体
    │      └─ 请求日志中间件
    │
    ├─► 3. 挂载路由
    │      ├─ /api/docs → docRoutes.ts (文档上传/列表/删除)
    │      └─ /api/doc-operations → docOperationsRoutes.ts (查找/替换)
    │
    ├─► 4. 启动 HTTP 服务 (端口 3000)
    │
    ├─► 5. 启动 Agent WebSocket (agentWs.ts)
    │      └─ 路径: ws://localhost:3000/ws/agent
    │
    ├─► 6. 文件清理策略
    │      ├─ CLEANUP_ON_START=true → 启动时清空 uploads/
    │      └─ 否则 → 定时清理超过 24 小时的文件
    │
    ├─► 7. 初始化文件注册表 (fileRegistry.ts)
    │
    └─► 8. 启动协作服务 (端口 1234)
           └─ @superdoc-dev/superdoc-yjs-collaboration
`

---

## 📁 文件导航地图

### 想了解... 请看...

| 我想了解... | 应该看的文件 | 关键函数/行号 |
|------------|-------------|--------------|
| 服务是如何启动的 | src/server.ts | 第 40-42 行 |
| Express 中间件配置 | src/app.ts | 第 48-106 行 |
| 全局配置常量 | src/config/index.ts | 全文 |
| 文档上传流程 | src/routes/docRoutes.ts | 第 174-219 行 POST /upload |
| 文档列表获取 | src/routes/docRoutes.ts | 第 223-242 行 GET /list |
| 文档打开流程 | src/routes/docRoutes.ts | 第 248-271 行 POST /:id/open |
| 文档删除流程 | src/routes/docRoutes.ts | 第 329-357 行 DELETE /:id |
| 文档查找替换 | src/routes/docOperationsRoutes.ts | 第 15-57 行 |
| SDK 客户端管理 | src/services/cliRunner.ts | 第 19-62 行 getClient() |
| 会话创建/复用 | src/services/session/sessionManager.ts | 第 54-119 行 createOrUseSession() |
| 文本查找实现 | src/services/editor/editorOperations.ts | 第 33-59 行 indText() |
| 文本替换实现 | src/services/editor/editorOperations.ts | 第 64-107 行 |
| 文档元数据存储 | src/services/docServices.ts | 第 263-297 行 saveDocument() |
| Agent WebSocket 通信 | src/services/agent/agentWs.ts | 第 231-303 行 ttachAgentWebSocket() |
| Agent 执行流程 | src/services/agent/agentRunner.ts | 第 261-455 行 unAgent() |
| Agent 工具定义 | src/services/agent/agentTools.ts | 第 582-1412 行 createAgentTools() |
| Agent 运行实例管理 | src/services/agent/agentSessionManager.ts | 第 25-56 行 createRun() |
| 审批流程 | src/services/agent/agentSessionManager.ts | 第 88-117 行 |

---

## 📂 目录结构

`
doc-agent-server/src/
│
├── server.ts                       ← 🔥 服务启动入口，从这里开始阅读
├── app.ts                          ← Express 应用配置（中间件、CORS、限流）
│
├── config/
│   └── index.ts                    ← 全局配置（端口、URL 等环境变量）
│
├── middleware/
│   └── auth.ts                     ← 认证中间件（保护静态文件）
│
├── routes/
│   ├── docRoutes.ts                ← 📄 文档管理路由
│   │   ├── POST /upload            上传文档
│   │   ├── GET /list               获取文档列表
│   │   ├── POST /:id/open          打开文档（建立协作）
│   │   ├── GET /:id/seed           获取种子文件
│   │   ├── DELETE /:id             删除文档
│   │   └── POST /cleanup           批量清理
│   │
│   └── docOperationsRoutes.ts      ← ✏️ 文档操作路由
│       ├── POST /find              查找文本
│       ├── POST /replace           替换文本
│       ├── GET /text/:id           获取纯文本
│       └── POST /set-text          设置文本
│
├── services/
│   ├── docServices.ts              ← 📦 文档元数据 CRUD（文件系统存储）
│   ├── cliRunner.ts                ← 🔌 SDK 客户端单例管理
│   ├── fileRegistry.ts             ← 📋 文件注册表（内存映射）
│   ├── collabStateService.ts       ← 💾 协作状态持久化
│   │
│   ├── session/
│   │   ├── index.ts                ← 会话模块入口
│   │   └── sessionManager.ts       ← 🔄 会话管理器（创建/复用/关闭）
│   │
│   ├── editor/
│   │   ├── index.ts                ← 编辑模块入口
│   │   ├── editorOperations.ts     ← 📝 编辑操作（查找/替换/文本提取）
│   │   └── formatOperations.ts     ← 🎨 格式操作（表格/样式/插入）
│   │
│   └── agent/
│       ├── agentWs.ts              ← 🌐 Agent WebSocket 通信层
│       ├── agentRunner.ts          ← 🤖 Agent 执行器（调用 LLM）
│       ├── agentTools.ts           ← 🔧 Agent 工具集（20+ 工具）
│       ├── agentTypes.ts           ← 📐 类型定义
│       ├── agentSessionManager.ts  ← 📊 Agent 运行实例管理
│       ├── agentToolPolicy.ts      ← 📜 工具策略（权限控制）
│       ├── agentMemory.ts          ← 🧠 Agent 记忆（历史偏好）
│       └── agentLogger.ts          ← 📝 Agent 调试日志
`

---

## 🔗 核心链路详解

### 链路 1：文档上传

`
前端 POST /api/docs/upload
    │
    ├─► docRoutes.ts: upload.array("files", 10)
    │      └─ multer 解析 multipart 表单
    │
    ├─► decodeFilename() 解码中文文件名
    │
    ├─► docServices.saveDocument()
    │      ├─ 生成 UUID 作为文件 ID
    │      ├─ 写入 uploads/{id}.docx
    │      └─ 写入 uploads/{id}.json (元数据)
    │
    ├─► fileRegistry.registerDocument()
    │      └─ 注册到内存映射表
    │
    └─► 返回 { id, roomName, collaboration: { wsUrl } }
`

### 链路 2：Agent 执行

`
前端 WebSocket: { type: "agent.start", payload: {...} }
    │
    ├─► agentWs.ts: handleAgentStart()
    │      ├─ normalizeStartPayload() 规范化参数
    │      ├─ agentSessionManager.createRun() 创建运行实例
    │      └─ agentRunner.runAgent() 启动执行
    │
    ├─► agentRunner.ts: runAgent()
    │      ├─ createAgentModel() 创建 LLM 模型
    │      │   └─ createOpenAICompatible({ baseURL, apiKey })
    │      │
    │      ├─ createAgentTools() 创建工具集
    │      │   ├─ find_text: 查找文本
    │      │   ├─ replace_text: 替换文本
    │      │   ├─ write_cells_text: 写入单元格
    │      │   ├─ apply_text_style: 应用样式
    │      │   └─ ... 20+ 工具
    │      │
    │      └─ streamText({ model, system, prompt, tools })
    │          ├─ 发送 system prompt + tools 给 LLM
    │          ├─ LLM 返回工具调用请求
    │          ├─ 执行工具并返回结果
    │          └─ 重复直到任务完成
    │
    └─► 事件推送给前端
           ├─ agent.started: 任务启动
           ├─ agent.trace: 思考过程
           ├─ tool.started: 工具开始
           ├─ tool.finished: 工具完成
           ├─ agent.message.delta: 流式文本
           ├─ approval.requested: 需要审批
           └─ agent.finished: 任务完成
`

---

## 📚 关键库说明

### @superdoc-dev/sdk — 文档操作 SDK

`	ypescript
// 创建客户端（cliRunner.ts 第 39-46 行）
const client = createSuperDocClient({
  user: { name: "Agent", email: "agent@local" },
  requestTimeoutMs: 90000,    // 请求超时 90 秒
  watchdogTimeoutMs: 90000,   // 心跳超时 90 秒
});

// 打开文档（cliRunner.ts 第 88-117 行）
const doc = await client.open({
  doc: "/path/to/file.docx",
  sessionId: "session-123",
  collabUrl: "ws://localhost:1234",     // 协作服务地址
  collabDocumentId: "room-name",        // 协作房间名
});

// 查找文本（editorOperations.ts 第 37 行）
const result = await doc.query.match({
  select: { type: "text", pattern: "查找内容" },
  require: "any",  // "first" 只找第一个 | "any" 找全部
});
// result.items[0].handle.ref — 用于后续定位

// 替换文本（formatOperations.ts）
await doc.mutations.apply({
  mutations: [{
    id: "mutation-1",
    op: "text.rewrite",
    by: "ref",
    ref: "xxx",          // 来自 query.match 的 ref
    text: "新文本",
  }],
});

// 保存文档
await doc.save({ inPlace: true });

// 关闭文档
await doc.close();
`

### @superdoc-dev/superdoc-yjs-collaboration — 协作服务

`	ypescript
// server.ts 第 169-186 行
const collaborationService = new CollaborationBuilder()
  .withName("doc-agent-collab")
  .withDebounce(500)                    // 防抖 500ms
  .withDocumentExpiryMs(30 * 60 * 1000) // 文档过期时间 30 分钟
  .onLoad(async ({ documentId }) => {   // 加载回调
    return await loadCollabState(documentId);
  })
  .onAutoSave(async (params) => {       // 自动保存回调
    await saveCollabState(params);
  })
  .build();

// 接受新连接（server.ts 第 206-210 行）
collaborationService.welcome(ws, {
  url: req.url,
  params: { documentId: roomName },
  headers: req.headers,
});
`

### ai (Vercel AI SDK) — AI Agent 框架

`	ypescript
// agentRunner.ts 第 315-418 行
const result = streamText({
  model,                    // LLM 模型实例
  system: fullSystemPrompt, // 系统提示词
  prompt: run.prompt,       // 用户输入
  tools,                    // 工具集合
  stopWhen: isLoopFinished(), // 停止条件
  temperature: 0.2,         // 温度（越低越确定）

  // 每步开始回调
  experimental_onStepStart: ({ stepNumber }) => { ... },

  // 完成回调
  onFinish: async ({ finishReason, usage, text }) => { ... },
});

// 消费流式文本
for await (const delta of result.textStream) {
  // delta 是一小段文本，实时推送给前端
}
`

---

> 💡 **提示**：每个 .ts 文件顶部都有详细的导航注释，包含：
> - 文件职责说明
> - 依赖关系
> - 关键函数列表
> - 跳转指引
