import express, { Express, Request, Response, NextFunction } from "express";

const app: Express = express();

app.use(function(req: Request, res: Response, next: NextFunction) {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, X-File-Name, X-Original-Filename");
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json({
  verify: function(req: Request, _res: Response, buf: Buffer) {
    (req as any).rawBody = buf;
  },
}));

app.use(express.urlencoded({
  extended: true,
  verify: function(req: Request, _res: Response, buf: Buffer) {
    (req as any).rawBody = buf;
  },
}));

// AI 路由
import aiRoutes from "./routes/aiRoutes";
app.use("/api/ai", aiRoutes);

export default app;