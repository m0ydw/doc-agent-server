# 后端 Agent 工作流说明（doc-agent-server）

> 本文档描述前端如何给后端 Agent 发送信息，以及 Agent 工作流按顺序如何工作。区分哪些是定义（类型/接口/配置），哪些是实例（真正执行的流程）。不含代码，仅标注顺序与代码位置。

---

## 一、前端消息如何到达 Agent

### 1.1 入口：WebSocket 连接建立

**文件**：`src/server.ts`

**启动顺序**（第 1-120 行）：
1. 第 20-30 行：`createApp()` → 创建 Express 应用（`src/app.ts`）
2. 第 32-45 行：挂载路由（`/api/docs/*`、`/api/doc-operations/*`、`/api/ai/*`）
3. 第 50-55 行：启动 HTTP 服务器（端口 3000）
4. 第 60-70 行：**`attachAgentWs(server)`** — 将 Agent WebSocket 挂载到 HTTP 服务器
5. 第 75-85 行：配置文件清理策略（启动清理 + 定时过期清理）
6. 第 90-95 行：初始化 `FileRegistry`（扫描已有文档）
7. 第 100-110 行：初始化 `GlobalAgent`（创建 LLM 实例）
8. 第 115-120 行：启动 SuperDoc Yjs 协作服务（端口 1234）

### 1.2 WebSocket 消息处理

**文件**：`src/ai/core/wsAgentHandler.ts`

**函数**：`attachAgentWs(server)`（~20-100 行）

**流程顺序**：

**第一步：WebSocket 服务器创建**（~22-30 行）
- 创建 `WebSocketServer` 实例，监听 `/ws/agent` 路径
- 配置 `maxPayload` 限制消息大小

**第二步：连接事件处理** `wss.on('connection', ws => ...)` （~32-95 行）
1. 发送连接成功确认消息
2. 注册 `ws.on('message', ...)` 监听器 — **核心消息分发**

**第三步：消息解析与分发** `ws.on('message', ...)` （~40-90 行）

解析前端发送的 JSON 消息帧：

```
{
  type: "agent_message",
  id: "msg-xxx",
  data: { message, docId, mode, modelConfig }
}
```

**分发逻辑**（`type === "agent_message"` 时）：

| 条件 | 走向 | 代码位置 |
|------|------|---------|
| `type === "cancel"` | 取消当前处理 | ~50-55 行 |
| `mode === "chat"` | 进入 **Chat 模式**（`globalAgent.streamProcess`） | ~60-70 行 |
| `mode === "workflow"`（默认） | 进入 **多 Agent 工作流模式**（`createWorkflow` → LangGraph） | ~72-88 行 |
| 其他 type | 忽略 | ~90-95 行 |

### 1.3 SSE 事件发射器

**文件**：`src/ai/core/sseEmitter.ts`

**这是定义层**：提供 15 种标准化事件发射函数，Agent 各阶段通过调用这些函数向前端推送消息。

**函数列表**（按调用时序）：

| 函数名 | 行号 | 发射的事件类型 | 调用时机 |
|--------|------|--------------|---------|
| `sse()` | ~10-15 | 底层 SSE 帧格式 | 所有事件的基础 |
| `emitThought()` | ~20-25 | `thought` | LLM 流式输出 token 时 |
| `emitContent()` | ~27-32 | `content` | 阶段产生正文内容时 |
| `emitPhaseStart()` | ~34-40 | `phase_start` | 每个 Agent 节点开始时 |
| `emitPhaseEnd()` | ~42-48 | `phase_end` | 每个 Agent 节点完成时 |
| `emitPhaseStatus()` | ~50-55 | `phase_status` | 节点状态更新时 |
| `emitToolStart()` | ~57-63 | `tool_start` | 工具调用开始时 |
| `emitToolResult()` | ~65-71 | `tool_result` | 工具调用返回结果时 |
| `emitSummary()` | ~73-78 | `summary` | 阶段总结时 |
| `emitTodoList()` | ~80-86 | `todo_list` | Todo 列表更新时 |
| `emitTodoDone()` | ~88-93 | `todo_done` | Todo 项完成时 |
| `emitError()` | ~95-100 | `error` | 发生错误时 |
| `emitDone()` | ~102-107 | `done` | 整个流程完成时 |

