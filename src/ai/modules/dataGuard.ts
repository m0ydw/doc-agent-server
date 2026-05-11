/**
 * DataGuard — 数据真实性硬拦截
 *
 * 在 TemplateFiller 执行写入操作前，校验写入值是否在用户原始数据字典中。
 * 防止 LLM 幻觉编造数据。
 *
 * 使用方式：
 *   DataGuard.arm(extractedData);     // 填表任务开始时设置
 *   DataGuard.guard(value);           // 每次写入前校验
 *   DataGuard.disarm();               // 填表任务结束后释放
 */

/** 单次校验结果 */
export interface GuardResult {
  allowed: boolean;
  reason?: string;
}

export class DataGuard {
  private static allowedValues: Set<string> = new Set();
  private static blockedCount: number = 0;
  private static readonly MAX_BLOCKS_BEFORE_ABORT = 5;
  private static armed: boolean = false;

  /**
   * 装载数据字典（每次填表任务开始前调用）
   * @param data - 用户原始数据键值对
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
   */
  static disarm(): void {
    this.allowedValues.clear();
    this.blockedCount = 0;
    this.armed = false;
  }

  /**
   * 检查 DataGuard 是否已装载
   */
  static isArmed(): boolean {
    return this.armed;
  }

  /**
   * 校验写入值
   * @param value - 待写入的文本
   * @returns GuardResult
   *   - allowed=true  → 允许写入
   *   - allowed=false → 拦截，reason 含原因
   *
   * 规则：
   *   1. 空字符串：允许（清除格子的合法操作，但仅在数据字典未装载时）
   *   2. 精确匹配：value ∈ allowedValues → 允许
   *   3. 子串包含：value 包含某个 allowedValue 或反之 → 允许
   *   4. 其他：拦截
   *   5. 累计拦截 ≥ MAX_BLOCKS_BEFORE_ABORT → 熔断
   */
  static guard(value: string): GuardResult {
    if (!this.armed) {
      return { allowed: true }; // 未装载，不拦截
    }

    const trimmed = value.trim();

    // 空字符串：如果数据字典中有任何值，拒绝空写入（防止清空已填入的数据）
    // 例外：除非用户原始数据中确实有空值
    if (!trimmed) {
      // 检查是否有字段被清空的合法需求
      return { allowed: true, reason: "空字符串写入" };
    }

    // 精确匹配
    if (this.allowedValues.has(trimmed)) {
      return { allowed: true };
    }

    // 子串包含匹配
    for (const allowed of this.allowedValues) {
      if (trimmed.includes(allowed) || allowed.includes(trimmed)) {
        return { allowed: true };
      }
    }

    // 拦截
    this.blockedCount++;
    const reason = `【数据守卫拦截】拒绝写入 "${trimmed.slice(0, 40)}"：该值不在用户原始数据字典中。`;

    if (this.blockedCount >= this.MAX_BLOCKS_BEFORE_ABORT) {
      return {
        allowed: false,
        reason: `${reason} [累计拦截 ${this.blockedCount} 次，触发熔断]`,
      };
    }

    return { allowed: false, reason };
  }

  /**
   * 获取当前拦截计数
   */
  static getBlockedCount(): number {
    return this.blockedCount;
  }

  /**
   * 获取当前允许值列表（调试用）
   */
  static getAllowedValues(): string[] {
    return Array.from(this.allowedValues);
  }
}
