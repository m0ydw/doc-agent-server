/**
 * ============================================================
 * 【Agent类型定义 - agentTypes.ts】
 * ============================================================
 * 
 * 【链路式工程流说明】
 * 这是Agent服务的类型定义文件，负责：
 * 1. 定义权限模式类型
 * 2. 定义LLM提供商和配置类型
 * 3. 定义文档引用类型
 * 4. 定义Agent启动负载类型
 * 5. 定义Agent事件类型
 * 6. 定义审批相关类型
 * 7. 定义输入请求类型
 * 8. 定义Agent运行状态和实例类型
 * 9. 定义工具策略状态类型
 * 
 * 【架构位置】
 * agentWs.ts → 【agentTypes.ts】 → 类型定义
 * agentRunner.ts → 【agentTypes.ts】 → 类型定义
 * agentSessionManager.ts → 【agentTypes.ts】 → 类型定义
 * 
 * 【数据流】
 * 前端发送AgentStartPayload
 *   ↓
 * agentWs.ts解析并规范化
 *   ↓
 * agentSessionManager创建AgentRun
 *   ↓
 * agentRunner执行任务
 *   ↓
 * 生成AgentEvent并发送给前端
 * 
 * 【类型关系图】
 * AgentRun
 *   ├── runId: string
 *   ├── activeDocId: string | null
 *   ├── documents: AgentDocumentRef[]
 *   ├── prompt: string
 *   ├── permissionMode: PermissionMode
 *   ├── llm: LlmConfig
 *   ├── toolPolicy: AgentToolPolicyState
 *   ├── status: AgentRunStatus
 *   ├── events: AgentEvent[]
 *   ├── pendingApprovals: PendingApproval[]
 *   ├── pendingInputs: AgentInputRequest[]
 *   ├── createdAt: number
 *   └── updatedAt: number
 * ============================================================
 */

/**
 * 【权限模式类型】
 * 
 * 【功能说明】
 * 定义Agent执行任务时的权限模式
 * 
 * 【模式说明】
 * - read_only: 只读模式，Agent只能读取文档
 * - review_required: 审查模式，Agent的操作需要用户审批
 * - auto_tracked: 自动追踪模式，Agent自动执行但记录所有操作
 * - auto_apply: 自动应用模式，Agent自动执行所有操作
 */
export type PermissionMode =
  | "read_only"
  | "review_required"
  | "auto_tracked"
  | "auto_apply";

/**
 * 【LLM提供商类型】
 * 
 * 【功能说明】
 * 定义支持的LLM提供商
 * 
 * 【提供商说明】
 * - deepseek: DeepSeek
 * - xiaomimimo: Xiaomi MiMo
 */
export type LlmProvider = "deepseek" | "xiaomimimo";

/**
 * 【LLM配置类型】
 * 
 * 【功能说明】
 * 定义LLM的配置信息
 * 
 * 【字段说明】
 * @property provider - LLM提供商
 * @property apiKey - API密钥
 * @property baseURL - API基础URL
 * @property model - 模型名称
 */
export type LlmConfig = {
  provider: LlmProvider;
  apiKey: string;
  baseURL: string;
  model: string;
};

/**
 * 【文档引用类型】
 * 
 * 【功能说明】
 * 表示Agent可以操作的文档引用
 * 
 * 【字段说明】
 * @property id - 文档唯一ID
 * @property name - 文档名称
 * @property active - 是否是当前激活的文档（可选）
 */
export type AgentDocumentRef = {
  id: string;
  name: string;
  active?: boolean;
};

/**
 * 【Agent启动负载类型】
 * 
 * 【功能说明】
 * 前端发送的Agent启动消息的负载
 * 
 * 【字段说明】
 * @property docId - 文档ID（兼容旧版本）
 * @property documents - 文档列表
 * @property prompt - 用户输入的任务描述
 * @property permissionMode - 权限模式
 * @property llm - LLM配置
 */
export type AgentStartPayload = {
  docId?: string;
  documents?: AgentDocumentRef[];
  prompt: string;
  permissionMode: PermissionMode;
  llm: LlmConfig;
};