---

## 二、GlobalAgent 单例（Chat 模式入口）

**文件**：`src/ai/agent/globalAgent.ts`

**这是实例（真正执行的流程）**。

**总体职责**：管理 LLM 实例、处理 Chat 模式对话、触发 Workflow 模式。

**关键函数**：

| 函数/属性 | 行号 | 类别 | 说明 |
|-----------|------|------|------|
| `GlobalAgent` 类定义 | ~15-20 行 | **定义** | 单例类 |
| `getOrCreate()` | ~25-50 行 | **实例** | 创建或获取全局唯一实例。LLM 创建逻辑：API Key 四层优先级（环境变量 → .env → 内置默认 → 用户配置） |
| `streamProcess()` | ~55-120 行 | **实例** | **核心分流函数**：根据 mode 参数分为三路 — Chat 对话 / 内容查询 / Workflow 多 Agent |
| `resolveTargetDocId()` | ~125-145 行 | **实例** | 根据用户消息匹配目标文档 ID |
| `reset()` | ~150-160 行 | **实例** | 重置 Agent 记忆和状态 |

**Chat 模式流程**（`mode === "chat"`）：
1. 构建 Chat Prompt（使用 `src/ai/prompts/chat.ts` 中的 system prompt）
2. 创建 LLM 调用
3. 流式输出到 WebSocket → 前端通过 `content` 事件接收

**Workflow 模式流程**（`mode === "workflow"`）：
1. 创建 LLM 实例
2. 调用 `createWorkflow(llm)` → 触发 LangGraph 多 Agent 工作流（详见第四节）
3. 流式事件通过 `wsAgentHandler` 映射为 WebSocket 消息

---

## 三、会话管理（文档打开与协作）

### 3.1 SDK 客户端管理

**文件**：`src/services/cliRunner.ts`

**这是实例**。

**设计要点**：
- 第 10-20 行：SDK Client **单例模式** — 全局只有一个实例
- 第 22-30 行：`connectPromise` — **并发保护**：保证多个同时请求只初始化一次

**关键函数**：

| 函数名 | 行号 | 类别 | 说明 |
|--------|------|------|------|
| `getClient()` | ~35-60 行 | **实例** | 获取或创建 SDK 客户端。超时配置：`requestTimeoutMs=90000`、`watchdogTimeoutMs=90000`。用户名："Agent" |
| `openDocument(opts)` | ~65-100 行 | **实例** | 打开文档。支持两种模式：独立模式（仅 docPath）和协作模式（docPath + collabUrl + collabDocumentId） |
| `closeDocument(docId)` | ~105-115 行 | **实例** | 关闭文档，释放 SDK 资源 |
| `disposeClient()` | ~120-130 行 | **实例** | 销毁 SDK 客户端，释放所有资源 |

### 3.2 会话管理器

**文件**：`src/services/session/sessionManager.ts`

**这是实例**。

**核心函数**：

| 函数名 | 行号 | 类别 | 说明 |
|--------|------|------|------|
| `createOrUseSession(docId)` | ~30-80 行 | **实例** | **最核心函数**。三步骤：1) 查是否存在已有会话（复用优先）；2) 获取文档路径和房间信息；3) 通过 `cliRunner.openDocument()` 打开文档并加入 Yjs 协作房间 |
| `ensureYjsRoom(docId)` | ~85-100 行 | **实例** | 仅返回协作房间信息（collabUrl + roomName），不建立 SDK 连接。供前端打开文档时使用 |
| `closeSessionByDocId(docId)` | ~105-120 行 | **实例** | 关闭单个会话：保存文档 → 关闭 SDK 句柄 → 清理会话记录 |
| `closeAllSessions()` | ~125-140 行 | **实例** | 关闭所有会话并 dispose SDK 客户端 |
| 空闲清理定时器 | ~145-160 行 | **实例** | 每 60 秒检查一次，30 分钟无活动的会话自动关闭 |

**协作参数说明**（`createOrUseSession` 内部使用）：
- `collabUrl`: `ws://localhost:1234` — Yjs 协作服务器地址
- `collabDocumentId`: `roomName` — 每个文档唯一的房间名
- 这两个参数使 SDK 文档句柄与 Yjs 协作房间建立关联

