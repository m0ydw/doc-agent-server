import { describe, expect, it } from "vitest";
import { __testing } from "../tableFill/analyzer";
import type { TableCellRef } from "../tableFill/types";

function cell(row: number, col: number, text: string): TableCellRef {
  return {
    tableIndex: 0,
    row,
    col,
    ref: `ref_${row}_${col}`,
    nodeId: `node_${row}_${col}`,
    text,
    rowspan: 1,
    colspan: 1,
    gridColEnd: col + 1,
  };
}

describe("tableFill analyzer header detection", () => {
  it("findLikelyHeaderRow 遇到空 rows 不抛异常", () => {
    expect(__testing.findLikelyHeaderRow([], 0, 0)).toBeNull();
  });

  it("findLikelyHeaderRow 遇到空 cells 不抛异常", () => {
    expect(__testing.findLikelyHeaderRow([], 3, 4)).toBeNull();
  });

  it("findLikelyHeaderRow 遇到 section 但没有 header row 时返回 null", () => {
    const cells = [
      cell(1, 0, ""),
      cell(1, 1, ""),
      cell(2, 0, "这是一个很长的说明文本，不应被识别为表头"),
    ];

    expect(__testing.findLikelyHeaderRow(cells, 3, 2)).toBeNull();
  });

  it("findLikelyHeaderRow 对 row > 0 的行会初始化 rowMap，不再 undefined.push", () => {
    const cells = [
      cell(2, 0, "姓名"),
      cell(2, 1, "电话"),
      cell(3, 0, "张三"),
      cell(3, 1, "13800000000"),
    ];

    expect(__testing.findLikelyHeaderRow(cells, 4, 2)).toBe(2);
  });

  it("extractSectionTemplates 遇到 headerRow=null 时不会崩溃", () => {
    const result = __testing.extractSectionTemplates({
      tables: [{
        index: 0,
        rows: 3,
        cols: 2,
        cells: [
          cell(0, 0, ""),
          cell(0, 1, ""),
          cell(1, 0, ""),
          cell(1, 1, ""),
        ],
      }],
    });

    expect(result.sections).toEqual([]);
    expect(result.failedSections).toEqual([
      { sectionName: "table_0", tableIndex: 0, reason: "HEADER_ROW_NOT_FOUND" },
    ]);
  });

  it("extractSectionTemplates 能识别 23x10 大表中的申请人和指导教师 section", () => {
    const cells = [
      cell(0, 0, "申请人或申请团队"),
      cell(1, 0, "角色"),
      cell(1, 1, "姓名"),
      cell(1, 2, "年级"),
      cell(1, 3, "学校"),
      cell(1, 4, "所在院系/专业"),
      cell(1, 5, "联系电话"),
      cell(1, 6, "E-mail"),
      cell(10, 0, "指导教师"),
      cell(11, 0, "姓名"),
      cell(11, 1, "年龄"),
      cell(11, 2, "研究方向"),
      cell(11, 3, "行政职务/专业技术职务"),
      cell(11, 4, "手机"),
      cell(11, 5, "电子邮箱"),
    ];

    const result = __testing.extractSectionTemplates({
      tables: [{ index: 1, rows: 23, cols: 10, cells }],
    });

    expect(result.sections.map(section => section.sectionName)).toEqual([
      "申请人或申请团队",
      "指导教师",
    ]);
    expect(result.sections[0].columns.map(column => column.colIndex)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(result.sections[1].columns.map(column => column.colIndex)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("空文本 cell 不能被当作 header row", () => {
    const result = __testing.extractSectionTemplates({
      tables: [{
        index: 1,
        rows: 23,
        cols: 10,
        cells: [cell(0, 0, ""), cell(0, 1, ""), cell(1, 0, "")],
      }],
    });

    expect(result.sections).toEqual([]);
    expect(result.failedSections[0].reason).toBe("SECTION_TEMPLATE_NOT_FOUND");
  });

  it("detectDuplicateTemplates 能在 DocAnalyst 阶段发现重复目标", () => {
    const duplicates = __testing.detectDuplicateTemplates([
      {
        fieldPath: "项目名称",
        value: "A",
        tableIndex: 0,
        row: 0,
        col: 1,
        referenceNodeId: "node_a",
        referenceRef: "ref_a",
        confidence: 0.9,
        reason: "test",
      },
      {
        fieldPath: "项目类型",
        value: "B",
        tableIndex: 0,
        row: 0,
        col: 1,
        referenceNodeId: "node_b",
        referenceRef: "ref_b",
        confidence: 0.9,
        reason: "test",
      },
    ]);

    expect(duplicates).toEqual([
      {
        targetKey: "0:0:1",
        tableIndex: 0,
        row: 0,
        col: 1,
        fieldPaths: ["项目名称", "项目类型"],
      },
    ]);
  });
});
