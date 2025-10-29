/**
 * Web监控服务器（重构版）
 * 使用模块化设计，将功能分解到不同的处理器中
 */

import * as http from 'http'
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { RpcServer } from './rpc-server.js'
import { createLogger } from './logger.js'
import { getConfig } from './config-manager.js'
import { NodeManager } from './node-manager.js'
import { IPPoolSyncManager } from './ip-pool-sync.js'
import { WebSocketHandler } from './websocket-handler.js'
import { APIRoutes } from './api-routes.js'
import { WebUIGenerator } from './web-ui-generator.js'

const logger = createLogger('MonitorServer')

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export class MonitorServer {
  private server: http.Server | null = null
  private rpcServer: RpcServer
  private nodeManager: NodeManager
  private ipPoolSyncManager: IPPoolSyncManager
  private websocketHandler: WebSocketHandler
  private apiRoutes: APIRoutes
  private metricsInterval: NodeJS.Timeout | null = null
  private metricsFilePath: string = path.join(process.cwd(), 'logs', 'metrics.log')

  constructor(
    private port: number,
    rpcServer: RpcServer
  ) {
    this.rpcServer = rpcServer
    this.nodeManager = new NodeManager()
    this.ipPoolSyncManager = new IPPoolSyncManager()
    
    // 初始化处理器
    this.websocketHandler = new WebSocketHandler(this.rpcServer, this.nodeManager, this.ipPoolSyncManager, () => this.getVersion())
    this.apiRoutes = new APIRoutes(this.rpcServer, this.nodeManager, this.ipPoolSyncManager, () => this.getVersion())
  }

  /**
   * 实时读取版本号（每次调用时读取，确保获取最新版本）
   */
  private getVersion(): string {
    try {
      // 方法1：从 dist/server 向上两级到项目根目录
      let packagePath = path.join(__dirname, '../../package.json')

      // 方法2：如果方法1失败，尝试从当前工作目录
      if (!fs.existsSync(packagePath)) {
        packagePath = path.join(process.cwd(), 'package.json')
        logger.debug('使用工作目录路径读取版本号', { path: packagePath })
      }

      const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf-8'))
      const version = packageJson.version || 'unknown'

      logger.debug('读取版本号成功', { version, path: packagePath })
      return version
    } catch (error) {
      logger.error('读取版本号失败', error as Error, {
        __dirname,
        attemptedPath: path.join(__dirname, '../../package.json')
      })
      return 'unknown'
    }
  }

  /**
   * 启动监控服务器（HTTP + WebSocket）
   */
  public start(): void {
    // 确保日志目录存在
    try {
      const dir = path.dirname(this.metricsFilePath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
    } catch { }

    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res)
    })

    // 创建 WebSocket 服务器（在同一个 HTTP 服务器上）
    this.websocketHandler.start(this.server)

    this.server.listen(this.port, () => {
      logger.info(`监控服务器已启动`, {
        port: this.port,
        version: this.getVersion(),
        pid: process.pid
      })
    })

    // 启动定期指标收集
    this.startMetricsCollection()

    // 启动节点管理器
    // NodeManager在构造函数中自动启动健康检查

    // 启动IP池同步管理器
    this.ipPoolSyncManager.startPeriodicSync()
    this.ipPoolSyncManager.startHealthCheck()
  }

  /**
   * 处理HTTP请求
   */
  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url || '/', `http://${req.headers.host}`)
    const pathname = url.pathname

    // 设置CORS头
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

    // 处理OPTIONS请求
    if (req.method === 'OPTIONS') {
      res.writeHead(200)
      res.end()
            return
          }

    try {
      // 处理WebSocket升级请求
      if (pathname === '/ws') {
        // WebSocket升级由WebSocketHandler自动处理
            return
          }

      // 处理API路由
      if (pathname.startsWith('/api/')) {
        this.apiRoutes.handleRequest(req, res)
            return
          }

      // 处理静态文件请求
      if (pathname === '/' || pathname === '/index.html') {
        this.serveIndexPage(res)
        return
      }

      // 处理其他静态资源
      this.serveStaticFile(pathname, res)

        } catch (error) {
      logger.error('处理请求时发生错误', error as Error, {
        method: req.method,
        url: req.url,
        pathname
      })
      
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Internal Server Error' }))
    }
  }

  /**
   * 提供主页面
   */
  private serveIndexPage(res: http.ServerResponse): void {
    try {
      const html = WebUIGenerator.generateHTML()
      
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(html)
      
      logger.debug('已提供主页面')
    } catch (error) {
      logger.error('提供主页面失败', error as Error)
      
      res.writeHead(500, { 'Content-Type': 'text/html' })
      res.end(`
        <html>
          <head><title>ZeroMaps RPC - 错误</title></head>
          <body>
            <h1>服务器错误</h1>
            <p>无法加载管理面板，请检查服务器日志。</p>
          </body>
        </html>
      `)
    }
  }

  /**
   * 提供静态文件
   */
  private serveStaticFile(pathname: string, res: http.ServerResponse): void {
    try {
      // 安全路径检查
      if (pathname.includes('..') || pathname.includes('~')) {
        res.writeHead(403, { 'Content-Type': 'text/plain' })
        res.end('Forbidden')
        return
      }

      // 构建文件路径
      const filePath = path.join(process.cwd(), 'public', pathname)
      
      // 检查文件是否存在
      if (!fs.existsSync(filePath)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' })
        res.end('Not Found')
        return
      }

      // 读取文件
      const fileContent = fs.readFileSync(filePath)
      
      // 设置Content-Type
      const ext = path.extname(pathname).toLowerCase()
      const mimeTypes: { [key: string]: string } = {
        '.html': 'text/html',
        '.css': 'text/css',
        '.js': 'application/javascript',
        '.json': 'application/json',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon'
      }
      
      const contentType = mimeTypes[ext] || 'application/octet-stream'
      
      res.writeHead(200, { 'Content-Type': contentType })
      res.end(fileContent)
      
      logger.debug('已提供静态文件', { pathname, contentType })
    } catch (error) {
      logger.error('提供静态文件失败', error as Error, { pathname })
      
      res.writeHead(500, { 'Content-Type': 'text/plain' })
      res.end('Internal Server Error')
    }
  }

  /**
   * 启动定期指标收集
   */
  private startMetricsCollection(): void {
    this.metricsInterval = setInterval(async () => {
      try {
        const stats = await this.rpcServer.getStats()
        const timestamp = new Date().toISOString()
        
        // 记录到文件
        const logEntry = {
          timestamp,
          stats,
          version: this.getVersion(),
          pid: process.pid,
          memory: process.memoryUsage(),
          uptime: process.uptime()
        }
        
        fs.appendFileSync(this.metricsFilePath, JSON.stringify(logEntry) + '\n')
        
        // 通过WebSocket广播统计数据
        this.websocketHandler.broadcast({
          type: 'stats',
          data: stats
        })
        
        logger.debug('指标已收集并广播', { 
          totalClients: stats.totalClients,
          fetcherType: stats.fetcherType
        })
    } catch (error) {
        logger.error('收集指标时发生错误', error as Error)
      }
    }, 5000) // 每5秒收集一次
  }

  /**
   * 停止监控服务器
   */
  public stop(): void {
    logger.info('正在停止监控服务器...')

    // 停止指标收集
    if (this.metricsInterval) {
      clearInterval(this.metricsInterval)
      this.metricsInterval = null
    }

    // 停止WebSocket处理器
    this.websocketHandler.stop()

    // 停止节点管理器
    this.nodeManager.stop()

    // 停止IP池同步管理器
    this.ipPoolSyncManager.stop()

    // 关闭HTTP服务器
    if (this.server) {
      this.server.close(() => {
        logger.info('监控服务器已停止')
      })
      this.server = null
    }
  }

  /**
   * 获取服务器信息
   */
  public getInfo(): { port: number; version: string; pid: number } {
    return {
      port: this.port,
      version: this.getVersion(),
      pid: process.pid
    }
  }

  /**
   * 获取节点管理器实例
   */
  public getNodeManager(): NodeManager {
    return this.nodeManager
  }

  /**
   * 获取IP池同步管理器实例
   */
  public getIPPoolSyncManager(): IPPoolSyncManager {
    return this.ipPoolSyncManager
  }

  /**
   * 获取WebSocket处理器实例
   */
  public getWebSocketHandler(): WebSocketHandler {
    return this.websocketHandler
  }

  /**
   * 获取API路由处理器实例
   */
  public getAPIRoutes(): APIRoutes {
    return this.apiRoutes
  }
}