---

## 四、多 Agent 工作流（LangGraph）

### 4.1 工作流状态定义

**文件**：`src/ai/workflow/state.ts`

**这是定义（类型/接口/注解）**，不是实例。

**`AgentState` 注解字段分类**（~5-50 行）：

| 分类 | 字段名 | 行号 | 用途 |
|------|--------|------|------|
| 输入 | `userMessage` | ~8 | 用户的原始消息 |
| 输入 | `targetDocId` | ~10 | 目标文档 ID |
| 输入 | `targetDocPath` | ~12 | 目标文档路径 |
| 内存 | `conversationHistory` | ~15 | 对话历史记录 |
| 内存 | `extractedData` | ~18 | Orchestrator 提取的结构化数据 |
| 内存 | `documentMap` | ~20 | DocAnalyst 产出的文档结构地图 |
| Orchestrator | `intent` | ~23 | 意图分类结果 |
| Orchestrator | `planJson` | ~25 | agentPlan（委派计划 JSON） |
| 控制 | `delegationStep` | ~28 | 当前委派步骤索引（控制流程走向） |
| 校验 | `fieldMappings` | ~31 | TemplateFiller 产出的字段映射 |
| 校验 | `executionLog` | ~33 | 各节点执行日志 |

### 4.2 工作流图构建

**文件**：`src/ai/workflow/graph.ts`

**函数**：`createWorkflow(llm)` — **这是实例执行入口**（~15-100 行）

**节点拓扑**（图形结构）：

```
__start__
    │
    ▼
orchestrator（总调度）
    │
    ▼ (supervisorRouter 条件路由)
    ├── doc_analyst      ──┐
    ├── surgical_editor  ──┤
    ├── template_filler  ──┤
    └── reviewer         ──┤
                           │
    ◄── supervisorRouter ◄─┘
    │
    ▼
   END
```

**条件路由函数** `supervisorRouter(state)`（~60-85 行）：
- 解析 `state.planJson` → 获取 `agentPlan[]` 数组
- 使用 `state.delegationStep` 作为当前索引
- 如果 `delegationStep >= agentPlan.length` → 返回 `END`
- 否则返回 `agentPlan[delegationStep].agent` 对应的节点名
- **每个节点执行后自动将 `delegationStep` 加 1**

### 4.3 各 Agent 节点详细流程

#### 节点一：Orchestrator（总调度）

**文件**：`src/ai/workflow/nodes/orchestrator.ts`

**这是实例**。

**执行流程**（~20-100 行）：

1. **构建 Prompt**（~25-35 行）：
   - 使用 `src/ai/prompts/orchestrator.ts` 的 system prompt（**定义**）
   - 使用 `src/ai/prompts/shared/rules.ts` 的共享规则（**定义**）
   - 注入用户消息和文档路径

2. **LLM 调用进行意图分类**（~38-50 行）：
   - LLM 返回 JSON：`{ intent, agentPlan, extractedData(可选) }`
   - 如果 `taskType === "complex_fill"` → 触发 DataExtractor 提取结构化数据

3. **降级策略** `fallbackClassification()`（~55-75 行）：
   - **如果 LLM 未产出有效 JSON，使用规则匹配**：
     - 含"替换/改成/换成/改错/修正" → `simple_edit` → 路由到 `surgical_editor`
     - 含"填表/填入/填充/模板"或"姓名+电话" → `complex_fill` → 路由到 `doc_analyst → template_filler → reviewer`
     - 含"查/看/有什么/内容"或以 `?` 结尾 → `query` → 路由到 `doc_analyst`
     - 含"加粗/斜体/下划线/字号/字体/格式" → `format_change` → 路由到 `surgical_editor`
     - 默认 → `mixed` → 路由到 `doc_analyst → surgical_editor`

4. **输出**：更新 `state.intent`、`state.planJson`、`state.extractedData`

#### 节点二：DocAnalyst（文档考古学家）

**文件**：`src/ai/workflow/nodes/docAnalyst.ts`

**这是实例**。

**执行流程**（~20-100 行）：

