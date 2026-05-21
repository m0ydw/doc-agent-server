import { WebSocketServer, type WebSocket } from "ws";
import type { Server } from "http";
import * as editor from "../editor";
import {
  addEvent,
  cancelRun,
  createRun,
  getRun,
  resolveApprovalResult,
  resolvePendingApproval,
} from "./agentSessionManager";
import { runAgent } from "./agentRunner";
import type { AgentEvent, AgentStartPayload, ApprovalResolution } from "./agentTypes";

type ClientMessage =
  | { type: "agent.start"; payload: AgentStartPayload }
  | { type: "agent.cancel"; runId: string }
  | {
      type: "agent.approval.resolve";
      runId: string;
      payload: {
        approvalId: string;
        decisions: Array<{
          itemId: string;
          approved: boolean;
          reason?: string;
        }>;
      };
    }
  | { type: "agent.replay"; runId: string };

function send(ws: WebSocket, event: AgentEvent): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(event));
  }
}

function sendRaw(
  ws: WebSocket,
  type: AgentEvent["type"],
  runId: string,
  payload: Record<string, unknown>,
): void {
  send(ws, { type, runId, payload, ts: Date.now() });
}

function normalizeStartPayload(payload: AgentStartPayload): AgentStartPayload {
  const documents =
    payload.documents?.length
      ? payload.documents
      : payload.docId
        ? [{ id: payload.docId, name: "当前文档", active: true }]
        : [];
  return {
    ...payload,
    documents,
    permissionMode: payload.permissionMode || "review_required",
    llm: {
      provider: "deepseek",
      apiKey: payload.llm?.apiKey || "",
      baseURL: payload.llm?.baseURL || "https://api.deepseek.com",
      model: payload.llm?.model || "deepseek-flash",
    },
  };
}

async function handleApprovalResolve(
  ws: WebSocket,
  message: Extract<ClientMessage, { type: "agent.approval.resolve" }>,
): Promise<void> {
  const run = getRun(message.runId);
  if (!run) {
    sendRaw(ws, "agent.error", message.runId, { message: "Agent run 不存在" });
    return;
  }

  const approval = resolvePendingApproval(
    message.runId,
    message.payload.approvalId,
  );
  if (!approval) {
    sendRaw(ws, "agent.error", message.runId, { message: "审批项不存在或已处理" });
    return;
  }

  const decisions = new Map(
    message.payload.decisions.map((decision) => [decision.itemId, decision]),
  );
  const approved = approval.items.filter(
    (item) => decisions.get(item.itemId)?.approved,
  );
  const rejected = approval.items.filter(
    (item) => !decisions.get(item.itemId)?.approved,
  );

  const writeResult = [];
  const verifyResult = [];
  const replaceResult = [];

  for (const item of approved) {
    const targetDoc =
      run.documents.find((doc) => doc.name === item.documentName) ??
      run.documents.find((doc) => doc.id === run.activeDocId) ??
      run.documents[0];
    if (!targetDoc) continue;

    if (item.operation === "text_replace") {
      replaceResult.push(
        ...(await editor.replaceByRefs(targetDoc.id, [
          {
            ref: item.ref,
            oldText: item.oldText,
            text: item.newText,
            reason: item.reason,
          },
        ])),
      );
    } else {
      const cell = {
        ref: item.ref,
        text: item.newText,
        reason: item.reason,
      };
      writeResult.push(...(await editor.writeCellsText(targetDoc.id, [cell])));
      verifyResult.push(...(await editor.verifyCells(targetDoc.id, [cell])));
    }
  }

  const resolution: ApprovalResolution = {
    approvalId: approval.approvalId,
    approvedCount: approved.length,
    rejectedCount: rejected.length,
    approved,
    rejected,
    writeResult,
    verifyResult,
    replaceResult,
  };
  const event = addEvent(message.runId, "approval.resolved", resolution);
  send(ws, event);
  resolveApprovalResult(approval.approvalId, resolution);
}

export function attachAgentWebSocket(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ server, path: "/ws/agent" });

  wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      void (async () => {
        let message: ClientMessage;
        try {
          message = JSON.parse(String(raw)) as ClientMessage;
        } catch {
          sendRaw(ws, "agent.error", "unknown", { message: "无法解析 WS 消息" });
          return;
        }

        if (message.type === "agent.start") {
          const payload = normalizeStartPayload(message.payload);
          if (payload.llm.provider !== "deepseek") {
            sendRaw(ws, "agent.error", "unknown", {
              message: "第一版只支持 DeepSeek",
            });
            return;
          }

          const run = createRun(payload);
          send(
            ws,
            addEvent(run.runId, "agent.started", {
              runId: run.runId,
              documentCount: run.documents.length,
              activeDocument:
                run.documents.find((doc) => doc.id === run.activeDocId)?.name ??
                "当前文档",
              permissionMode: run.permissionMode,
              model: run.llm.model,
            }),
          );
          void runAgent(run.runId, (event) => send(ws, event));
          return;
        }

        if (message.type === "agent.cancel") {
          cancelRun(message.runId);
          send(
            ws,
            addEvent(message.runId, "agent.finished", {
              summary: "Agent 任务已取消。",
            }),
          );
          return;
        }

        if (message.type === "agent.replay") {
          const run = getRun(message.runId);
          if (!run) return;
          run.events.forEach((event) => send(ws, event));
          return;
        }

        if (message.type === "agent.approval.resolve") {
          await handleApprovalResolve(ws, message);
        }
      })();
    });
  });

  return wss;
}
