import "dotenv/config";

export interface Config {
  PORT: number;
  HOCUSPOCUS_PORT: number;
  HOCUSPOCUS_URL: string;
}

const config: Config = {
  PORT: Number(process.env.PORT || "3000"),
  HOCUSPOCUS_PORT: Number(process.env.HOCUSPOCUS_PORT || "1234"),
  HOCUSPOCUS_URL:
    process.env.HOCUSPOCUS_URL ||
    `ws://localhost:${Number(process.env.HOCUSPOCUS_PORT || "1234")}`,
};

export default config;