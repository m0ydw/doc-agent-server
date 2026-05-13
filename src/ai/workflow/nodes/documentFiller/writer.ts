/**
 * ================================================================
 * Writer
 * ================================================================
 *
 * 实际写入文档
 */

import type { WriteResult } from "./types";
import * as editor from "../../../../services/editor";
import { parseDocument } from "../docAnalyst/parser";

/**
 * 写入单个值
 */
export async function writeValue(
  docId: string,
  ref: string,
  value: string,
  tableIndex: number = 0
): Promise<WriteResult> {
  try {
    // 获取写入前的值（用于 rollback）
    const beforeValue = await readCurrentValue(docId, ref, tableIndex);

    // 执行写入
    const result = await editor.setText(docId, ref, value);

    return {
      success: true,
      ref,
      value,
      beforeValue,
    };
  } catch (err) {
    return {
      success: false,
      ref,
      value,
      error: (err as Error).message,
    };
  }
}

/**
 * 读取当前值
 */
async function readCurrentValue(docId: string, ref: string, tableIndex: number): Promise<string> {
  try {
    // 使用 readTable 获取当前值
    const tableResult = await editor.readTable(docId, tableIndex);
    const payload = await parseDocument(docId, true);
    const cell = payload.tables
      .find(table => table.index === tableIndex)
      ?.cells.find(c => c.ref === ref || c.nodeId === ref);
    return cell?.text || "";
  } catch {
    return "";
  }
}

/**
 * 回滚写入
 */
export async function rollbackWrite(
  docId: string,
  writeResult: WriteResult
): Promise<boolean> {
  if (!writeResult.beforeValue && writeResult.beforeValue !== "") {
    return false;
  }

  try {
    await editor.setText(docId, writeResult.ref, writeResult.beforeValue!);
    return true;
  } catch {
    return false;
  }
}
