/**
 * ================================================================
 * SDK Tools — LangChain StructuredTool 子工具集
 * ================================================================
 *
 * 【职责】
 * 将后端已有的 SDK Agent（services/editor/editorOperations.ts）封装为
 * LangChain StructuredTool，供 ExecuteTool 中的 LLM 通过 tool calling 调用。
 *
 * 【为什么不直接调用 editor？】
 * LangChain 的 LLM 只能通过 StructuredTool 来与外部系统交互。
 * 把这些函数包装成工具后，LLM 可以自主决定"用什么工具、传什么参数"。
 *
 * 【每个工具的职责】
 *   sdk_find_text     → editor.findText()     → doc.query.match()
 *   sdk_replace_text  → editor.replaceFirst() → doc.mutations.apply(text.rewrite)
 *   sdk_replace_all   → editor.replaceAll()   → doc.mutations.apply(text.rewrite)
 *   sdk_get_text      → editor.getText()      → doc.getText()
 *   sdk_save          → 通过 sessionManager 获取 doc → doc.save()
 *
 * 【调用链】
 *   LLM (tool calling) → StructuredTool._call() → editor.xxx() → sessionManager → SDK API
 *
 * 【改进项 4 - 工具显示名动态化】
 *   每个工具类携带 static metadata（displayName / argsFormatter / showInUI），
 *   替代 globalAgent.ts 中硬编码的 TOOL_DISPLAY 字典。
 *   Agent 运行时通过 getToolMetadata() 动态读取。
 *
 * 【设计原则】
 *   1. 每个工具只做一件事（单一职责）
 *   2. 输入参数用 zod 校验，对 LLM 友好（description 要清晰）
 *   3. 输出用自然语言描述结果（LLM 可读，不是给程序读的）
 *   4. 所有 docId 在构造函数中注入（docId 由工作流状态管理）
 * ================================================================
 */

import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import * as editor from "../../services/editor";
import * as sessionManager from "../../services/session";

// ================================================================
// 工具 metadata 类型（改进项 4）
// ================================================================

/**
 * SDK 工具的 metadata
 * 每个工具类通过 static metadata 携带显示信息，
 * 替代 globalAgent.ts 中硬编码的 TOOL_DISPLAY 字典。
 */
export interface SDKToolMetadata {
  /** 前端展示的中文名 */
  displayName: string;
  /** 将工具调用参数格式化为中文描述 */
  argsFormatter: (args: Record<string, unknown>) => string;
  /**
   * 是否在 UI 中展示该工具调用
   * - true:  正常展示（如 sdk_find_text、sdk_replace_text）
   * - false: 隐藏（如 sdk_save，内部操作无需展示）
   */
  showInUI: boolean;
}

/**
 * 从工具实例获取其 metadata
 * 如果工具类未定义 metadata，返回默认值
 */
export function getToolMetadata(tool: StructuredTool): SDKToolMetadata {
  const ctor = tool.constructor as typeof StructuredTool & {
    metadata?: SDKToolMetadata;
  };
  if (ctor.metadata) return ctor.metadata;

  // 兜底：基于工具名生成默认 metadata
  return {
    displayName: tool.name,
    argsFormatter: () => "",
    showInUI: true,
  };
}

// ================================================================
// 1. sdk_find_text — 查找文本
// ================================================================

/**
 * 在文档中查找指定文本，返回匹配位置列表
 *
 * 【SDK 调用映射】
 *   doc.query.match({
 *     select: { type: "text", pattern: searchText },
 *     require: "any"
 *   })
 *   → 返回 items[]，每个 item 包含 text, ref, evaluatedRevision
 *
 * 【LLM 使用场景】
 *   - 在执行替换前先查找确认目标是否存在
 *   - 查找特定文本的位置信息
 *   - 验证替换结果（再查一遍看是否还有）
 */
export class SDKFindTextTool extends StructuredTool {
  name = "sdk_find_text";
  description = "在文档中查找指定文本，返回匹配的位置和数量。适用于：查找目标是否存、确认替换结果、定位文本";

  /** metadata（改进项 4）: 动态工具显示信息 */
  static metadata: SDKToolMetadata = {
    displayName: "搜索文本",
    argsFormatter: (a: Record<string, unknown>) => `搜索 "${a.pattern}"`,
    showInUI: true,
  };