1. **读取表格结构**（~30-40 行）：
   - 调用 `editorOperations.readTable(docId)` → 获取表格结构化地图
   - `readTable` 实现位置：`src/services/editor/formatOperations.ts` 第 30-60 行

2. **标签匹配**（~45-65 行）：
   - 遍历 `ALL_LABELS`（常用字段变体，如"姓名"/"名字"/"name"）
   - 对每个标签调用 `editorOperations.findCell(docId, label)` → 在表格中搜索
   - `findCell` 实现位置：`src/services/editor/formatOperations.ts` 第 80-100 行

3. **LLM 微决策**（~70-90 行）：
   - 对每个找到的标签，获取周边单元格
   - 调用 LLM 进行 `microDecideTargetCell()` → 确定目标写入单元格
   - 降级策略：如果 LLM 决策失败，默认取标签右侧的单元格

4. **输出**：`LabelMapping[]` → 存入 `state.documentMap`

#### 节点三：SurgicalEditor（精准文本外科医生）

**文件**：`src/ai/workflow/nodes/surgicalEditor.ts`

**这是实例**。

**执行流程**（~20-100 行）：

1. **初始化最小工具集**（~25-40 行）：
   - 4 个工具：`sdk_find_text`、`sdk_replace_text`、`sdk_replace_all`、`sdk_apply_format`
   - 1 个控制工具：`sdk_task_complete`
   - 各工具定义位置：`src/ai/tools/sdkTools/` 目录下的对应文件（**定义**）

2. **LLM Tool Calling 循环**（~45-95 行）：
   - `llm.bindTools(tools)` → LLM 自主决定调用哪个工具
   - 每轮执行：LLM 输出 tool_call → 执行工具 → 结果返回 LLM → 继续下一轮
   - 遇到 `task_complete` 工具调用 → 退出循环
   - 最多 10 轮（防止无限循环）

3. **输出**：`state.executionLog` 记录所有操作

#### 节点四：TemplateFiller（填表专员）

**文件**：`src/ai/workflow/nodes/templateFiller.ts`

**这是实例**。

**执行流程**（~20-100 行）：

1. **解析 extractedData**（~25-35 行）：
   - 从 `state.extractedData` 获取用户提供的结构化数据

2. **解析 documentMap**（~38-45 行）：
   - 从 `state.documentMap` 获取 DocAnalyst 产出的标签映射

3. **构建字段映射**（~48-60 行）：
   - 调用 `templateMapper.buildFieldMappings()` → 生成 `FieldMapping[]`
   - `buildFieldMappings` 实现位置：`src/ai/modules/templateMapper.ts`（~15-60 行）
   - 匹配策略：三级匹配（精确匹配 → 变体匹配 → 包含匹配）

4. **装载数据守卫**（~63-70 行）：
   - 调用 `DataGuard.arm(data)` → 白名单模式
   - `DataGuard` 实现位置：`src/ai/modules/dataGuard.ts`（**定义 + 实例**）

5. **纯确定性写入**（~73-90 行）：
   - **此步骤不涉及 LLM**，完全确定性执行
   - 逐字段：`DataGuard.guard(value)` 校验 → 通过则 `editor.setText(ref, value)`
   - `setText` 实现位置：`src/services/editor/formatOperations.ts` 第 10-30 行
   - 累计拦截 ≥ 5 次触发**熔断机制**（防止幻觉）

6. **释放数据守卫**（~93-98 行）：
   - 调用 `DataGuard.disarm()` — 用完即弃

7. **输出**：`state.fieldMappings` + `state.executionLog`

#### 节点五：Reviewer（质检员）

**文件**：`src/ai/workflow/nodes/reviewer.ts`

**这是实例**。

**执行流程**（~20-80 行）：

1. **解析 fieldMappings**（~25-35 行）：
   - 从 `state.fieldMappings` 获取 TemplateFiller 的产出

2. **逐字段验证**（~38-60 行）：
   - 通过 `readTable(docId)` 重新读取当前文档
   - 查找每个字段的 ref → 比对期望值 vs 实际值
   - 如果一致 → 标记为 `pass`
   - 如果不一致 → 调用 LLM 分析差异原因

3. **生成 DiffReport**（~63-80 行）：
   - 输出：`{ result: "pass" | "partial" | "fail", details[], summary }`

---