/**
 * 【Agent事件类型】
 * 
 * 【功能说明】
 * 定义所有可能的Agent事件类型
 * 
 * 【事件说明】
 * - agent.started: Agent任务已启动
 * - agent.trace: Agent思考过程
 * - agent.message.delta: 流式文本片段
 * - tool.started: 工具调用开始
 * - tool.finished: 工具调用完成
 * - approval.requested: 需要用户审批
 * - approval.resolved: 审批已处理
 * - agent.input.requested: 需要用户输入
 * - agent.input.resolved: 用户输入已处理
 * - agent.finished: Agent任务完成
 * - agent.error: Agent任务出错
 */
export type AgentEventType =
  | "agent.started"
  | "agent.trace"
  | "agent.message.delta"
  | "tool.started"
  | "tool.finished"
  | "approval.requested"
  | "approval.resolved"
  | "agent.input.requested"
  | "agent.input.resolved"
  | "agent.finished"
  | "agent.error";

/**
 * 【Agent事件类型定义】
 * 
 * 【功能说明】
 * 表示从后端发送的Agent事件
 * 
 * 【字段说明】
 * @property type - 事件类型（AgentEventType）
 * @property runId - 运行ID，标识一次Agent任务
 * @property payload - 事件负载数据
 * @property ts - 时间戳（毫秒）
 */
export type AgentEvent = {
  type: AgentEventType;
  runId: string;
  payload: Record<string, unknown>;
  ts: number;
};

/**
 * 【Agent单元格写入类型】
 * 
 * 【功能说明】
 * 表示Agent的单元格写入操作
 * 
 * 【字段说明】
 * @property operation - 操作类型（cell_write: 单元格写入, text_replace: 文本替换）
 * @property documentName - 文档名称
 * @property ref - SDK引用标识
 * @property text - 文本内容
 * @property reason - 操作原因（可选）
 * @property tableIndex - 表格索引（可选）
 * @property row - 行号（可选）
 * @property col - 列号（可选）
 */
export type AgentCellWrite = {
  operation?: "cell_write" | "text_replace";
  documentName?: string;
  ref: string;
  text: string;
  reason?: string;
  tableIndex?: number;
  row?: number;
  col?: number;
};

/**
 * 【审批项类型】
 * 
 * 【功能说明】
 * 表示需要审批的单个操作项
 * 
 * 【字段说明】
 * @property itemId - 审批项唯一ID
 * @property oldText - 原始文本
 * @property newText - 新文本
 * 继承AgentCellWrite的所有字段
 */
export type ApprovalItem = AgentCellWrite & {
  itemId: string;
  oldText: string;
  newText: string;
};

/**
 * 【待处理审批类型】
 * 
 * 【功能说明】
 * 表示等待用户审批的审批请求
 * 
 * 【字段说明】
 * @property approvalId - 审批请求唯一ID
 * @property toolCallId - 工具调用ID（可选）
 * @property items - 审批项数组
 * @property createdAt - 创建时间
 */
export type PendingApproval = {
  approvalId: string;
  toolCallId?: string;
  items: ApprovalItem[];
  createdAt: number;
};

/**
 * 【审批解析结果类型】
 * 
 * 【功能说明】
 * 表示审批处理的结果
 * 
 * 【字段说明】
 * @property approvalId - 审批请求ID
 * @property approvedCount - 批准的数量
 * @property rejectedCount - 拒绝的数量
 * @property approved - 批准的项
 * @property rejected - 拒绝的项
 * @property writeResult - 写入结果
 * @property verifyResult - 验证结果
 * @property replaceResult - 替换结果
 * @property saveResult - 保存结果（可选）
 */
export type ApprovalResolution = {
  approvalId: string;
  approvedCount: number;
  rejectedCount: number;
  approved: ApprovalItem[];
  rejected: ApprovalItem[];
  writeResult: unknown[];
  verifyResult: unknown[];
  replaceResult: unknown[];
  saveResult?: unknown[];
};

/**
 * 【Agent输入请求类型】
 * 
 * 【功能说明】
 * 表示Agent需要用户输入的请求
 * 
 * 【字段说明】
 * @property inputRequestId - 输入请求唯一ID
 * @property toolCallId - 工具调用ID（可选）
 * @property question - 问题文本
 * @property reason - 需要输入的原因（可选）
 * @property expectedAnswerType - 期望的答案类型（可选）
 * @property choices - 选项列表（可选）
 * @property createdAt - 创建时间
 */
