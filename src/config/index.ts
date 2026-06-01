/**
 * ============================================================
 * 【后端全局配置 - config/index.ts】
 * ============================================================
 *
 * 【链路式工程流说明】
 * 这是后端的全局配置文件，负责：
 * 1. 加载环境变量（dotenv）
 * 2. 定义配置接口
 * 3. 从环境变量读取配置值
 * 4. 提供默认值
 * 5. 导出配置对象
 *
 * 【配置管理原则】
 * - 所有可调参数集中管理
 * - 通过环境变量覆盖默认值
 * - 避免配置散落在各个文件中
 * - 方便运维统一调整
 *
 * 【环境变量加载】
 * dotenv在import时自动加载.env文件到process.env
 * 这样就可以通过process.env读取.env文件中的配置
 *
 * 【使用的库】
 * dotenv: 环境变量加载库
 *   - 从.env文件加载环境变量到process.env
 *   - 支持默认值和类型转换
 * ============================================================
 */

/**
 * 【导入区】
 */

// 【dotenv配置加载】
// 从.env文件加载环境变量到process.env
// 必须在其他import之前执行
// 这样后续的process.env才能读取到.env中的值
import "dotenv/config";

// ================================================================
// 【配置接口定义】
// ================================================================

/**
 * 【配置接口】
 *
 * 【功能说明】
 * 定义配置对象的类型结构
 * 确保配置的类型安全
 *
 * 【字段说明】
 * @property PORT - HTTP REST API服务端口
 *   - 前端和Agent都通过此端口访问
 *   - 默认值: 3000
 *   - 环境变量: PORT
 *
 * @property COLLAB_WS_PORT - 协作WebSocket端口
 *   - 独立于HTTP端口，避免冲突
 *   - 默认值: 1234
 *   - 环境变量: COLLAB_WS_PORT
 *
 * @property COLLAB_WS_URL - 协作WebSocket完整地址
 *   - SDK客户端通过此URL连接协作服务
 *   - 默认值: ws://localhost:
 *   - 环境变量: COLLAB_WS_URL
 */
export interface Config {
  PORT: number;
  COLLAB_WS_PORT: number;
  COLLAB_WS_URL: string;
}

// ================================================================
// 【配置值读取】
// ================================================================

/**
 * 【协作WebSocket端口】
 *
 * 【功能说明】
 * 协作服务的WebSocket端口
 * 独立于HTTP端口，避免与Express/AWS冲突
 *
 * 【默认值】
 * 1234
 *
 * 【环境变量】
 * COLLAB_WS_PORT
 */
const COLLAB_WS_PORT = Number(process.env.COLLAB_WS_PORT || "1234");

/**
 * 【配置对象】
 *
 * 【功能说明】
 * 包含所有配置值的对象
 * 从环境变量读取，提供默认值
 *
 * 【配置来源优先级】
 * 1. 环境变量（.env文件或系统环境变量）
 * 2. 代码中的默认值
 */
const config: Config = {
  /**
   * 【HTTP REST API服务端口】
   *
   * 【功能说明】
   * 前端和Agent都通过此端口访问后端API
   *
   * 【默认值】
   * 3000
   *
   * 【环境变量】
   * PORT
   */
  PORT: Number(process.env.PORT || "3000"),

  /**
   * 【协作WebSocket端口】
   *
   * 【功能说明】
   * 协作服务的WebSocket端口
   * 独立于HTTP端口，避免冲突
   *
   * 【默认值】
   * 1234
   */
  COLLAB_WS_PORT,

  /**
   * 【协作WebSocket完整地址】
   *
   * 【功能说明】
   * SDK客户端通过此URL连接协作服务
   * 默认指向本地COLLAB_WS_PORT
   * 部署时可改为远程地址
   *
   * 【默认值】
   * ws://localhost:
   *
   * 【环境变量】
   * COLLAB_WS_URL
   */
  COLLAB_WS_URL:
    process.env.COLLAB_WS_URL || `ws://localhost:${COLLAB_WS_PORT}`,
};

// ================================================================
// 【导出】
// ================================================================

/**
 * 【导出配置对象】
 *
 * 【功能说明】
 * 导出配置对象，供整个后端项目使用
 *
 * 【使用示例】
 * import config from "./config";
 * const port = config.PORT;
 */
export default config;
