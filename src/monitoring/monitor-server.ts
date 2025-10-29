/**
 * 监控服务器
 * 提供HTTP API、WebSocket、统计导出等功能
 */

import * as http from 'http'
import * as fs from 'fs'
import * as path from 'path'
import { WebSocketServer } from 'ws'
import { EventEmitter } from 'events'
import { ServerConfig, WsMessage, WsResponse, StatsExportResponse } from '../types/index.js'
import { createLogger } from '../utils/logger.js'
import { RpcServer } from '../core/rpc-server.js'

const logger = createLogger('MonitorServer')

export class MonitorServer extends EventEmitter {
  private httpServer: http.Server
  private wsServer: WebSocketServer | null = null
  private isRunning = false
  private statsInterval: NodeJS.Timeout | null = null
  private metricsLogStream: fs.WriteStream | null = null
  private metricsLogPath: string
  private metricsInterval: NodeJS.Timeout | null = null

  constructor(
    private config: ServerConfig,
    private rpcServer: RpcServer,
    private getConfigCb?: () => ServerConfig,
    private updateConfigCb?: (path: string, value: any) => Promise<void> | void
  ) {
    super()
    this.metricsLogPath = path.join(process.cwd(), 'logs', 'metrics.log')
    this.httpServer = http.createServer((req, res) => {
      this.handleHttpRequest(req, res)
    })
  }