export type AgentInputRequest = {
  inputRequestId: string;
  toolCallId?: string;
  question: string;
  reason?: string;
  expectedAnswerType?: "text" | "choice" | "yes_no";
  choices?: string[];
  createdAt: number;
};

/**
 * 【Agent输入解析结果类型】
 * 
 * 【功能说明】
 * 表示用户输入的处理结果
 * 
 * 【字段说明】
 * @property inputRequestId - 输入请求ID
 * @property answer - 用户输入的答案
 */
export type AgentInputResolution = {
  inputRequestId: string;
  answer: string;
};

/**
 * 【Agent运行状态类型】
 * 
 * 【功能说明】
 * 定义Agent运行的状态
 * 
 * 【状态说明】
 * - running: 运行中
 * - waiting_approval: 等待审批
 * - finished: 已完成
 * - error: 出错
 * - cancelled: 已取消
 */
export type AgentRunStatus =
  | "running"
  | "waiting_approval"
  | "finished"
  | "error"
  | "cancelled";

/**
 * 【Agent运行实例类型】
 * 
 * 【功能说明】
 * 表示一次Agent任务的运行实例
 * 包含任务的所有状态和数据
 * 
 * 【字段说明】
 * @property runId - 运行ID
 * @property activeDocId - 当前激活的文档ID
 * @property documents - 文档列表
 * @property prompt - 用户输入的任务描述
 * @property permissionMode - 权限模式
 * @property llm - LLM配置
 * @property toolPolicy - 工具策略状态
 * @property status - 运行状态
 * @property events - 事件历史
 * @property pendingApprovals - 待处理的审批请求
 * @property pendingInputs - 待处理的输入请求
 * @property createdAt - 创建时间
 * @property updatedAt - 更新时间
 */
export type AgentRun = {
  runId: string;
  activeDocId: string | null;
  documents: AgentDocumentRef[];
  prompt: string;
  permissionMode: PermissionMode;
  llm: LlmConfig;
  toolPolicy: AgentToolPolicyState;
  status: AgentRunStatus;
  events: AgentEvent[];
  pendingApprovals: PendingApproval[];
  pendingInputs: AgentInputRequest[];
  createdAt: number;
  updatedAt: number;
};

/**
 * 【全文读取目的类型】
 * 
 * 【功能说明】
 * 定义读取全文的目的
 * 
 * 【目的说明】
 * - explicit_full_document_request: 用户明确要求读取全文
 * - targeted_tools_insufficient: 定向工具不足
 * - final_integrity_check: 最终完整性检查
 */
export type FullTextReadPurpose =
  | "explicit_full_document_request"
  | "targeted_tools_insufficient"
  | "final_integrity_check";

/**
 * 【待处理样式验证类型】
 * 
 * 【功能说明】
 * 表示等待验证的样式应用
 * 
 * 【字段说明】
 * @property documentName - 文档名称（可选）
 * @property query - 查询条件
 * @property sourceTool - 来源工具
 * @property createdAt - 创建时间
 */
export type PendingStyleVerification = {
  documentName?: string;
  query: Record<string, unknown>;
  sourceTool: "apply_text_style";
  createdAt: number;
};

/**
 * 【Agent工具策略状态类型】
 * 
 * 【功能说明】
 * 记录Agent工具使用的策略状态
 * 用于控制工具调用的行为
 * 
 * 【字段说明】
 * @property documentToolCallCount - 文档工具调用次数
 * @property hasLowTokenExploration - 是否进行了低token探索
 * @property fullTextBlockedCount - 全文读取被阻止的次数
 * @property lastFullTextBlockedReason - 最后一次全文读取被阻止的原因
 * @property pendingStyleVerification - 待处理的样式验证
 * @property completedStyleVerificationCount - 已完成的样式验证次数
 */
export type AgentToolPolicyState = {
  documentToolCallCount: number;
  hasLowTokenExploration: boolean;
  fullTextBlockedCount: number;
  lastFullTextBlockedReason?: string;
  pendingStyleVerification?: PendingStyleVerification;
  completedStyleVerificationCount: number;
};