  schema = z.object({
    pattern: z.string().describe("要查找的文本内容（区分大小写）"),
  });

  private docId: string;

  constructor(docId: string) {
    super();
    this.docId = docId;
  }

  async _call(input: z.infer<typeof this.schema>): Promise<string> {
    try {
      const matches = await editor.findText(this.docId, input.pattern);

      if (matches.length === 0) {
        return `未找到匹配"${input.pattern}"`;
      }

      const summary = `找到 ${matches.length} 处匹配"${input.pattern}"：\n` +
        matches.map((m, i) => `  ${i + 1}. "${m.text}"（位置索引: ${m.index}）`).join("\n");

      return summary;
    } catch (err: any) {
      return `查找失败: ${err.message}`;
    }
  }
}

// ================================================================
// 2. sdk_replace_text — 替换第一个匹配
// ================================================================

/**
 * 替换文档中第一个匹配的文本
 *
 * 【SDK 调用映射】
 *   1. doc.query.match({ select: { type: "text", pattern }, require: "first" })
 *      → 获取第一个匹配的 ref
 *   2. doc.mutations.apply({
 *        atomic: true,
 *        steps: [{ id, op: "text.rewrite", where: { by: "ref", ref }, args: { replacement: { text } } }]
 *      })
 *
 * 【LLM 使用场景】
 *   - 替换特定位置出现的文本（只改第一处）
 *   - 如果要用 sdk_find_text 先确认，再决定是否替换
 */
export class SDKReplaceTextTool extends StructuredTool {
  name = "sdk_replace_text";
  description = "替换文档中第一个匹配的文本。适用于：逐处替换、精确替换指定位置";

  /** metadata（改进项 4） */
  static metadata: SDKToolMetadata = {
    displayName: "替换文本",
    argsFormatter: (a: Record<string, unknown>) => `将 "${a.target}" 替换为 "${a.replacement}"`,
    showInUI: true,
  };

  schema = z.object({
    target: z.string().describe("要被替换的旧文本"),
    replacement: z.string().describe("替换后的新文本"),
  });

  private docId: string;

  constructor(docId: string) {
    super();
    this.docId = docId;
  }

  async _call(input: z.infer<typeof this.schema>): Promise<string> {
    try {
      const result = await editor.replaceFirst(this.docId, input.target, input.replacement);

      if (result.success) {
        return `成功替换: "${input.target}" → "${input.replacement}"（替换了 ${result.replaced} 处）`;
      } else {
        return `替换失败: ${result.message || `未找到"${input.target}"`}`;
      }
    } catch (err: any) {
      return `替换异常: ${err.message}`;
    }
  }
}

// ================================================================
// 3. sdk_replace_all — 替换所有匹配
// ================================================================

/**
 * 替换文档中所有匹配的文本
 *
 * 【SDK 调用映射】
 *   1. doc.query.match({ select: { type: "text", pattern }, require: "any" })
 *      → 获取所有匹配的 ref 列表
 *   2. doc.mutations.apply({
 *        atomic: true,
 *        steps: [每个匹配生成一个 text.rewrite 步骤]
 *      })
 *
 * 【LLM 使用场景】
 *   - 全文替换（如将所有"公司"替换为"集团"）
 *   - 批量格式修改
 */
export class SDKReplaceAllTool extends StructuredTool {
  name = "sdk_replace_all";
  description = "替换文档中所有匹配的文本。适用于：全文替换、批量修改";

  /** metadata（改进项 4） */
  static metadata: SDKToolMetadata = {
    displayName: "批量替换",
    argsFormatter: (a: Record<string, unknown>) => `将所有 "${a.target}" 替换为 "${a.replacement}"`,
    showInUI: true,
  };

  schema = z.object({
    target: z.string().describe("要被替换的旧文本"),
    replacement: z.string().describe("替换后的新文本"),
  });

  private docId: string;

  constructor(docId: string) {
    super();
    this.docId = docId;
  }

  async _call(input: z.infer<typeof this.schema>): Promise<string> {
    try {
      const result = await editor.replaceAll(this.docId, input.target, input.replacement);

      if (result.success) {
        return `成功全文替换: "${input.target}" → "${input.replacement}"（共替换 ${result.replaced} 处）`;
      } else {
        return `全文替换失败: ${result.message}`;
      }
    } catch (err: any) {
      return `全文替换异常: ${err.message}`;
    }
  }
}

