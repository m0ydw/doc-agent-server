/**
 * ============================================================
 * 【协作状态服务 - collabStateService.ts】
 * ============================================================
 * 
 * 【链路式工程流说明】
 * 这是协作状态服务的核心模块，负责：
 * 1. 管理Yjs协作状态的持久化
 * 2. 加载和保存协作状态
 * 3. 删除协作状态
 * 4. 检查协作状态是否存在
 * 5. 清理协作状态
 * 
 * 【架构位置】
 * server.ts → 【collabStateService.ts】 → 文件系统
 * docRoutes.ts → 【collabStateService.ts】 → 文件系统
 * 
 * 【数据流】
 * 协作服务调用loadCollabState()
 *   ↓
 * 从文件系统读取Yjs状态
 *   ↓
 * 返回给协作服务
 * 
 * 协作服务调用saveCollabState()
 *   ↓
 * 将Yjs状态编码为二进制
 *   ↓
 * 写入文件系统
 * 
 * 【存储格式】
 * 使用Yjs的二进制格式
 * 存储在uploads/.collab-state/目录中
 * 文件名格式: {roomName}.bin
 * 
 * 【导出的函数】
 * - loadCollabState: 加载协作状态
 * - saveCollabState: 保存协作状态
 * - deleteCollabState: 删除协作状态
 * - hasCollabState: 检查协作状态是否存在
 * - cleanupCollabStates: 清理协作状态
 * 
 * 【使用的模块】
 * fs/promises: Node.js文件系统模块（Promise版本）
 *   - readFile: 读取文件
 *   - writeFile: 写入文件
 *   - rename: 重命名文件
 *   - unlink: 删除文件
 *   - readdir: 读取目录
 * 
 * fs: Node.js文件系统模块
 *   - existsSync: 同步检查文件是否存在
 *   - mkdirSync: 同步创建目录
 * 
 * path: Node.js路径模块
 *   - 路径处理
 * 
 * @superdoc-dev/superdoc-yjs-collaboration: 协作服务库
 *   - CollaborationParams: 协作参数类型
 * 
 * yjs: Yjs库
 *   - Y.Doc: Yjs文档类
 *   - Y.encodeStateAsUpdate: 编码状态为更新
 * 
 * ./docServices: 文档服务
 *   - UPLOAD_DIR: 上传目录路径
 * ============================================================
 */

// ... (原始文件内容)
