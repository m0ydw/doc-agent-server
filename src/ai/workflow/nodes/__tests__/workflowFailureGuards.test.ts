import { END } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";
import { supervisorRouter } from "../../graph";
import { __testing as documentFillerTesting } from "../documentFiller";

describe("workflow failure guards", () => {
  it("doc_analyst failed 后 Router 不会进入 DocumentFiller", () => {
    const next = supervisorRouter({
      delegationStep: 2,
      planJson: JSON.stringify({
        agentPlan: [
          { agent: "doc_analyst" },
          { agent: "execution_planner" },
          { agent: "document_filler" },
        ],
      }),
      docAnalystStatus: "failed",
      workflowError: "",
      needsUserInput: false,
    } as never);

    expect(next).toBe(END);
  });

  it("workflowError 存在时 Router 立即停止", () => {
    const next = supervisorRouter({
      delegationStep: 1,
      planJson: JSON.stringify({ agentPlan: [{ agent: "document_filler" }] }),
      docAnalystStatus: "success",
      workflowError: "DocAnalyst 分析失败，未生成执行计划",
      needsUserInput: false,
    } as never);

    expect(next).toBe(END);
  });

  it("executionPlan 缺失时 Router 不会进入 DocumentFiller", () => {
    const next = supervisorRouter({
      delegationStep: 2,
      planJson: JSON.stringify({
        agentPlan: [
          { agent: "doc_analyst" },
          { agent: "execution_planner" },
          { agent: "document_filler" },
        ],
      }),
      docAnalystStatus: "success",
      executionPlannerStatus: "success",
      executionPlanId: "",
      executionPlan: "{}",
      workflowError: "",
      needsUserInput: false,
    } as never);

    expect(next).toBe(END);
  });

  it("DocumentFiller 收到 undefined plan 时返回 MISSING_EXECUTION_PLAN", () => {
    const result = documentFillerTesting.parseExecutionPlan(undefined);

    expect(result.plan).toBeUndefined();
    expect(result.error).toBe(documentFillerTesting.MISSING_EXECUTION_PLAN);
  });

  it("DocumentFiller 收到空对象 plan 时返回 MISSING_EXECUTION_PLAN", () => {
    const result = documentFillerTesting.parseExecutionPlan("{}");

    expect(result.plan).toBeUndefined();
    expect(result.error).toBe(documentFillerTesting.MISSING_EXECUTION_PLAN);
  });
});
