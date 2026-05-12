// 全局配置常量 — 所有可调参数集中管理，通过环境变量覆盖默认值
// 为何集中：避免配置散落在各个文件中，方便运维统一调整
// dotenv 在 import 时自动加载 .env 文件到 process.env

import "dotenv/config";

export interface Config {
  PORT: number;
  COLLAB_WS_PORT: number;
  COLLAB_WS_URL: string;
}

// 协作 WebSocket 端口 — 独立于 HTTP 端口，避免与 Express/AWS 冲突
// 默认 1234，生产环境可通过 COLLAB_WS_PORT 环境变量覆盖
const COLLAB_WS_PORT = Number(process.env.COLLAB_WS_PORT || "1234");

const config: Config = {
  // HTTP REST API 服务端口，前端和 Agent 都通过此端口访问
  PORT: Number(process.env.PORT || "3000"),
  COLLAB_WS_PORT,
  // 协作 WebSocket 完整地址 — SDK 客户端通过此 URL 连接协作服务
  // 默认指向本地 COLLAB_WS_PORT，部署时可改为远程地址
  COLLAB_WS_URL:
    process.env.COLLAB_WS_URL || `ws://localhost:${COLLAB_WS_PORT}`,
};

export default config;
