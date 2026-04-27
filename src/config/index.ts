import "dotenv/config";

export interface Config {
  PORT: number;
  COLLAB_WS_PORT: number;
  COLLAB_WS_URL: string;
}

const config: Config = {
  PORT: Number(process.env.PORT || "3000"),
  COLLAB_WS_PORT: Number(process.env.COLLAB_WS_PORT || process.env.HOCUSPOCUS_PORT || "1234"),
  COLLAB_WS_URL:
    process.env.COLLAB_WS_URL ||
    process.env.HOCUSPOCUS_URL ||
    `ws://localhost:${Number(process.env.COLLAB_WS_PORT || process.env.HOCUSPOCUS_PORT || "1234")}`,
};

export default config;