## 五、数据提取器（双阶段）

**文件**：`src/ai/modules/dataExtractor.ts`

**这是实例**，但在 Orchestrator 节点中被调用。

**执行流程**（~15-80 行）：

1. **阶段一：确定性正则**（~20-40 行）：
   - 正则匹配键值对（`字段名：值` 或 `字段名: 值`）
   - 正则匹配电话号码（中国大陆格式）
   - 正则匹配邮箱地址
   - 覆盖约 90% 的明确信息

2. **覆盖率判断**（~43-50 行）：
   - 如果确定性覆盖率 ≥ 70% → 直接返回结果，不调用 LLM
   - 如果确定性覆盖率 < 70% → 进入阶段二

3. **阶段二：LLM 兜底**（~55-75 行）：
   - 将原始文本发送给 LLM 提取剩余字段
   - 用于处理自由文本中的隐含信息（如非标准格式的姓名、地址等）

4. **合并策略**（~78-80 行）：
   - 确定性结果优先
   - LLM 结果补充未覆盖的字段
   - 确定性结果永远不会被 LLM 结果覆盖

---

## 六、数据守卫（防幻觉）

**文件**：`src/ai/modules/dataGuard.ts`

**这是定义 + 实例**。

**核心机制**（~10-60 行）：

| 方法 | 行号 | 类别 | 说明 |
|------|------|------|------|
| `DataGuard` 类定义 | ~10-15 | **定义** | 类结构 |
| `arm(data)` | ~18-25 | **实例** | 装载用户原始数据字典（白名单模式） |
| `guard(value)` | ~28-50 | **实例** | 校验写入值是否在白名单中（精确匹配 + 子串匹配）。返回 `true`（通过）或 `false`（拦截） |
| `disarm()` | ~53-58 | **实例** | 释放数据字典，清理拦截计数 |
| 熔断逻辑 | ~42-48 行 | **实例** | 累计拦截 ≥ 5 次触发熔断，拒绝后续所有写入 |

**设计意图**：防止 LLM 在填表过程中产生幻觉（编造数据），确保只有用户提供的原始数据才能写入文档。

---

## 七、提示词（Prompts）

**目录**：`src/ai/prompts/`

**这些全是定义**，不是实例。

| 文件 | 用途 | 被引用的位置 |
|------|------|-------------|
| `orchestrator.ts` | Orchestrator 系统提示词（意图分类 + agentPlan 制定） | `nodes/orchestrator.ts` |
| `chat.ts` | Chat 模式系统提示词 | `agent/globalAgent.ts` 的 `streamProcess`（Chat 分支） |
| `analyze.ts` | 旧版分析提示词（已被 orchestrator 替代） | 保留兼容 |
| `plan.ts` | 旧版计划提示词 | 保留兼容 |
| `execute.ts` | 旧版执行提示词 | 保留兼容 |
| `validate.ts` | 旧版验证提示词 | 保留兼容 |
| `generate.ts` | 旧版生成提示词（已被 Reviewer 替代） | 保留兼容 |
| `shared/rules.ts` | 共享规则：防泄露、意图分类、执行风格、语言要求 | 被所有 prompt 文件引用 |
| `shared/examples.ts` | Few-shot 正反例 | 被 analyze/execute/validate 等 prompt 引用 |

---

## 八、工具定义（Tools）

**目录**：`src/ai/tools/`

**这些全是定义**（Zod Schema + StructuredTool），不是实例。实例在执行时由 LLM 通过 Tool Calling 机制动态调用。

| 文件 | 工具名 | 用途 | 被哪个 Agent 节点使用 |
|------|--------|------|----------------------|
| `sdkFindTextTool.ts` | `sdk_find_text` | 在文档中查找文本 | SurgicalEditor |
| `sdkReplaceTextTool.ts` | `sdk_replace_text` | 替换文档中的文本 | SurgicalEditor |
| `sdkReplaceAllTool.ts` | `sdk_replace_all` | 批量替换文本 | SurgicalEditor |
| `sdkApplyFormatTool.ts` | `sdk_apply_format` | 应用文本格式（加粗/斜体等） | SurgicalEditor |
| `sdkGetTextTool.ts` | `sdk_get_text` | 读取文档全文 | DocAnalyst、Reviewer |
| `sdkSetTextTool.ts` | `sdk_set_text` | 写入文本到文档 | TemplateFiller（确定性写入） |
| `sdkReadTableTool.ts` | `sdk_read_table` | 读取表格结构 | DocAnalyst、Reviewer |
| `sdkFindCellTool.ts` | `sdk_find_cell` | 在表格中查找单元格 | DocAnalyst、Reviewer |
| `sdkGetStructureTool.ts` | `sdk_get_structure` | 兼容旧版，等同于 readTable(0) | DocAnalyst |
| `sdkTaskCompleteTool.ts` | `sdk_task_complete` | 标记任务完成（控制工具） | SurgicalEditor（退出循环） |