  /**
   * 启动监控服务器
   */
  public async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('监控服务器已在运行')
      return
    }

    return new Promise((resolve, reject) => {
      this.httpServer.listen(this.config.server.monitor.port, () => {
        this.isRunning = true

        // 启动WebSocket服务器
        this.wsServer = new WebSocketServer({ server: this.httpServer })
        this.setupWebSocketHandlers()

        // 启动统计推送
        this.startStatsPushing()

        // 启动指标日志记录
        this.startMetricsLogging()

        logger.info('监控服务器已启动', {
          port: this.config.server.monitor.port,
          metricsLog: this.metricsLogPath
        })

        this.emit('started')
        resolve()
      })

      this.httpServer.on('error', reject)
    })
  }

  /**
   * 停止监控服务器
   */
  public async stop(): Promise<void> {
    if (!this.isRunning) {
      return
    }

    return new Promise((resolve) => {
      // 停止统计推送
      if (this.statsInterval) {
        clearInterval(this.statsInterval)
        this.statsInterval = null
      }

      // 关闭指标日志流
      if (this.metricsLogStream) {
        this.metricsLogStream.end()
        this.metricsLogStream = null
      }

      // 停止指标记录定时器
      if (this.metricsInterval) {
        clearInterval(this.metricsInterval)
        this.metricsInterval = null
      }

      // 关闭WebSocket服务器
      if (this.wsServer) {
        this.wsServer.close()
        this.wsServer = null
      }

      // 关闭HTTP服务器
      this.httpServer.close(() => {
        this.isRunning = false
        logger.info('监控服务器已停止')
        this.emit('stopped')
        resolve()
      })
    })
  }

  /**
   * 处理HTTP请求
   */
  private handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url || '', `http://${req.headers.host}`)
    const method = req.method || 'GET'

    // 设置CORS头
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Webhook-Secret, X-Secret')

    if (method === 'OPTIONS') {
      res.writeHead(200)
      res.end()
      return
    }

    try {
      switch (url.pathname) {
        case '/api/stats':
          this.serveStats(req, res)
          break
        case '/api/ipv6':
          this.serveIPv6Stats(req, res)
          break
        case '/api/stats/export':
          this.serveStatsExport(req, res)
          break
        case '/api/config':
          this.serveConfig(req, res)
          break
        case '/api/fetch':
          this.serveFetch(req, res)
          break
        case '/api/errorLogs':
          this.serveErrorLogs(req, res)
          break
        case '/api/ip-pool':
          this.serveIPPool(req, res)
          break
        case '/':
          this.serveIndex(req, res)
          break
        default:
          this.serve404(req, res)
      }
    } catch (error) {
      logger.error('处理HTTP请求失败', error as Error, {
        method,
        url: url.pathname
      })
      this.serve500(req, res, error as Error)
    }
  }

  /**
   * 提供统计信息
   */
  private serveStats(req: http.IncomingMessage, res: http.ServerResponse): void {
    try {
      const stats = this.rpcServer.getStats()
      const response = {
        version: '2.3.27',
        timestamp: Date.now(),
        ...stats
      }

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(response, null, 2))
    } catch (error) {
      logger.error('获取统计数据失败', error as Error)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: '获取统计数据失败' }))
    }
  }

  /**
   * 提供IPv6统计信息
   */
  private serveIPv6Stats(req: http.IncomingMessage, res: http.ServerResponse): void {
    try {
      const stats = this.rpcServer.getStats()
      const ipv6Stats = stats.ipv6Stats

      const response = {
        timestamp: Date.now(),
        total: ipv6Stats.total,
        items: [] // 这里应该包含详细的IPv6地址信息
      }

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(response, null, 2))
    } catch (error) {
      logger.error('获取IPv6统计失败', error as Error)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: '获取IPv6统计失败' }))
    }
  }

  /**
   * 提供统计导出
   */
  private serveStatsExport(req: http.IncomingMessage, res: http.ServerResponse): void {
    try {
      const url = new URL(req.url || '', `http://${req.headers.host}`)
      const limit = parseInt(url.searchParams.get('limit') || '1000')
      const maxLimit = 100000

      if (limit > maxLimit) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: `限制不能超过 ${maxLimit}` }))
        return
      }

      // 读取指标日志文件
      if (!fs.existsSync(this.metricsLogPath)) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: '指标日志文件不存在' }))
        return
      }

      const logContent = fs.readFileSync(this.metricsLogPath, 'utf-8')
      const lines = logContent.trim().split('\n').slice(-limit)

      const items = lines.map(line => {
        try {
          const data = JSON.parse(line)
          return {
            ts: data.timestamp || Date.now(),
            stats: data
          }
        } catch {
          return null
        }
      }).filter(item => item !== null)

      const response: StatsExportResponse = { items }

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(response, null, 2))
    } catch (error) {
      logger.error('导出统计失败', error as Error)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: '导出统计失败' }))
    }
  }

  /**
   * 提供配置管理
   */
  private serveConfig(req: http.IncomingMessage, res: http.ServerResponse): void {
    const method = req.method || 'GET'

    if (method === 'GET') {
      this.handleGetConfig(req, res)
    } else if (method === 'POST') {
      this.handleUpdateConfig(req, res)
    } else {
      res.writeHead(405, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Method not allowed' }))
    }
  }

  /**
   * 处理获取配置
   */
  private handleGetConfig(req: http.IncomingMessage, res: http.ServerResponse): void {
    // 验证认证
    if (!this.verifyAuth(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Unauthorized' }))
      return
    }

    try {
      const config = this.getConfigCb ? this.getConfigCb() : this.config
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(config, null, 2))
    } catch (error) {
      logger.error('获取配置失败', error as Error)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: '获取配置失败' }))
    }
  }

  /**
   * 处理更新配置
   */
  private handleUpdateConfig(req: http.IncomingMessage, res: http.ServerResponse): void {
    // 验证认证
    if (!this.verifyAuth(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Unauthorized' }))
      return
    }

    let body = ''
    req.on('data', chunk => {
      body += chunk.toString()
    })

    req.on('end', () => {
      try {
        const data = JSON.parse(body)

        // 处理配置更新
        if (data.path && data.value !== undefined) {
          // 单条更新
          this.updateConfigValue(data.path, data.value)
        } else if (data.updates && Array.isArray(data.updates)) {
          // 批量更新
          for (const update of data.updates) {
            if (update.path && update.value !== undefined) {
              this.updateConfigValue(update.path, update.value)
            }
          }
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Invalid request format' }))
          return
        }

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: true }))
      } catch (error) {
        logger.error('更新配置失败', error as Error)
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Invalid JSON body' }))
      }
    })
  }

  /**
   * 验证认证
   */
  private verifyAuth(req: http.IncomingMessage): boolean {
    const secret = req.headers['x-webhook-secret'] || req.headers['x-secret']
    return secret === this.config.server.webhook.secret
  }

  /**
   * 更新配置值
   */
  private updateConfigValue(path: string, value: any): void {
    try {
      if (this.updateConfigCb) {
        const maybePromise = this.updateConfigCb(path, value)
        if (maybePromise && typeof (maybePromise as Promise<void>).then === 'function') {
          ; (maybePromise as Promise<void>).catch(err => {
            logger.error('配置更新失败', err as Error, { path })
          })
        }
      }
      logger.info('配置已更新', { path, value })
      this.emit('config-updated', { path, value })
    } catch (error) {
      logger.error('配置更新异常', error as Error, { path })
    }
  }

  /**
   * 提供获取接口
   */
  private serveFetch(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url || '', `http://${req.headers.host}`)
    const uri = url.searchParams.get('uri')

    if (!uri) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Missing uri parameter' }))
      return
    }

    // 这里应该调用RPC服务器获取数据
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ message: 'Fetch endpoint - not implemented' }))
  }

  /**
   * 提供错误日志
   */
  private serveErrorLogs(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Error logs endpoint - not implemented' }))
  }

  /**
   * 提供IP池信息
   */
  private serveIPPool(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'IP pool endpoint - not implemented' }))
  }

  /**
   * 提供首页
   */
  private serveIndex(req: http.IncomingMessage, res: http.ServerResponse): void {
    const html = this.getHTMLContent()
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(html)
  }

  /**
   * 404错误
   */
  private serve404(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Not found' }))
  }

  /**
   * 500错误
   */
  private serve500(req: http.IncomingMessage, res: http.ServerResponse, error: Error): void {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: error.message }))
  }

  /**
   * 设置WebSocket处理器
   */
  private setupWebSocketHandlers(): void {
    if (!this.wsServer) return

    this.wsServer.on('connection', (ws) => {
      logger.info('WebSocket客户端已连接')

      ws.on('message', (data) => {
        try {
          const message: WsMessage = JSON.parse(data.toString())
          this.handleWebSocketMessage(ws, message)
        } catch (error) {
          logger.error('解析WebSocket消息失败', error as Error)
        }
      })

      ws.on('close', () => {
        logger.info('WebSocket客户端已断开')
      })

      ws.on('error', (error) => {
        logger.error('WebSocket错误', error)
      })
    })
  }

  /**
   * 处理WebSocket消息
   */
  private handleWebSocketMessage(ws: any, message: WsMessage): void {
    const response: WsResponse = {
      type: 'response',
      id: message.id,
      data: { message: 'WebSocket message handling - not implemented' }
    }

    ws.send(JSON.stringify(response))
  }

  /**
   * 启动统计推送
   */
  private startStatsPushing(): void {
    this.statsInterval = setInterval(() => {
      if (this.wsServer) {
        const stats = this.rpcServer.getStats()
        const response: WsResponse = {
          type: 'stats',
          data: stats
        }

        this.wsServer.clients.forEach(client => {
          if (client.readyState === 1) { // WebSocket.OPEN
            client.send(JSON.stringify(response))
          }
        })
      }
    }, this.config.server.monitor.statsInterval)
  }

  /**
   * 启动指标日志记录
   */
  private startMetricsLogging(): void {
    // 确保日志目录存在
    const logDir = path.dirname(this.metricsLogPath)
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true })
    }

    // 创建日志流
    this.metricsLogStream = fs.createWriteStream(this.metricsLogPath, { flags: 'a' })

    // 定期记录指标
    this.metricsInterval = setInterval(() => {
      if (this.metricsLogStream) {
        const stats = this.rpcServer.getStats()
        const logEntry = {
          timestamp: Date.now(),
          ...stats
        }
        this.metricsLogStream.write(JSON.stringify(logEntry) + '\n')
      }
    }, 60000) // 每分钟记录一次
  }

  /**
   * 获取HTML内容
   */
  private getHTMLContent(): string {
    return `
<!DOCTYPE html>
<html>
<head>
    <title>ZeroMaps RPC 监控</title>
    <meta charset="utf-8">
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; }
        .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; }
        .stat-card { border: 1px solid #ddd; padding: 15px; border-radius: 5px; }
        .stat-title { font-weight: bold; margin-bottom: 10px; }
        .stat-value { font-size: 24px; color: #333; }
        .stat-label { font-size: 14px; color: #666; }
    </style>
</head>
<body>
    <h1>ZeroMaps RPC 监控面板</h1>
    <div class="stats" id="stats">
        <div class="stat-card">
            <div class="stat-title">客户端连接</div>
            <div class="stat-value" id="clients">-</div>
        </div>
        <div class="stat-card">
            <div class="stat-title">当前并发</div>
            <div class="stat-value" id="concurrency">-</div>
        </div>
        <div class="stat-card">
            <div class="stat-title">成功率</div>
            <div class="stat-value" id="successRate">-</div>
        </div>
        <div class="stat-card">
            <div class="stat-title">平均响应时间</div>
            <div class="stat-value" id="avgResponseTime">-</div>
        </div>
    </div>

    <script>
        function updateStats() {
            fetch('/api/stats')
                .then(response => response.json())
                .then(data => {
                    document.getElementById('clients').textContent = data.totalClients || 0;
                    document.getElementById('concurrency').textContent = data.dynamicConcurrency?.current || 0;
                    document.getElementById('successRate').textContent = 
                        Math.round((data.dynamicConcurrency?.performance?.successRate || 0) * 100) + '%';
                    document.getElementById('avgResponseTime').textContent = 
                        Math.round(data.dynamicConcurrency?.performance?.avgResponseTime || 0) + 'ms';
                })
                .catch(error => console.error('获取统计数据失败:', error));
        }

        // 初始加载
        updateStats();
        
        // 每5秒更新一次
        setInterval(updateStats, 5000);
    </script>
</body>
</html>
    `
  }

  /**
   * 检查是否运行中
   */
  public isServerRunning(): boolean {
    return this.isRunning
  }

  /**
   * 销毁服务器
   */
  public destroy(): void {
    this.stop().then(() => {
      logger.info('监控服务器已销毁')
    })
  }
}
