/**
 * ================================================================
 * Transaction Manager
 * ================================================================
 *
 * 事务管理（支持 rollback）
 */

import { v4 as uuidv4 } from "uuid";
import type { Transaction, TransactionStatus, WriteResult } from "./types";
import { rollbackWrite } from "./writer";

/** 事务存储 */
const transactions = new Map<string, Transaction>();

/**
 * 创建事务
 */
export function createTransaction(): Transaction {
  const transaction: Transaction = {
    id: `tx_${uuidv4()}`,
    status: "pending",
    writes: [],
    startedAt: new Date().toISOString(),
  };

  transactions.set(transaction.id, transaction);
  return transaction;
}

/**
 * 添加写入结果到事务
 */
export function addWriteToTransaction(
  transactionId: string,
  writeResult: WriteResult
): void {
  const transaction = transactions.get(transactionId);
  if (transaction) {
    transaction.writes.push(writeResult);
  }
}

/**
 * 提交事务
 */
export function commitTransaction(transactionId: string): void {
  const transaction = transactions.get(transactionId);
  if (transaction) {
    transaction.status = "committed";
    transaction.completedAt = new Date().toISOString();
  }
}

/**
 * 回滚事务
 */
export async function rollbackTransaction(
  transactionId: string,
  docId: string
): Promise<boolean> {
  const transaction = transactions.get(transactionId);
  if (!transaction) {
    return false;
  }

  // 按逆序回滚所有写入
  const reversedWrites = [...transaction.writes].reverse();
  let allRollbackSuccessful = true;

  for (const writeResult of reversedWrites) {
    if (writeResult.success) {
      const rollbackSuccessful = await rollbackWrite(docId, writeResult);
      if (!rollbackSuccessful) {
        allRollbackSuccessful = false;
      }
    }
  }

  transaction.status = allRollbackSuccessful ? "rolled_back" : "pending";
  transaction.completedAt = new Date().toISOString();

  return allRollbackSuccessful;
}

/**
 * 获取事务
 */
export function getTransaction(transactionId: string): Transaction | undefined {
  return transactions.get(transactionId);
}

/**
 * 删除事务
 */
export function deleteTransaction(transactionId: string): void {
  transactions.delete(transactionId);
}
