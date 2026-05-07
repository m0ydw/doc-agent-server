import "dotenv/config";

export interface Config {
  PORT: number;
  COLLAB_WS_PORT: number;
  COLLAB_WS_URL: string;
}

const COLLAB_WS_PORT = Number(process.env.COLLAB_WS_PORT || "1234");

const config: Config = {
  PORT: Number(process.env.PORT || "3000"),
  COLLAB_WS_PORT,
  COLLAB_WS_URL:
    process.env.COLLAB_WS_URL || `ws://localhost:${COLLAB_WS_PORT}`,
};

export default config;
