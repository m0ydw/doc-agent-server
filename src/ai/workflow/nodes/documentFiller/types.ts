/**
 * ================================================================
 * Document Filler 类型定义
 * ================================================================
 */

import type {
  ExecutionPlan,
  FillPlan,
  ExecutionOptions,
  WriteResult,
  Transaction,
  TransactionStatus,
} from "../docAnalyst/types";

export type {
  ExecutionPlan,
  FillPlan,
  ExecutionOptions,
  WriteResult,
  Transaction,
  TransactionStatus,
};

/** Dry-run 结果 */
export interface DryRunResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  estimatedWrites: number;
}

/** 验证结果 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}
