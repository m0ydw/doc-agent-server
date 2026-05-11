/**
 * ================================================================
 * 文档字段配置（共享常量）
 *
 * 集中管理所有 Agent 节点使用的文档字段名，
 * 消除 orchestrator / docAnalyst / templateMapper 三处重复定义。
 * ================================================================
 */

/** 字段配置：标准字段名 → 变体列表（文档中可能出现的标签文本） */
export const FIELD_CONFIG = {
  "项目名称": {
    variants: ["项目名称", "项目名", "课题名称", "课题名", "项目标题", "标题", "名称"],
  },
  "负责人": {
    variants: ["负责人", "主持人", "项目负责人", "组长", "责任人", "姓名", "学生姓名"],
  },
  "指导教师": {
    variants: ["指导教师", "导师", "指导老师", "老师", "指导教师姓名"],
  },
  "团队成员": {
    variants: ["团队成员", "成员", "组员", "队伍", "团队", "队员"],
  },
  "电话": {
    variants: ["电话", "手机", "手机号", "联系电话", "联系方式", "号码"],
  },
  "邮箱": {
    variants: ["邮箱", "电子邮件", "email", "E-mail", "邮件"],
  },
  "学号": {
    variants: ["学号", "学生号", "编号"],
  },
  "班级": {
    variants: ["班级", "年级", "班级名称"],
  },
  "学院": {
    variants: ["学院", "院系", "系别"],
  },
  "专业": {
    variants: ["专业", "专业名称"],
  },
} as const;

// ================================================================
// 派生常量（供各模块按需导入）
// ================================================================

/** 标准字段名列表（供 orchestrator DataExtractor 使用） */
export const KNOWN_FIELDS: string[] = Object.keys(FIELD_CONFIG);

/** 所有变体标签的展开列表（供 docAnalyst 在文档中搜索） */
export const ALL_LABELS: string[] = Object.values(FIELD_CONFIG).flatMap(
  (f) => f.variants as readonly string[]
);

/** 字段名 → 变体列表映射（供 templateMapper 匹配使用） */
export const LABEL_VARIANTS_MAP: Record<string, readonly string[]> = {};
for (const [key, config] of Object.entries(FIELD_CONFIG)) {
  LABEL_VARIANTS_MAP[key] = config.variants;
}