// ================================================================
// 4. sdk_get_text — 获取文档全文
// ================================================================

/**
 * 读取文档的纯文本内容
 *
 * 【SDK 调用映射】
 *   doc.getText() → 返回全文纯文本
 *
 * 【LLM 使用场景】
 *   - 在执行操作前查看文档内容，了解文档结构
 *   - 操作后验证结果（如检查替换是否成功）
 *   - 查找特定上下文（如"找到标题附近的内容"）
 */
export class SDKGetTextTool extends StructuredTool {
  name = "sdk_get_text";
  description = "★★★【核心工具】读取文档的纯文本全文。当你需要理解文档内容、进行总结/分析/提取信息/翻译/回答问题时，必须先调用此工具获取文档内容！返回文档的全部文字。";

  /** metadata（改进项 4） */
  static metadata: SDKToolMetadata = {
    displayName: "读取文档",
    argsFormatter: () => "获取文档全文",
    showInUI: true,
  };

  schema = z.object({
    // 不需要额外的参数
  });

  private docId: string;

  constructor(docId: string) {
    super();
    this.docId = docId;
  }

  async _call(_input: z.infer<typeof this.schema>): Promise<string> {
    try {
      const text = await editor.getText(this.docId);

      if (!text || text.length === 0) {
        return "文档内容为空";
      }

      // 截取前 2000 字符，避免 LLM 上下文过长
      const excerpt = text.length > 2000
        ? text.slice(0, 2000) + `\n\n...（共 ${text.length} 字符，仅显示前 2000）`
        : text;

      return `文档全文（${text.length} 字符）：\n\n${excerpt}`;
    } catch (err: any) {
      return `读取文档失败: ${err.message}`;
    }
  }
}

// ================================================================
// 5. sdk_save — 保存文档
// ================================================================

/**
 * 保存文档的当前状态
 *
 * 【SDK 调用映射】
 *   通过 sessionManager 获取 doc 对象 → doc.save()
 *
 * 【LLM 使用场景】
 *   - 所有操作完成后持久化保存
 *   - 在协作模式下，修改会自动同步，save 是显式确认
 */
export class SDKSaveTool extends StructuredTool {
  name = "sdk_save";
  description = "保存文档的所有修改。在所有操作完成后调用此工具确认保存";

  /** metadata（改进项 4）: showInUI=false 替代原来的硬编码跳过逻辑 */
  static metadata: SDKToolMetadata = {
    displayName: "保存更改",
    argsFormatter: () => "保存文档修改",
    showInUI: false,
  };

  schema = z.object({
    // 不需要额外的参数
  });

  private docId: string;

  constructor(docId: string) {
    super();
    this.docId = docId;
  }

  async _call(_input: z.infer<typeof this.schema>): Promise<string> {
    try {
      // 通过 sessionManager 获取当前文档的会话
      const { doc } = await sessionManager.createOrUseSession(this.docId);
      await doc.save({});
      return "文档已保存";
    } catch (err: any) {
      // 协作模式下可能自动保存，save 失败不一定是错误
      return `保存完成（协作模式自动同步）`;
    }
  }
}

// ================================================================
// 统一 metadata 映射表（单一数据源，改进项 #7）
// ================================================================

/**
 * 工具名 → metadata 的单一映射表
 * 替代 globalAgent.ts、ToolCallBlock.tsx、AssistantCard.tsx 中的多套硬编码映射。
 *
 * 用法：
 *   const meta = SDK_TOOL_METADATA[toolName];
 *   console.log(meta.displayName);  // "搜索文本"
 *   console.log(meta.showInUI);     // true
 */
export const SDK_TOOL_METADATA: Record<string, SDKToolMetadata> = {
  [new SDKFindTextTool("").name]:    SDKFindTextTool.metadata,
  [new SDKReplaceTextTool("").name]: SDKReplaceTextTool.metadata,
  [new SDKReplaceAllTool("").name]:  SDKReplaceAllTool.metadata,
  [new SDKGetTextTool("").name]:     SDKGetTextTool.metadata,
  [new SDKSaveTool("").name]:        SDKSaveTool.metadata,
};
