/**
 * DataGuard — 数据真实性硬拦截（安全守卫）
 *
 * 在 TemplateFiller 执行写入操作前，校验写入值是否在用户原始数据字典中。
 * 本质功能：防止 LLM 幻觉编造数据写入文档。
 *
 * 【为什么需要 DataGuard？】
 * LLM 可能在 Tool Calling 过程中编造值（幻觉），或者 TemplateFiller
 * 的映射逻辑产生错误映射，将错误的值写入正确的位置。
 * DataGuard 作为最后一道防线，确保只有用户明确提供的数据才能被写入。
 *
 * 【使用方式（生命周期管理）】
 *   DataGuard.arm(extractedData);     // 填表任务开始时装载白名单
 *   DataGuard.guard(value);           // 每次写入前校验
 *   DataGuard.disarm();               // 填表任务结束后释放状态
 *
 * 【熔断机制】
 * 累计拦截 ≥ MAX_BLOCKS_BEFORE_ABORT（5次）时触发熔断，
 * 防止大量非法写入刷屏或造成不可逆的文档损坏。
 *
 * 【校验规则】
 *   1. 未装载 → 允许所有（默认通行）
 *   2. 空字符串 → 允许（清空格子的合法操作）
 *   3. 精确匹配 → 允许（value ∈ allowedValues）
 *   4. 子串包含 → 允许（value 包含某个 allowedValue 或反之）
 *   5. 其他 → 拦截（不在白名单中的值一律拒绝）
 */

/** 单次校验结果 */
export interface GuardResult {
  /** 是否允许写入 */
  allowed: boolean;
  /** 拦截原因（仅 allowed=false 时有值） */
  reason?: string;
}

/**
 * DataGuard 类 — 所有成员均为静态（全局唯一状态）
 *
 * 设计为纯静态类，因为整个应用只需要一个数据守卫实例。
 * arm/disarm 管理状态生命周期，guard 执行实时校验。
 */
export class DataGuard {
  /** 允许写入的值白名单（从用户原始数据中提取） */
  private static allowedValues: Set<string> = new Set();
  /** 累计拦截次数（用于熔断判断） */
  private static blockedCount: number = 0;
  /** 熔断阈值：累计拦截超过此次数时触发报警 */
  private static readonly MAX_BLOCKS_BEFORE_ABORT = 5;
  /** 当前是否处于装载状态 */
  private static armed: boolean = false;

  /**
   * 装载数据字典（每次填表任务开始前调用）
   *
   * 将用户原始数据中的所有字段值提取到白名单中。
   * 只有白名单中的值才允许被写入文档。
   *
   * @param data 用户原始数据键值对（来自 DataExtractor 的提取结果）
   */
  static arm(data: Record<string, string>): void {
    this.allowedValues = new Set(
      Object.values(data)
        .filter((v) => v && v.trim().length > 0)
        .map((v) => v.trim()),
    );
    this.blockedCount = 0;
    this.armed = true;
  }

  /**
   * 释放数据字典（每次填表任务结束后调用）
   *
   * 清除白名单，重置拦截计数和装载状态。
   * 无论正常执行还是异常退出，都必须确保释放，防止状态泄漏。
   */
  static disarm(): void {
    this.allowedValues.clear();
    this.blockedCount = 0;
    this.armed = false;
  }

  /**
   * 检查 DataGuard 是否已装载
   * @returns 是否处于 armered 状态
   */
  static isArmed(): boolean {
    return this.armed;
  }

  /**
   * 校验写入值 — 核心方法
   *
   * 每次 TemplateFiller 执行 editor.setText() 前必须调用此方法。
   * 只有通过校验的值才允许实际写入文档。
   *
   * 【校验规则】
   *   1. 未装载 → 允许所有（默认通行，不拦截）
   *   2. 空字符串 → 允许（清空格子的合法操作）
   *   3. 精确匹配 → 允许（value === 某个 allowedValue）
   *   4. 子串包含 → 允许（value 包含某个 allowedValue，或某个 allowedValue 包含 value）
   *   5. 其他 → 拦截并记录原因
   *   6. 累计拦截 ≥ 5 → 触发熔断，reason 中包含熔断标记
   *
   * @param value 待写入的文本
   * @returns GuardResult
   */
  static guard(value: string): GuardResult {
    // 规则1：未装载 → 默认放行（上游可能在 arm 之前就尝试写入）
    if (!this.armed) {
      return { allowed: true };
    }

    const trimmed = value.trim();

    // 规则2：空字符串 → 允许（清空格子的合法操作）
    if (!trimmed) {
      return { allowed: true, reason: "空字符串写入" };
    }

    // 规则3：精确匹配
    if (this.allowedValues.has(trimmed)) {
      return { allowed: true };
    }

    // 规则4：子串包含匹配（覆盖"部分值"写入场景）
    for (const allowed of this.allowedValues) {
      if (trimmed.includes(allowed) || allowed.includes(trimmed)) {
        return { allowed: true };
      }
    }

    // 规则5：拦截（值不在白名单中）
    this.blockedCount++;
    const reason = `【数据守卫拦截】拒绝写入 "${trimmed.slice(0, 40)}"：该值不在用户原始数据字典中。`;

    // 规则6：熔断判断
    if (this.blockedCount >= this.MAX_BLOCKS_BEFORE_ABORT) {
      return {
        allowed: false,
        reason: `${reason} [累计拦截 ${this.blockedCount} 次，触发熔断]`,
      };
    }

    return { allowed: false, reason };
  }

  /**
   * 获取当前拦截计数（用于调试和日志）
   */
  static getBlockedCount(): number {
    return this.blockedCount;
  }

  /**
   * 获取当前允许值列表（调试用）
   * @returns 白名单中的值数组
   */
  static getAllowedValues(): string[] {
    return Array.from(this.allowedValues);
  }
}
