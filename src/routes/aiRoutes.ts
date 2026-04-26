/**
 * AI 路由
 */

import { Router, Request, Response } from "express";
import { runAgentStream } from "../ai/service/aiService";

const router: Router = Router();

router.post("/agent/run/stream", function(req: Request, res: Response) {
  runAgentStream(req, res);
});

export default router;