**工具元数据注册表**：`src/ai/tools/sdkTools/index.ts`（~10-30 行）— 注册所有工具的 metadata（名称、描述、参数 schema）

**工具类别划分**（`src/ai/tools/index.ts`）：
- **只读工具**：find_text、get_text、read_table、find_cell、get_structure
- **写入工具**：replace_text、replace_all、set_text、apply_format
- **控制工具**：task_complete

---

## 九、LLM 配置与管理

**文件**：`src/ai/core/llm.ts`

**函数**：`createChatModel(config)`（~15-60 行）

**这是实例工厂**（每次调用创建新的 LLM 实例）。

**厂商支持**：

| 厂商 | baseURL | 默认模型 | 识别条件 |
|------|---------|---------|---------|
| 智谱AI | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash` | `provider === "zhipu"` |
| DeepSeek | `https://api.deepseek.com` | `deepseek-chat` | `provider === "deepseek"` 或 baseURL 含 deepseek |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` | 默认 |

**DeepSeek 特殊处理**：如果检测到是 DeepSeek，自动在 `model_kwargs` 中禁用 thinking mode。原因：DeepSeek 的 Tool Calling 模式与 reasoning_content 存在兼容性问题。

**`createChatModelFromEnv()`**（~65-80 行）：零配置启动函数，从环境变量读取 API Key，自动推断厂商。

---

## 十、总结：定义 vs 实例对照表

| 类别 | 文件位置 | 具体内容 |
|------|---------|---------|
| **类型定义** | `src/types/` | `ToolsConfig`、`AgentState` 接口定义 |
| | `src/ai/workflow/state.ts` | `AgentState` LangGraph 注解定义 |
| | `src/ai/tools/sdkToolTypes.ts` | `SDKToolMetadata` 类型定义 |
| | `src/ai/tools/outputSchemas.ts` | Zod Schema 定义 |
| **配置定义** | `src/config/index.ts` | 端口、URL、超时等常量 |
| | `src/ai/prompts/` 目录 | 所有 Prompt 模板 |
| | `src/ai/tools/sdkTools/` 目录 | 所有工具 Schema 定义 |
| **实例（真正执行的流程）** | `src/server.ts` | `main()` — 启动全流程 |
| | `src/ai/core/wsAgentHandler.ts` | `attachAgentWs()` — WebSocket 消息分发 |
| | `src/ai/agent/globalAgent.ts` | `GlobalAgent.getOrCreate()` + `streamProcess()` — Agent 单例和分流 |
| | `src/ai/workflow/graph.ts` | `createWorkflow()` — LangGraph 工作流图构建和执行 |
| | `src/ai/workflow/nodes/` 目录 | 五个 Agent 节点的执行函数 |
| | `src/ai/modules/dataExtractor.ts` | `extract()` — 双阶段数据提取 |
| | `src/ai/modules/dataGuard.ts` | `DataGuard.arm()/guard()/disarm()` — 防幻觉校验 |
| | `src/ai/modules/templateMapper.ts` | `buildFieldMappings()` — 字段映射构建 |
| | `src/services/session/sessionManager.ts` | `createOrUseSession()` — 会话创建 |
| | `src/services/cliRunner.ts` | `getClient()`/`openDocument()` — SDK 客户端管理 |
| | `src/services/editor/editorOperations.ts` | `findText()`/`replaceFirst()`/`replaceAll()` — 编辑操作 |
| | `src/routes/docRoutes.ts` | 路由处理器 — HTTP 请求处理 |
