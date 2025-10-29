/**
 * Web监控服务器
 * 提供HTTP接口、WebSocket接口和Web界面查看服务器运行状态
 */

import * as http from 'http'
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import WebSocket, { WebSocketServer } from 'ws'
import { RpcServer } from './rpc-server.js'
import { createLogger } from './logger.js'
import { getConfig } from './config-manager.js'
import { NodeManager } from './node-manager.js'
import { IPPoolSyncManager } from './ip-pool-sync.js'

const logger = createLogger('MonitorServer')

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

interface WsMessage {
  type: 'fetch' | 'ping' | 'request_ip_pool' | 'update_ip_pool'
  id?: string
  uri?: string
  data?: any
}

interface WsResponse {
  type: 'response' | 'error' | 'pong' | 'stats' | 'ip_pool_data' | 'ip_pool_updated'
  id?: string
  data?: any
  error?: string
}

export class MonitorServer {
  private server: http.Server | null = null
  private wss: WebSocketServer | null = null
  private rpcServer: RpcServer
  private nodeManager: NodeManager
  private ipPoolSyncManager: IPPoolSyncManager
  private metricsInterval: NodeJS.Timeout | null = null
  private metricsFilePath: string = path.join(process.cwd(), 'logs', 'metrics.log')
  private activeWSConnections = new Set<WebSocket>()
  private readonly maxWSConnections = 100 // WebSocket 最大并发连接数

  constructor(
    private port: number,
    rpcServer: RpcServer
  ) {
    this.rpcServer = rpcServer
    this.nodeManager = new NodeManager()
    this.ipPoolSyncManager = new IPPoolSyncManager()
  }

  /**
   * 实时读取版本号（每次调用时读取，确保获取最新版本）
   */
  private getVersion(): string {
    try {
      // 方法1：从 dist/server 向上两级到项目根目录
      let packagePath = path.join(__dirname, '../../package.json')

      // 方法2：如果方法1失败，尝试绝对路径
      if (!fs.existsSync(packagePath)) {
        packagePath = '/opt/zeromaps-rpc/package.json'
        logger.debug('使用绝对路径读取版本号', { path: packagePath })
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
    this.wss = new WebSocketServer({ server: this.server })

    // 定时持久化统计数据（每60秒写一次）
    if (!this.metricsInterval) {
      this.metricsInterval = setInterval(async () => {
        try {
          const stats = await this.rpcServer.getStats()
          const record = JSON.stringify({ ts: Date.now(), stats }) + '\n'
          fs.appendFile(this.metricsFilePath, record, () => { })
        } catch { }
      }, 60000)
    }

    // 处理 WebSocket 连接
    this.wss.on('connection', (ws: WebSocket, req) => {
      const clientIP = req.socket.remoteAddress

      // 检查连接数限制
      if (this.activeWSConnections.size >= this.maxWSConnections) {
        logger.warn('WebSocket 连接数已达上限，拒绝新连接', {
          current: this.activeWSConnections.size,
          max: this.maxWSConnections,
          clientIP
        })
        ws.close(1008, 'Too many connections')
        return
      }

      // 添加到活跃连接集合
      this.activeWSConnections.add(ws)
      logger.info('WebSocket 客户端连接', {
        clientIP,
        activeConnections: this.activeWSConnections.size
      })

      // 定时推送统计数据（每秒一次）
      const statsInterval = setInterval(async () => {
        if (ws.readyState === WebSocket.OPEN) {
          const stats = await this.rpcServer.getStats()
          const ipv6Pool = this.rpcServer.getIPv6Pool()
          const detailedStats = ipv6Pool.getDetailedStats()

          // 转换成和 HTTP API 一致的格式
          const statsResponse: WsResponse = {
            type: 'stats',
            data: {
              version: this.getVersion(),
              timestamp: Date.now(),
              clients: stats.totalClients,
              fetcherType: stats.fetcherType,
              requests: {
                total: stats.fetcherStats.totalRequests,
                concurrent: stats.fetcherStats.concurrentRequests,
                maxConcurrent: stats.fetcherStats.maxConcurrent,
                currentConcurrency: stats.fetcherStats.currentConcurrency,
                queueLength: stats.fetcherStats.queueLength || 0
              },
              concurrency: {
                enabled: stats.dynamicConcurrency?.enabled || false,
                current: stats.dynamicConcurrency?.currentConcurrency || 0,
                adaptive: stats.dynamicConcurrency?.adaptiveConcurrency || false,
                keepAlive: stats.dynamicConcurrency?.keepAliveEnabled || false,
                performance: stats.dynamicConcurrency?.performanceMetrics || null
              },
              ipv6: {
                total: detailedStats.totalAddresses,
                totalRequests: detailedStats.totalRequests,
                avgPerIP: detailedStats.averagePerIP,
                balance: detailedStats.balance,
                successRate: parseFloat(detailedStats.successRate),
                totalSuccess: detailedStats.totalSuccess,
                totalFailure: detailedStats.totalFailure,
                avgResponseTime: detailedStats.avgResponseTime,
                uptime: detailedStats.uptime,
                qps: parseFloat(detailedStats.requestsPerSecond),
                hasIPv6: detailedStats.hasIPv6
              },
              system: stats.system,
              health: stats.health,
              utlsHealth: stats.utlsHealth,
              emergencyStop: stats.emergencyStop,
              emergencyStopReason: stats.emergencyStopReason
            }
          }
          ws.send(JSON.stringify(statsResponse))
        }
      }, 1000)

      // 监听请求日志事件
      const requestLogHandler = (log: any) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'requestLog',
            data: log
          }))
        }
      }
      this.rpcServer.on('requestLog', requestLogHandler)

      // 监听错误日志事件
      const errorLogHandler = (log: any) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'errorLog',
            data: log
          }))
        }
      }
      this.rpcServer.on('errorLog', errorLogHandler)

      // 处理消息
      ws.on('message', async (data: Buffer) => {
        try {
          const msg: WsMessage = JSON.parse(data.toString())

          // Ping-Pong 心跳
          if (msg.type === 'ping') {
            const response: WsResponse = { type: 'pong' }
            ws.send(JSON.stringify(response))
            return
          }

          // IP 池同步：请求 IP 池
          if (msg.type === 'request_ip_pool') {
            const ipPoolPath = '/opt/zeromaps-rpc/utls-proxy/ip-pools.json'
            try {
              const ipPoolData = await fs.promises.readFile(ipPoolPath, 'utf-8')
              const response: WsResponse = {
                type: 'ip_pool_data',
                data: JSON.parse(ipPoolData)
              }
              ws.send(JSON.stringify(response))
              logger.info('发送 IP 池数据到节点', { clientIP })
            } catch (error) {
              logger.error('读取 IP 池文件失败', error as Error)
            }
            return
          }

          // IP 池同步：接收 IP 池更新
          if (msg.type === 'update_ip_pool' && msg.data) {
            const ipPoolPath = '/opt/zeromaps-rpc/utls-proxy/ip-pools.json'
            try {
              await fs.promises.writeFile(ipPoolPath, JSON.stringify(msg.data, null, 2), 'utf-8')
              logger.info('收到 IP 池更新并已保存', { clientIP })

              // 通知 uTLS 代理重新加载（可以通过 HTTP 端点触发）
              const response: WsResponse = { type: 'ip_pool_updated' }
              ws.send(JSON.stringify(response))
            } catch (error) {
              logger.error('保存 IP 池文件失败', error as Error)
            }
            return
          }

          // 数据请求
          if (msg.type === 'fetch' && msg.uri && msg.id) {
            logger.debug('[WS] 收到请求', {
              uri: msg.uri.substring(0, 80),
              id: msg.id
            })

            try {
              const t1 = Date.now()

              // 构建完整 URL
              const url = `https://kh.google.com/rt/earth/${msg.uri}`

              // 通过 Fetcher 获取数据
              const fetcher = this.rpcServer.getFetcher()
              const result = await fetcher.fetch({ url, timeout: 10000 })

              const duration = Date.now() - t1
              logger.debug('[WS] 请求完成', {
                duration,
                statusCode: result.statusCode,
                size: result.body.length
              })

              const response: WsResponse = {
                type: 'response',
                id: msg.id,
                data: {
                  statusCode: result.statusCode,
                  data: Array.from(result.body),  // curlFetcher 返回 body 字段
                  headers: result.headers
                }
              }

              ws.send(JSON.stringify(response))
            } catch (error) {
              logger.error('[WS] 请求失败', error as Error)

              const response: WsResponse = {
                type: 'error',
                id: msg.id,
                error: (error as Error).message
              }
              ws.send(JSON.stringify(response))
            }
          }
        } catch (error) {
          logger.error('处理 WebSocket 消息失败', error as Error)
        }
      })

      ws.on('close', () => {
        // 从活跃连接集合中移除
        this.activeWSConnections.delete(ws)
        logger.info('WebSocket 客户端断开', {
          clientIP,
          activeConnections: this.activeWSConnections.size
        })
        clearInterval(statsInterval)  // 清理统计推送定时器
        this.rpcServer.off('requestLog', requestLogHandler)  // 移除请求日志监听器
        this.rpcServer.off('errorLog', errorLogHandler)  // 移除错误日志监听器
      })

      ws.on('error', (error) => {
        logger.error('WebSocket 错误', error)
      })
    })

    this.server.listen(this.port, () => {
      logger.info('监控服务器启动', {
        port: this.port,
        httpApi: `http://0.0.0.0:${this.port}/api/*`,
        websocket: `ws://0.0.0.0:${this.port}/ws`
      })
    })
  }

  /**
   * 处理HTTP请求
   */
  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = req.url || '/'

    if (url === '/' || url === '/index.html') {
      this.serveHTML(res)
    } else if (url === '/management' || url === '/management.html') {
      this.serveManagementHTML(res)
    } else if (url === '/api/stats') {
      await this.serveStats(res)
    } else if (url === '/api/ipv6') {
      this.serveIPv6(res)
    } else if (url.startsWith('/api/errorLogs')) {
      this.serveErrorLogs(res)
    } else if (url.startsWith('/api/logs')) {
      await this.serveLogs(req, res)
    } else if (url.startsWith('/api/stats/export')) {
      await this.serveStatsExport(req, res)
    } else if (url.startsWith('/api/config')) {
      await this.serveConfig(req, res)
    } else if (url.startsWith('/api/service')) {
      await this.serveServiceControl(req, res)
    } else if (url.startsWith('/api/nodes')) {
      await this.serveNodeManagement(req, res)
    } else if (url.startsWith('/api/ip-pool')) {
      await this.serveIPPoolSync(req, res)
    } else if (url.startsWith('/ws')) {
      this.handleWebSocket(req, res)
    } else {
      res.writeHead(404)
      res.end('Not Found')
    }
  }

  /**
   * 当 HTTP 请求访问 /ws 时，提示使用 WebSocket 协议
   */
  private handleWebSocket(_req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(426, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Please connect via WebSocket protocol: ws://host:port/ws' }))
  }

  /**
   * 返回 IP 池数据
   */
  private async serveIPPool(res: http.ServerResponse): Promise<void> {
    try {
      const ipPoolPath = '/opt/zeromaps-rpc/utls-proxy/ip-pools.json'
      const ipPoolData = await fs.promises.readFile(ipPoolPath, 'utf-8')

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      })
      res.end(ipPoolData)
    } catch (error) {
      logger.error('读取 IP 池文件失败', error as Error)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: '读取 IP 池文件失败' }))
    }
  }

  /**
   * 返回HTML监控页面
   */
  private serveHTML(res: http.ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(this.getHTMLContent())
  }

  /**
   * 返回统计数据JSON
   */
  private async serveStats(res: http.ServerResponse): Promise<void> {
    const stats = await this.rpcServer.getStats()
    const ipv6Pool = this.rpcServer.getIPv6Pool()
    const detailedStats = ipv6Pool.getDetailedStats()

    const data = {
      version: this.getVersion(),  // 实时读取本节点版本号
      timestamp: Date.now(),
      clients: stats.totalClients,
      fetcherType: stats.fetcherType,
      requests: {
        total: stats.fetcherStats.totalRequests,
        concurrent: stats.fetcherStats.concurrentRequests,
        maxConcurrent: stats.fetcherStats.maxConcurrent,
        currentConcurrency: stats.fetcherStats.currentConcurrency,
        queueLength: stats.fetcherStats.queueLength || 0
      },
      concurrency: {
        enabled: stats.dynamicConcurrency?.enabled || false,
        current: stats.dynamicConcurrency?.currentConcurrency || 0,
        adaptive: stats.dynamicConcurrency?.adaptiveConcurrency || false,
        keepAlive: stats.dynamicConcurrency?.keepAliveEnabled || false,
        performance: stats.dynamicConcurrency?.performanceMetrics || null
      },
      ipv6: {
        total: detailedStats.totalAddresses,
        totalRequests: detailedStats.totalRequests,
        avgPerIP: detailedStats.averagePerIP,
        balance: detailedStats.balance,
        successRate: parseFloat(detailedStats.successRate),
        totalSuccess: detailedStats.totalSuccess,
        totalFailure: detailedStats.totalFailure,
        avgResponseTime: detailedStats.avgResponseTime,
        uptime: detailedStats.uptime,
        qps: parseFloat(detailedStats.requestsPerSecond),
        hasIPv6: detailedStats.hasIPv6  // 标识是否有 IPv6
      },
      system: stats.system,
      health: stats.health,
      utlsHealth: stats.utlsHealth,
      emergencyStop: stats.emergencyStop,
      emergencyStopReason: stats.emergencyStopReason
    }

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(data, null, 2))
  }

  /**
   * 返回每个IPv6的详细统计
   */
  private serveIPv6(res: http.ServerResponse): void {
    const ipv6Pool = this.rpcServer.getIPv6Pool()
    const perIPStats = ipv6Pool.getPerIPStats()

    // 只返回前100个，避免数据量过大
    const data = {
      timestamp: Date.now(),
      total: perIPStats.length,
      items: perIPStats.slice(0, 100).map(stat => ({
        address: stat.address,
        requests: stat.totalRequests,
        success: stat.successCount,
        failure: stat.failureCount,
        successRate: parseFloat(stat.successRate),
        avgRT: stat.avgResponseTime,
        lastUsed: stat.lastUsedAgo
      }))
    }

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(data, null, 2))
  }

  /**
   * 返回错误日志
   */
  private serveErrorLogs(res: http.ServerResponse): void {
    const errorLogs = this.rpcServer.getErrorLogs()

    const data = {
      timestamp: Date.now(),
      total: errorLogs.length,
      logs: errorLogs
    }

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(data, null, 2))
  }

  /**
   * 导出历史统计：支持查询字符串 ?limit=1000
   */
  private async serveStatsExport(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url || '', 'http://localhost')
      const limitParam = parseInt(url.searchParams.get('limit') || '1000')
      const limit = Math.max(1, Math.min(100000, isNaN(limitParam) ? 1000 : limitParam))

      if (!fs.existsSync(this.metricsFilePath)) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ items: [] }))
        return
      }

      // 高效倒序读取最后 N 行（简单实现：读取全部后切片，文件小场景足够）
      const content = fs.readFileSync(this.metricsFilePath, 'utf-8')
      const lines = content.trim().split('\n')
      const last = lines.slice(-limit)
      const items = last.map(line => {
        try { return JSON.parse(line) } catch { return null }
      }).filter(Boolean)

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ items }))
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (error as Error).message }))
    }
  }

  /**
   * 配置管理接口（鉴权：使用 server.webhook.secret）
   * GET  /api/config        → 返回完整配置
   * POST /api/config        → body: { path, value } | { updates: [{ path, value }] }
   */
  private async serveConfig(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const config = getConfig()
      const secret = config.get<string>('server.webhook.secret')
      const headerSecret = String((req.headers['x-webhook-secret'] || req.headers['x-secret'] || '')).trim()

      if (!secret || headerSecret !== secret) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Unauthorized' }))
        return
      }

      if (req.method === 'GET') {
        const all = config.getAll()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(all, null, 2))
        return
      }

      if (req.method === 'POST') {
        const body = await new Promise<string>((resolve) => {
          let data = ''
          req.on('data', chunk => { data += chunk })
          req.on('end', () => resolve(data))
        })

        let payload: any
        try {
          payload = body ? JSON.parse(body) : {}
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Invalid JSON body' }))
          return
        }

        const updates: Array<{ path: string, value: any }> = Array.isArray(payload?.updates)
          ? payload.updates
          : (payload?.path !== undefined ? [{ path: payload.path, value: payload.value }] : [])

        if (updates.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'No updates provided' }))
          return
        }

        // 依次应用更新（每次会做校验）
        for (const u of updates) {
          if (!u.path) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'Invalid update item: missing path' }))
            return
          }
          await config.set(u.path, u.value)
        }

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: true }))
        return
      }

      res.writeHead(405, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Method Not Allowed' }))
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (error as Error).message }))
    }
  }

  /**
   * 处理数据获取请求（浏览器直连 API）
   */
  private async serveFetch(req: http.IncomingMessage, res: http.ServerResponse, url: string): Promise<void> {
    try {
      // 解析 URI 参数
      const urlObj = new URL(url, 'http://localhost')
      const uri = urlObj.searchParams.get('uri')

      if (!uri) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Missing uri parameter' }))
        return
      }

      // 构建完整 URL
      const fullUrl = `https://kh.google.com/rt/earth/${uri}`

      // 使用 Fetcher 获取数据
      const fetcher = this.rpcServer.getFetcher()
      const result = await fetcher.fetch({
        url: fullUrl,
        timeout: 10000
      })

      // 处理错误情况
      if (result.statusCode === 0 || result.error) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: result.error || 'Request failed' }))
        return
      }

      // 返回数据
      res.writeHead(result.statusCode, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': result.body.length
      })
      res.end(result.body)

    } catch (error) {
      logger.error('[HTTP API] 错误', error as Error)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (error as Error).message }))
    }
  }

  /**
   * 获取HTML页面内容
   */
  private getHTMLContent(): string {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ZeroMaps RPC 监控</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: #333;
      padding: 20px;
    }
    .container {
      max-width: 1400px;
      margin: 0 auto;
    }
    h1 {
      color: white;
      text-align: center;
      margin-bottom: 30px;
      font-size: 2.5em;
      text-shadow: 2px 2px 4px rgba(0,0,0,0.3);
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      gap: 20px;
      margin-bottom: 30px;
    }
    .card {
      background: white;
      border-radius: 12px;
      padding: 25px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.2);
      transition: transform 0.3s;
    }
    .card:hover {
      transform: translateY(-5px);
    }
    .card-title {
      font-size: 0.9em;
      color: #666;
      margin-bottom: 10px;
      text-transform: uppercase;
      letter-spacing: 1px;
    }
    .card-value {
      font-size: 2.5em;
      font-weight: bold;
      color: #667eea;
    }
    .card-subtitle {
      font-size: 0.85em;
      color: #999;
      margin-top: 5px;
    }
    .table-container {
      background: white;
      border-radius: 12px;
      padding: 25px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.2);
      overflow-x: auto;
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th {
      background: #667eea;
      color: white;
      padding: 12px;
      text-align: left;
      font-weight: 600;
    }
    td {
      padding: 12px;
      border-bottom: 1px solid #eee;
    }
    tr:hover {
      background: #f8f9fa;
    }
    .status {
      display: inline-block;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      margin-right: 8px;
    }
    .status.active { background: #10b981; animation: pulse 2s infinite; }
    .status.warning { background: #f59e0b; }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }
    .metric-good { color: #10b981; font-weight: bold; }
    .metric-warning { color: #f59e0b; font-weight: bold; }
    .metric-bad { color: #ef4444; font-weight: bold; }
    .refresh-info {
      text-align: center;
      color: white;
      margin-top: 20px;
      font-size: 0.9em;
    }
    .chart {
      height: 60px;
      display: flex;
      align-items: flex-end;
      gap: 2px;
      margin-top: 15px;
    }
    .chart-bar {
      flex: 1;
      background: linear-gradient(to top, #667eea, #764ba2);
      border-radius: 2px 2px 0 0;
      transition: height 0.3s;
    }
    .logs-container {
      background: white;
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 20px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.2);
      max-height: 500px;
      overflow-y: auto;
    }
    .logs-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 15px;
      padding-bottom: 10px;
      border-bottom: 2px solid #f0f0f0;
    }
    .logs-title {
      font-size: 1.3em;
      font-weight: bold;
      color: #667eea;
    }
    .log-item {
      padding: 10px;
      margin-bottom: 8px;
      border-radius: 6px;
      font-family: 'Monaco', 'Courier New', monospace;
      font-size: 0.85em;
      border-left: 3px solid #667eea;
      background: #f8f9fa;
    }
    .log-item.success {
      border-left-color: #10b981;
      background: #ecfdf5;
    }
    .log-item.error {
      border-left-color: #ef4444;
      background: #fef2f2;
    }
    .log-main {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 5px;
    }
    .log-url {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .log-metrics {
      display: flex;
      gap: 10px;
      align-items: center;
    }
    .log-badge {
      padding: 2px 8px;
      border-radius: 4px;
      font-weight: bold;
      font-size: 0.85em;
    }
    .log-badge.success {
      background: #10b981;
      color: white;
    }
    .log-badge.error {
      background: #ef4444;
      color: white;
    }
    .log-detail {
      font-size: 0.8em;
      color: #666;
    }
    .clear-btn {
      padding: 5px 15px;
      border-radius: 6px;
      border: none;
      background: #667eea;
      color: white;
      cursor: pointer;
      font-size: 0.9em;
    }
    .clear-btn:hover {
      background: #5568d3;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>🚀 ZeroMaps RPC 监控面板</h1>
    
    <!-- 健康状态横幅 -->
    <div id="healthBanner" style="margin-bottom: 20px; padding: 15px; border-radius: 8px; text-align: center; font-size: 1.1em; font-weight: bold;">
      检测中...
    </div>
    
    <div class="grid">
      <div class="card">
        <div class="card-title">在线客户端</div>
        <div class="card-value" id="clients">-</div>
        <div class="card-subtitle"><span class="status active"></span>实时连接</div>
      </div>
      
      <div class="card">
        <div class="card-title">总请求数</div>
        <div class="card-value" id="totalRequests">-</div>
        <div class="card-subtitle">累计处理</div>
      </div>
      
      <div class="card">
        <div class="card-title">当前并发</div>
        <div class="card-value" id="concurrent">-</div>
        <div class="card-subtitle">最大: <span id="maxConcurrent">-</span></div>
      </div>
      
      <div class="card">
        <div class="card-title">并发配置</div>
        <div class="card-value" id="currentConcurrency">-</div>
        <div class="card-subtitle">自适应: <span id="adaptiveConcurrency">-</span></div>
      </div>
      
      <div class="card">
        <div class="card-title">连接池</div>
        <div class="card-value" id="keepAliveStatus">-</div>
        <div class="card-subtitle">性能: <span id="avgResponseTime">-</span>ms</div>
      </div>
      
      <div class="card">
        <div class="card-title">请求速率</div>
        <div class="card-value" id="qps">-</div>
        <div class="card-subtitle">req/s</div>
      </div>
      
      <div class="card">
        <div class="card-title">成功率</div>
        <div class="card-value" id="successRate">-</div>
        <div class="card-subtitle">成功: <span id="success">-</span> | 失败: <span id="failure">-</span></div>
      </div>
      
      <div class="card">
        <div class="card-title">平均响应时间</div>
        <div class="card-value" id="avgRT">-</div>
        <div class="card-subtitle">毫秒</div>
      </div>
      
      <div class="card">
        <div class="card-title">IPv6 地址池</div>
        <div class="card-value" id="ipv6Total">-</div>
        <div class="card-subtitle">平均每IP: <span id="avgPerIP">-</span> 次</div>
      </div>
      
      <div class="card">
        <div class="card-title">负载平衡度</div>
        <div class="card-value" id="balance">-</div>
        <div class="card-subtitle">差值越小越均衡</div>
      </div>
    </div>

    <div class="logs-container">
      <div class="logs-header">
        <div class="logs-title">❌ 错误日志（仅显示失败请求）</div>
        <button class="clear-btn" onclick="clearErrorLogs()">清空</button>
      </div>
      <div id="errorLogsContent">
        <div style="text-align: center; color: #999; padding: 20px;">暂无错误...</div>
      </div>
    </div>

    <div class="logs-container">
      <div class="logs-header">
        <div class="logs-title">📋 实时请求日志（所有请求）</div>
        <button class="clear-btn" onclick="clearLogs()">清空</button>
      </div>
      <div id="logsContent">
        <div style="text-align: center; color: #999; padding: 20px;">等待请求...</div>
      </div>
    </div>

    <div class="table-container">
      <h2 style="margin-bottom: 20px;">📊 Top 20 IPv6 地址使用情况</h2>
      <table>
        <thead>
          <tr>
            <th>IPv6地址</th>
            <th>请求数</th>
            <th>成功</th>
            <th>失败</th>
            <th>成功率</th>
            <th>平均RT</th>
            <th>最后使用</th>
          </tr>
        </thead>
        <tbody id="ipv6Table">
          <tr><td colspan="7" style="text-align: center;">加载中...</td></tr>
        </tbody>
      </table>
    </div>

    <div class="refresh-info">
      📡 自动刷新中... | 上次更新: <span id="lastUpdate">-</span>
    </div>
  </div>

  <script>
    function formatNumber(num) {
      return num.toLocaleString('zh-CN');
    }

    function formatSuccessRate(rate) {
      if (rate >= 99) return '<span class="metric-good">' + rate.toFixed(2) + '%</span>';
      if (rate >= 95) return '<span class="metric-warning">' + rate.toFixed(2) + '%</span>';
      return '<span class="metric-bad">' + rate.toFixed(2) + '%</span>';
    }

    function formatUptime(seconds) {
      const hours = Math.floor(seconds / 3600);
      const mins = Math.floor((seconds % 3600) / 60);
      if (hours > 0) return hours + '小时' + mins + '分钟';
      if (mins > 0) return mins + '分钟';
      return seconds + '秒';
    }

    async function fetchStats() {
      try {
        const [statsRes, ipv6Res] = await Promise.all([
          fetch('/api/stats'),
          fetch('/api/ipv6')
        ]);

        const stats = await statsRes.json();
        const ipv6Data = await ipv6Res.json();

        // 更新健康状态横幅
        const healthBanner = document.getElementById('healthBanner');
        if (stats.health) {
          const status = stats.health.status;
          const message = stats.health.message;
          const lastCheck = new Date(stats.health.lastCheck).toLocaleTimeString('zh-CN');
          
          if (status === 200) {
            healthBanner.style.background = '#10b981';
            healthBanner.style.color = 'white';
            healthBanner.innerHTML = '✅ 节点状态: ' + message + ' (上次检测: ' + lastCheck + ')';
          } else if (status === 403) {
            healthBanner.style.background = '#ef4444';
            healthBanner.style.color = 'white';
            healthBanner.innerHTML = '❌ 节点被拉黑: ' + message + ' (上次检测: ' + lastCheck + ')';
          } else if (status === 429) {
            healthBanner.style.background = '#f59e0b';
            healthBanner.style.color = 'white';
            healthBanner.innerHTML = '⚠️ 限流警告: ' + message + ' (上次检测: ' + lastCheck + ')';
          } else if (status === 500) {
            healthBanner.style.background = '#f59e0b';
            healthBanner.style.color = 'white';
            healthBanner.innerHTML = '⚠️ 部分可用: ' + message + ' (上次检测: ' + lastCheck + ')';
          } else if (status === 0) {
            healthBanner.style.background = '#ef4444';
            healthBanner.style.color = 'white';
            healthBanner.innerHTML = '❌ 健康检查失败: ' + message + ' (上次检测: ' + lastCheck + ')';
          } else {
            healthBanner.style.background = '#f59e0b';
            healthBanner.style.color = 'white';
            healthBanner.innerHTML = '⚠️ 异常状态: ' + message + ' (上次检测: ' + lastCheck + ')';
          }
        }

        // 更新基本统计
        document.getElementById('clients').textContent = stats.clients;
        document.getElementById('totalRequests').textContent = formatNumber(stats.requests.total);
        document.getElementById('concurrent').textContent = stats.requests.concurrent;
        document.getElementById('maxConcurrent').textContent = stats.requests.maxConcurrent;
        document.getElementById('qps').textContent = stats.ipv6.qps.toFixed(2);
        document.getElementById('successRate').innerHTML = formatSuccessRate(stats.ipv6.successRate);
        document.getElementById('success').textContent = formatNumber(stats.ipv6.totalSuccess);
        document.getElementById('failure').textContent = formatNumber(stats.ipv6.totalFailure);
        document.getElementById('avgRT').textContent = stats.ipv6.avgResponseTime + 'ms';
        
        // 更新并发配置信息
        if (stats.concurrency) {
          document.getElementById('currentConcurrency').textContent = stats.concurrency.current || '-';
          document.getElementById('adaptiveConcurrency').textContent = stats.concurrency.adaptive ? '启用' : '禁用';
          document.getElementById('keepAliveStatus').textContent = stats.concurrency.keepAlive ? '启用' : '禁用';
          
          if (stats.concurrency.performance && stats.concurrency.performance.avgResponseTime) {
            document.getElementById('avgResponseTime').textContent = stats.concurrency.performance.avgResponseTime;
          } else {
            document.getElementById('avgResponseTime').textContent = '-';
          }
        }
        
        // 根据是否有 IPv6 显示不同内容
        if (stats.ipv6.hasIPv6) {
          document.getElementById('ipv6Total').textContent = formatNumber(stats.ipv6.total);
          document.getElementById('avgPerIP').textContent = formatNumber(stats.ipv6.avgPerIP);
          document.getElementById('balance').textContent = stats.ipv6.balance;
        } else {
          document.getElementById('ipv6Total').textContent = '未启用';
          document.getElementById('avgPerIP').textContent = 'N/A';
          document.getElementById('balance').textContent = 'N/A';
        }

        // 更新IPv6表格（按请求数排序）
        const tbody = document.getElementById('ipv6Table');
        if (!stats.ipv6.hasIPv6 || ipv6Data.items.length === 0) {
          tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: #999;">未启用 IPv6 地址池</td></tr>';
        } else {
          const sorted = ipv6Data.items.sort((a, b) => b.requests - a.requests).slice(0, 20);
          tbody.innerHTML = sorted.map(item => \`
          <tr>
            <td><code>\${item.address.substring(0, 30)}...</code></td>
            <td>\${formatNumber(item.requests)}</td>
            <td>\${formatNumber(item.success)}</td>
            <td>\${item.failure}</td>
            <td>\${formatSuccessRate(item.successRate)}</td>
            <td>\${item.avgRT}ms</td>
            <td>\${item.lastUsed}</td>
          </tr>
        \`).join('');
        }

        // 更新时间
        document.getElementById('lastUpdate').textContent = new Date().toLocaleTimeString('zh-CN');
      } catch (error) {
        console.error('获取统计数据失败:', error);
      }
    }

    // 初始加载
    fetchStats();

    // 每3秒自动刷新
    setInterval(fetchStats, 3000);

    // WebSocket 连接，接收实时请求日志
    const requestLogs = [];
    const errorLogs = [];
    const maxLogs = 50;
    const maxErrorLogs = 30;

    function connectWebSocket() {
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(\`\${protocol}//\${location.host}/ws\`);

      ws.onopen = () => {
        console.log('✓ WebSocket 已连接');
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'requestLog') {
            addRequestLog(msg.data);
          } else if (msg.type === 'errorLog') {
            addErrorLog(msg.data);
          }
        } catch (e) {
          console.error('解析消息失败:', e);
        }
      };

      ws.onerror = (error) => {
        console.error('WebSocket 错误:', error);
      };

      ws.onclose = () => {
        console.log('✗ WebSocket 断开，5秒后重连...');
        setTimeout(connectWebSocket, 5000);
      };
    }

    function addRequestLog(log) {
      requestLogs.unshift(log);
      if (requestLogs.length > maxLogs) {
        requestLogs.pop();
      }
      renderLogs();
    }

    function renderLogs() {
      const logsContent = document.getElementById('logsContent');
      if (requestLogs.length === 0) {
        logsContent.innerHTML = '<div style="text-align: center; color: #999; padding: 20px;">暂无请求</div>';
        return;
      }

      function formatBytes(bytes) {
        if (!bytes) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
      }

      logsContent.innerHTML = requestLogs.map(log => {
        const className = log.success ? 'success' : 'error';
        const badgeClass = log.success ? 'success' : 'error';
        const statusText = log.statusCode || 'ERR';
        const time = new Date(log.timestamp).toLocaleTimeString('zh-CN', { hour12: false });
        
        let urlDisplay = log.url || '';
        try {
          const url = new URL(log.url);
          urlDisplay = url.pathname.substring(0, 100);
        } catch (e) {
          urlDisplay = log.url.substring(0, 100);
        }

        return \`<div class="log-item \${className}">
          <div class="log-main">
            <div class="log-url" title="\${log.url}">\${urlDisplay}</div>
            <div class="log-metrics">
              <span class="log-badge \${badgeClass}">\${statusText}</span>
              <span style="color: #667eea; font-weight: bold;">\${log.duration}ms</span>
              <span style="color: #666;">\${formatBytes(log.size)}</span>
              <span style="color: #999;">\${time}</span>
            </div>
          </div>
          <div class="log-detail">
            IPv6: \${log.ipv6 || 'N/A'} | 模式: \${log.requestMode === 'ip-pool' ? 'IP池' : log.requestMode === 'domain' ? '域名' : 'N/A'} | IP: \${log.usedIP || 'N/A'} | 等待: \${log.waitTime || 0}ms | 执行: \${log.duration || log.curlTime || 0}ms
            \${log.error ? ' | 错误: ' + log.error : ''}
          </div>
        </div>\`;
      }).join('');
    }

    function addErrorLog(log) {
      errorLogs.unshift(log);
      if (errorLogs.length > maxErrorLogs) {
        errorLogs.pop();
      }
      renderErrorLogs();
    }

    function renderErrorLogs() {
      const errorLogsContent = document.getElementById('errorLogsContent');
      if (errorLogs.length === 0) {
        errorLogsContent.innerHTML = '<div style="text-align: center; color: #999; padding: 20px;">暂无错误</div>';
        return;
      }

      function formatBytes(bytes) {
        if (!bytes) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
      }

      errorLogsContent.innerHTML = errorLogs.map(log => {
        const statusText = log.statusCode || 'ERR';
        const statusColor = log.statusCode >= 500 ? '#dc2626' : log.statusCode >= 400 ? '#ea580c' : '#ef4444';
        const timestamp = new Date(log.timestamp).toLocaleTimeString('zh-CN');
        const errorMsg = log.error || '请求失败';

        return \`
          <div class="log-item error">
            <div class="log-main">
              <div class="log-url" title="\${log.url}">\${log.url}</div>
              <div class="log-metrics">
                <span class="log-badge error" style="background: \${statusColor}">\${statusText}</span>
                <span class="log-badge" style="background: #64748b; color: white;">\${log.duration || 0}ms</span>
              </div>
            </div>
            <div class="log-detail">
              ❌ 错误: \${errorMsg} | IPv6: \${log.ipv6 || 'N/A'} | 模式: \${log.requestMode === 'ip-pool' ? 'IP池' : log.requestMode === 'domain' ? '域名' : 'N/A'} | IP: \${log.usedIP || 'N/A'} | 时间: \${timestamp}
            </div>
          </div>
        \`;
      }).join('');
    }

    function clearLogs() {
      requestLogs.length = 0;
      renderLogs();
    }

    function clearErrorLogs() {
      errorLogs.length = 0;
      renderErrorLogs();
    }

    // 连接 WebSocket
    connectWebSocket();
  </script>
</body>
</html>`;
  }

  /**
   * 实时日志查看 API
   * GET /api/logs?lines=100&level=info
   */
  private async serveLogs(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url || '', 'http://localhost')
      const linesParam = parseInt(url.searchParams.get('lines') || '100')
      const level = url.searchParams.get('level') || 'all'
      const lines = Math.max(1, Math.min(10000, isNaN(linesParam) ? 100 : linesParam))

      const logPath = path.join(process.cwd(), 'logs', 'combined.log')

      if (!fs.existsSync(logPath)) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ lines: [] }))
        return
      }

      const content = fs.readFileSync(logPath, 'utf-8')
      const allLines = content.trim().split('\n')
      const last = allLines.slice(-lines)

      // 解析并过滤日志
      const logs = last.map(line => {
        try {
          return JSON.parse(line)
        } catch {
          return { message: line, level: 'unknown' }
        }
      }).filter(log => level === 'all' || log.level === level)

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ lines: logs }))
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (error as Error).message }))
    }
  }

  /**
   * 服务控制 API（重启、停止等）
   * POST /api/service/restart
   * POST /api/service/reload-config
   */
  private async serveServiceControl(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const config = getConfig()
      const secret = config.get<string>('server.webhook.secret')
      const headerSecret = String((req.headers['x-webhook-secret'] || req.headers['x-secret'] || '')).trim()

      if (!secret || headerSecret !== secret) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Unauthorized' }))
        return
      }

      const url = req.url || ''

      if (req.method === 'POST' && url.includes('/restart')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          success: true,
          message: '服务重启命令已接收，请使用 PM2 或系统服务管理器重启'
        }))

        // 注意：实际重启需要外部进程管理器（如 PM2）
        // 这里只是触发配置重新加载
        logger.info('收到重启请求，重新加载配置')
        config.reload()
        return
      }

      if (req.method === 'POST' && url.includes('/reload-config')) {
        logger.info('收到配置重新加载请求')
        config.reload()

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: true, message: '配置已重新加载' }))
        return
      }

      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Unknown service action' }))
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (error as Error).message }))
    }
  }

  /**
   * 返回管理界面 HTML
   */
  private serveManagementHTML(res: http.ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(this.getManagementHTMLContent())
  }

  /**
   * 获取管理界面 HTML 内容（将在下一步实现）
   */
  private getManagementHTMLContent(): string {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ZeroMaps RPC 管理面板</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
      background: #f5f5f5;
      color: #333;
    }
    .header {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 20px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    .header h1 {
      font-size: 24px;
      margin-bottom: 10px;
    }
    .header p {
      opacity: 0.9;
      font-size: 14px;
    }
    .container {
      max-width: 1400px;
      margin: 0 auto;
      padding: 20px;
    }
    .tabs {
      display: flex;
      gap: 10px;
      margin-bottom: 20px;
      background: white;
      padding: 10px;
      border-radius: 8px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    .tab {
      padding: 10px 20px;
      border: none;
      background: transparent;
      cursor: pointer;
      border-radius: 4px;
      font-size: 14px;
      transition: all 0.3s;
    }
    .tab:hover {
      background: #f0f0f0;
    }
    .tab.active {
      background: #667eea;
      color: white;
    }
    .tab-content {
      display: none;
    }
    .tab-content.active {
      display: block;
    }
    .card {
      background: white;
      border-radius: 8px;
      padding: 20px;
      margin-bottom: 20px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    .card-title {
      font-size: 18px;
      font-weight: bold;
      margin-bottom: 15px;
      padding-bottom: 10px;
      border-bottom: 2px solid #f0f0f0;
    }
    .form-group {
      margin-bottom: 15px;
    }
    .form-group label {
      display: block;
      margin-bottom: 5px;
      font-weight: 500;
      font-size: 14px;
    }
    .form-group input, .form-group select, .form-group textarea {
      width: 100%;
      padding: 8px 12px;
      border: 1px solid #ddd;
      border-radius: 4px;
      font-size: 14px;
    }
    .form-group textarea {
      min-height: 100px;
      font-family: 'Courier New', monospace;
    }
    .btn {
      padding: 10px 20px;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 14px;
      transition: all 0.3s;
    }
    .btn-primary {
      background: #667eea;
      color: white;
    }
    .btn-primary:hover {
      background: #5568d3;
    }
    .btn-success {
      background: #10b981;
      color: white;
    }
    .btn-success:hover {
      background: #059669;
    }
    .btn-danger {
      background: #ef4444;
      color: white;
    }
    .btn-danger:hover {
      background: #dc2626;
    }
    
    /* 节点管理样式 */
    .nodes-stats {
      display: flex;
      gap: 20px;
      margin-bottom: 20px;
      padding: 15px;
      background: #f8f9fa;
      border-radius: 8px;
    }
    .stat-item {
      text-align: center;
    }
    .stat-value {
      font-size: 24px;
      font-weight: bold;
      color: #667eea;
    }
    .stat-label {
      font-size: 12px;
      color: #666;
    }
    
    .nodes-table-container {
      overflow-x: auto;
      margin-bottom: 20px;
    }
    
    .nodes-table {
      width: 100%;
      border-collapse: collapse;
      background: white;
      border-radius: 8px;
      overflow: hidden;
    }
    
    .nodes-table th,
    .nodes-table td {
      padding: 12px;
      text-align: left;
      border-bottom: 1px solid #eee;
    }
    
    .nodes-table th {
      background: #f8f9fa;
      font-weight: 600;
      color: #333;
    }
    
    .nodes-table tr:hover {
      background: #f8f9fa;
    }
    
    .status-online {
      color: #27ae60;
      font-weight: bold;
    }
    
    .status-offline {
      color: #e74c3c;
      font-weight: bold;
    }
    
    .status-unknown {
      color: #f39c12;
      font-weight: bold;
    }
    
    .health-healthy {
      color: #27ae60;
    }
    
    .health-degraded {
      color: #f39c12;
    }
    
    .health-unhealthy {
      color: #e74c3c;
    }
    
    .health-offline {
      color: #95a5a6;
    }
    
    .enabled-true {
      color: #27ae60;
    }
    
    .enabled-false {
      color: #e74c3c;
    }
    
    .node-actions {
      display: flex;
      gap: 5px;
    }
    
    .btn-small {
      padding: 4px 8px;
      font-size: 12px;
      border: none;
      border-radius: 4px;
      cursor: pointer;
    }
    
    .btn-toggle {
      background: #3498db;
      color: white;
    }
    
    .btn-delete {
      background: #e74c3c;
      color: white;
    }
    
    /* 模态框样式 */
    .modal {
      position: fixed;
      z-index: 1000;
      left: 0;
      top: 0;
      width: 100%;
      height: 100%;
      background-color: rgba(0,0,0,0.5);
    }
    
    .modal-content {
      background-color: white;
      margin: 5% auto;
      padding: 20px;
      border-radius: 8px;
      width: 80%;
      max-width: 600px;
      max-height: 80vh;
      overflow-y: auto;
    }
    
    .close {
      color: #aaa;
      float: right;
      font-size: 28px;
      font-weight: bold;
      cursor: pointer;
    }
    
    .close:hover {
      color: #000;
    }
    
    .form-actions {
      margin-top: 20px;
      text-align: right;
    }
    
    .form-actions button {
      margin-left: 10px;
    }
    
    /* IP池同步样式 */
    .ippool-stats {
      display: flex;
      gap: 20px;
      margin-bottom: 20px;
      padding: 15px;
      background: #f8f9fa;
      border-radius: 8px;
    }
    
    .ippool-controls {
      margin-bottom: 20px;
      display: flex;
      gap: 10px;
    }
    
    .ippool-table-container {
      overflow-x: auto;
      margin-bottom: 20px;
    }
    
    .ippool-table {
      width: 100%;
      border-collapse: collapse;
      background: white;
      border-radius: 8px;
      overflow: hidden;
    }
    
    .ippool-table th,
    .ippool-table td {
      padding: 12px;
      text-align: left;
      border-bottom: 1px solid #eee;
    }
    
    .ippool-table th {
      background: #f8f9fa;
      font-weight: 600;
      color: #333;
    }
    
    .ippool-table tr:hover {
      background: #f8f9fa;
    }
    
    /* 健康检查样式 */
    .health-check-stats {
      background: #e8f5e8;
      padding: 15px;
      border-radius: 5px;
      margin-bottom: 20px;
      border-left: 4px solid #28a745;
    }
    
    .health-status-container {
      margin-bottom: 20px;
    }
    
    .health-status-table {
      width: 100%;
      border-collapse: collapse;
      background: white;
    }
    
    .health-status-table th,
    .health-status-table td {
      padding: 10px;
      text-align: left;
      border-bottom: 1px solid #ddd;
      font-size: 12px;
    }
    
    .health-status-table th {
      background-color: #f8f9fa;
      font-weight: bold;
    }
    
    .health-status-table tr:hover {
      background-color: #f5f5f5;
    }
    
    .status-active {
      color: #28a745;
      font-weight: bold;
    }
    
    .status-blacklisted {
      color: #dc3545;
      font-weight: bold;
    }
    
    .status-testing {
      color: #ffc107;
      font-weight: bold;
    }
    
    .health-action-btn {
      padding: 4px 8px;
      margin: 2px;
      font-size: 11px;
      border: none;
      border-radius: 3px;
      cursor: pointer;
    }
    
    .health-action-btn.test {
      background: #17a2b8;
      color: white;
    }
    
    .health-action-btn.activate {
      background: #28a745;
      color: white;
    }
    
    .health-action-btn.blacklist {
      background: #dc3545;
      color: white;
    }
    
    .health-action-btn.clear {
      background: #6c757d;
      color: white;
    }
    
    .ippool-sync-log {
      margin-top: 20px;
      padding: 15px;
      background: #f8f9fa;
      border-radius: 8px;
    }
    
    .log-content {
      max-height: 200px;
      overflow-y: auto;
      background: white;
      padding: 10px;
      border-radius: 4px;
      font-family: monospace;
      font-size: 12px;
    }
    
    .log-entry {
      margin-bottom: 5px;
      padding: 2px 0;
    }
    
    .log-entry.success {
      color: #27ae60;
    }
    
    .log-entry.error {
      color: #e74c3c;
    }
    
    .log-entry.info {
      color: #3498db;
    }
    .alert {
      padding: 12px 16px;
      border-radius: 4px;
      margin-bottom: 15px;
      font-size: 14px;
    }
    .alert-success {
      background: #d1fae5;
      color: #065f46;
      border-left: 4px solid #10b981;
    }
    .alert-error {
      background: #fee2e2;
      color: #991b1b;
      border-left: 4px solid #ef4444;
    }
    .log-viewer {
      background: #1e1e1e;
      color: #d4d4d4;
      padding: 15px;
      border-radius: 4px;
      font-family: 'Courier New', monospace;
      font-size: 12px;
      max-height: 500px;
      overflow-y: auto;
    }
    .log-line {
      margin-bottom: 5px;
      white-space: pre-wrap;
      word-wrap: break-word;
    }
    .log-line.info { color: #4fc3f7; }
    .log-line.warn { color: #ffa726; }
    .log-line.error { color: #ef5350; }
    .config-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      gap: 15px;
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>🎛️ ZeroMaps RPC 管理面板</h1>
    <p>配置管理 · 日志查看 · 服务控制</p>
  </div>
  
  <div class="container">
    <div class="tabs">
      <button class="tab active" onclick="switchTab('config')">⚙️ 配置管理</button>
      <button class="tab" onclick="switchTab('logs')">📝 日志查看</button>
      <button class="tab" onclick="switchTab('service')">🔧 服务控制</button>
      <button class="tab" onclick="switchTab('nodes')">🌐 节点管理</button>
      <button class="tab" onclick="switchTab('ippool')">🌍 IP池同步</button>
    </div>
    
    <!-- 配置管理 -->
    <div id="config" class="tab-content active">
      <div class="card">
        <div class="card-title">
          常用配置 
          <button class="btn btn-success" onclick="loadCurrentConfig()" style="float: right;">刷新当前值</button>
        </div>
        <div id="configAlert"></div>
        <div class="config-grid" id="configGrid">
          <!-- 动态加载配置项 -->
        </div>
      </div>
      
      <div class="card">
        <div class="card-title">高级配置（JSON编辑）</div>
        <div class="form-group">
          <label>配置路径（点点分隔）</label>
          <input type="text" id="configPath" placeholder="例如: utls.concurrency 或 ipv6.healthCheck.maxError403Count">
        </div>
        <div class="form-group">
          <label>配置值（JSON格式）</label>
          <textarea id="configValue" placeholder="输入 JSON 格式的值，如: 30 或 true 或 [1,2,3]"></textarea>
        </div>
        <button class="btn btn-primary" onclick="updateCustomConfig()">更新自定义配置</button>
        <button class="btn btn-success" onclick="showFullConfig()">查看完整配置（JSON）</button>
      </div>
    </div>
    
    <!-- 日志查看 -->
    <div id="logs" class="tab-content">
      <div class="card">
        <div class="card-title">实时日志 <button class="btn btn-success" onclick="refreshLogs()">刷新</button></div>
        <div class="form-group">
          <label>日志级别</label>
          <select id="logLevel" onchange="refreshLogs()">
            <option value="all">全部</option>
            <option value="info">INFO</option>
            <option value="warn">WARN</option>
            <option value="error">ERROR</option>
          </select>
        </div>
        <div class="log-viewer" id="logViewer">
          <div class="log-line">加载中...</div>
        </div>
      </div>
    </div>
    
    <!-- 服务控制 -->
    <div id="service" class="tab-content">
      <div class="card">
        <div class="card-title">服务操作</div>
        <div id="serviceAlert"></div>
        <p style="margin-bottom: 15px;">执行服务控制操作需要鉴权密钥</p>
        <div class="form-group">
          <label>密钥 (X-Secret)</label>
          <input type="password" id="serviceSecret" placeholder="输入 webhook secret">
        </div>
        <button class="btn btn-success" onclick="reloadConfig()">重新加载配置</button>
        <button class="btn btn-danger" onclick="restartService()">重启服务 (需要PM2)</button>
      </div>
    </div>
    
    <!-- 节点管理 -->
    <div id="nodes" class="tab-content">
      <div class="card">
        <div class="card-title">
          节点管理
          <button class="btn btn-success" onclick="refreshNodes()" style="float: right;">刷新</button>
        </div>
        <div id="nodesAlert"></div>
        
        <div class="nodes-stats" id="nodesStats"></div>
        
        <div class="nodes-table-container">
          <table class="nodes-table">
            <thead>
              <tr>
                <th>节点名称</th>
                <th>域名</th>
                <th>IPv4</th>
                <th>状态</th>
                <th>健康状态</th>
                <th>响应时间</th>
                <th>启用状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody id="nodesTableBody">
            </tbody>
          </table>
        </div>
        
        <div style="margin-top: 20px;">
          <button class="btn btn-primary" onclick="showAddNodeForm()">添加新节点</button>
        </div>
      </div>
    </div>
    
    <!-- 添加节点表单 -->
    <div id="addNodeModal" class="modal" style="display: none;">
      <div class="modal-content">
        <span class="close" onclick="hideAddNodeForm()">&times;</span>
        <h3>添加新节点</h3>
        <form id="addNodeForm">
          <div class="form-group">
            <label>节点名称:</label>
            <input type="text" id="nodeName" required>
          </div>
          <div class="form-group">
            <label>域名:</label>
            <input type="text" id="nodeDomain" required placeholder="example.com">
          </div>
          <div class="form-group">
            <label>IPv4地址:</label>
            <input type="text" id="nodeIPv4" placeholder="192.168.1.1">
          </div>
          <div class="form-group">
            <label>IPv6前缀:</label>
            <input type="text" id="nodeIPv6Prefix" placeholder="2607:8700:5500:2043">
          </div>
          <div class="form-group">
            <label>位置:</label>
            <input type="text" id="nodeLocation" placeholder="US">
          </div>
          <div class="form-group">
            <label>描述:</label>
            <textarea id="nodeDescription" placeholder="节点描述"></textarea>
          </div>
          <div class="form-group">
            <label>RPC端口:</label>
            <input type="number" id="nodeRpcPort" value="9527">
          </div>
          <div class="form-group">
            <label>监控端口:</label>
            <input type="number" id="nodeMonitorPort" value="9528">
          </div>
          <div class="form-actions">
            <button type="button" onclick="hideAddNodeForm()">取消</button>
            <button type="submit">添加节点</button>
          </div>
        </form>
      </div>
    </div>
    
    <!-- IP池同步管理 -->
    <div id="ippool" class="tab-content">
      <div class="card">
        <div class="card-title">
          IP池同步管理
          <button class="btn btn-success" onclick="refreshIPPoolData()" style="float: right;">刷新</button>
        </div>
        <div id="ippoolAlert"></div>
        
        <div class="ippool-stats" id="ippoolStats"></div>
        
        <div class="health-check-stats" id="healthCheckStats" style="display: none;">
          <h4>健康检查统计</h4>
          <div id="healthStatsContent"></div>
        </div>
        
        <div class="ippool-controls">
          <button class="btn btn-primary" onclick="triggerIPPoolSync()">手动同步</button>
          <button class="btn btn-secondary" onclick="exportIPPoolData()">导出数据</button>
          <button class="btn btn-info" onclick="showIPPoolDetails()">查看详情</button>
          <button class="btn btn-success" onclick="startHealthCheck()">启动健康检查</button>
          <button class="btn btn-warning" onclick="stopHealthCheck()">停止健康检查</button>
          <button class="btn btn-danger" onclick="refreshHealthStatus()">刷新健康状态</button>
        </div>
        
        <div class="ippool-table-container">
          <table class="ippool-table">
            <thead>
              <tr>
                <th>域名</th>
                <th>IPv4数量</th>
                <th>IPv6数量</th>
                <th>黑名单</th>
                <th>偏好IPv6</th>
                <th>最后更新</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody id="ippoolTableBody">
            </tbody>
          </table>
        </div>
        
        <div class="health-status-container" id="healthStatusContainer" style="display: none;">
          <h4>IP健康状态</h4>
          <table class="health-status-table">
            <thead>
              <tr>
                <th>IP地址</th>
                <th>域名</th>
                <th>状态</th>
                <th>成功率</th>
                <th>平均响应时间</th>
                <th>总测试次数</th>
                <th>最后测试</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody id="healthStatusTableBody">
            </tbody>
          </table>
        </div>
        
        <div class="ippool-sync-log" id="ippoolSyncLog">
          <h4>同步日志</h4>
          <div id="syncLogContent" class="log-content"></div>
        </div>
      </div>
    </div>
    
    <!-- IP池详情模态框 -->
    <div id="ippoolDetailsModal" class="modal" style="display: none;">
      <div class="modal-content">
        <span class="close" onclick="hideIPPoolDetails()">&times;</span>
        <h3>IP池详情</h3>
        <div id="ippoolDetailsContent"></div>
      </div>
    </div>
  </div>
  
  <script>
    let currentConfig = null;
    let savedSecret = localStorage.getItem('zeromaps-secret') || '';
    
    // 配置项定义（名称、路径、类型、说明）
    const configItems = [
      { name: '并发数', path: 'utls.concurrency', type: 'number', min: 1, max: 300, desc: '推荐20-50，过高易被封' },
      { name: 'Keep-Alive', path: 'utls.enableKeepAlive', type: 'boolean', desc: 'HTTP连接复用，提高效率' },
      { name: 'UTLSFetcher自适应', path: 'utls.enableAdaptiveConcurrency', type: 'boolean', desc: '默认禁用，由RpcServer统一管理' },
      { name: '最大并发数', path: 'utls.adaptiveConcurrency.maxConcurrency', type: 'number', min: 10, max: 1000, desc: 'RpcServer动态调节上限' },
      { name: '最小并发数', path: 'utls.adaptiveConcurrency.minConcurrency', type: 'number', min: 1, max: 100, desc: 'RpcServer动态调节下限' },
      { name: '最小响应大小', path: 'dataValidation.minResponseSize', type: 'number', min: 0, max: 10000, desc: '数据验证阈值(字节)' },
      { name: '最大403错误数', path: 'ipv6.healthCheck.maxError403Count', type: 'number', min: 1, max: 100, desc: 'IPv6被拉黑阈值' },
      { name: '失败率阈值', path: 'ipv6.healthCheck.failureRateThreshold', type: 'number', min: 0, max: 1, step: 0.1, desc: 'IPv6健康检查失败率' },
      { name: '响应时间阈值', path: 'ipv6.healthCheck.responseTimeThreshold', type: 'number', min: 100, max: 10000, desc: 'IPv6响应时间上限(ms)' },
      { name: '日志级别', path: 'logging.level', type: 'select', options: ['debug', 'info', 'warn', 'error'], desc: '日志详细程度' },
      { name: '健康检查间隔', path: 'performance.healthCheckInterval', type: 'number', min: 10000, max: 600000, desc: '健康检查间隔(ms)' }
    ];
    
    function switchTab(tabName) {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
      event.target.classList.add('active');
      document.getElementById(tabName).classList.add('active');
      
      if (tabName === 'logs') refreshLogs();
      if (tabName === 'config') loadCurrentConfig();
      if (tabName === 'nodes') refreshNodes();
      if (tabName === 'ippool') {
        refreshIPPoolData();
        refreshHealthStatus();
      }
    }
    
    function showAlert(elementId, message, type) {
      const alertDiv = document.getElementById(elementId);
      alertDiv.innerHTML = \`<div class="alert alert-\${type}">\${message}</div>\`;
      setTimeout(() => alertDiv.innerHTML = '', 5000);
    }
    
    function getValueByPath(obj, path) {
      return path.split('.').reduce((o, key) => o?.[key], obj);
    }
    
    async function loadCurrentConfig() {
      const secret = savedSecret || prompt('输入密钥（留空使用已保存密钥）:');
      if (secret) savedSecret = secret;
      localStorage.setItem('zeromaps-secret', savedSecret);
      
      try {
        const res = await fetch('/api/config', {
          headers: { 'X-Secret': savedSecret }
        });
        
        if (!res.ok) {
          showAlert('configAlert', '获取配置失败: 请检查密钥', 'error');
          savedSecret = '';
          localStorage.removeItem('zeromaps-secret');
          return;
        }
        
        currentConfig = await res.json();
        renderConfigItems();
        showAlert('configAlert', '配置已加载', 'success');
      } catch (error) {
        showAlert('configAlert', '加载失败: ' + error.message, 'error');
      }
    }
    
    function renderConfigItems() {
      const grid = document.getElementById('configGrid');
      grid.innerHTML = configItems.map(item => {
        const currentValue = getValueByPath(currentConfig, item.path);
        const valueStr = currentValue !== undefined ? currentValue : '未设置';
        
        let inputHTML = '';
        if (item.type === 'number') {
          inputHTML = \`<input type="number" id="cfg-\${item.path}" value="\${currentValue || ''}" 
            min="\${item.min || 0}" max="\${item.max || 999999}" step="\${item.step || 1}">\`;
        } else if (item.type === 'boolean') {
          inputHTML = \`<select id="cfg-\${item.path}">
            <option value="true" \${currentValue === true ? 'selected' : ''}>启用</option>
            <option value="false" \${currentValue === false ? 'selected' : ''}>禁用</option>
          </select>\`;
        } else if (item.type === 'select') {
          inputHTML = \`<select id="cfg-\${item.path}">
            \${item.options.map(opt => 
              \`<option value="\${opt}" \${currentValue === opt ? 'selected' : ''}>\${opt}</option>\`
            ).join('')}
          </select>\`;
        }
        
        return \`
          <div class="form-group">
            <label>\${item.name} <span style="color: #999; font-size: 12px;">(当前: \${valueStr})</span></label>
            <small style="display: block; color: #666; margin-bottom: 5px;">\${item.desc}</small>
            \${inputHTML}
            <button class="btn btn-primary" onclick="updateConfigItem('\${item.path}', '\${item.type}')" 
              style="margin-top: 5px; width: 100%;">更新</button>
          </div>
        \`;
      }).join('');
    }
    
    async function updateConfigItem(path, type) {
      const input = document.getElementById('cfg-' + path);
      let value = input.value;
      
      if (type === 'number') {
        value = parseFloat(value);
        if (isNaN(value)) {
          showAlert('configAlert', '请输入有效的数字', 'error');
          return;
        }
      } else if (type === 'boolean') {
        value = value === 'true';
      }
      
      try {
        const res = await fetch('/api/config', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Secret': savedSecret
          },
          body: JSON.stringify({ path, value })
        });
        
        const data = await res.json();
        if (res.ok) {
          showAlert('configAlert', \`✅ \${path} 更新成功\`, 'success');
          // 重新加载配置
          setTimeout(loadCurrentConfig, 1000);
        } else {
          showAlert('configAlert', '更新失败: ' + data.error, 'error');
        }
      } catch (error) {
        showAlert('configAlert', '请求失败: ' + error.message, 'error');
      }
    }
    
    async function updateCustomConfig() {
      const path = document.getElementById('configPath').value;
      const value = document.getElementById('configValue').value;
      
      if (!path || !value) {
        showAlert('configAlert', '请填写配置路径和值', 'error');
        return;
      }
      
      try {
        let parsedValue;
        try {
          parsedValue = JSON.parse(value);
        } catch {
          parsedValue = value;
        }
        
        const res = await fetch('/api/config', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Secret': savedSecret
          },
          body: JSON.stringify({ path, value: parsedValue })
        });
        
        const data = await res.json();
        if (res.ok) {
          showAlert('configAlert', '配置更新成功', 'success');
          setTimeout(loadCurrentConfig, 1000);
        } else {
          showAlert('configAlert', '更新失败: ' + data.error, 'error');
        }
      } catch (error) {
        showAlert('configAlert', '请求失败: ' + error.message, 'error');
      }
    }
    
    async function showFullConfig() {
      if (!currentConfig) {
        await loadCurrentConfig();
      }
      document.getElementById('configValue').value = JSON.stringify(currentConfig, null, 2);
      showAlert('configAlert', '完整配置已显示在下方', 'success');
    }
    
    async function refreshLogs() {
      const level = document.getElementById('logLevel').value;
      try {
        const res = await fetch(\`/api/logs?lines=200&level=\${level}\`);
        const data = await res.json();
        const viewer = document.getElementById('logViewer');
        
        if (data.lines.length === 0) {
          viewer.innerHTML = '<div class="log-line">暂无日志</div>';
          return;
        }
        
        viewer.innerHTML = data.lines.map(log => {
          const levelClass = log.level || 'info';
          const time = log.timestamp ? new Date(log.timestamp).toLocaleTimeString() : '';
          return \`<div class="log-line \${levelClass}">[[\${time}]] [\${log.level}] \${log.message}</div>\`;
        }).join('');
        
        viewer.scrollTop = viewer.scrollHeight;
      } catch (error) {
        document.getElementById('logViewer').innerHTML = \`<div class="log-line error">加载日志失败: \${error.message}</div>\`;
      }
    }
    
    async function reloadConfig() {
      const secret = document.getElementById('serviceSecret').value;
      try {
        const res = await fetch('/api/service/reload-config', {
          method: 'POST',
          headers: { 'X-Secret': secret }
        });
        const data = await res.json();
        showAlert('serviceAlert', data.message || '配置已重新加载', 'success');
      } catch (error) {
        showAlert('serviceAlert', '操作失败: ' + error.message, 'error');
      }
    }
    
    async function restartService() {
      const secret = document.getElementById('serviceSecret').value;
      if (!confirm('确认重启服务？')) return;
      
      try {
        const res = await fetch('/api/service/restart', {
          method: 'POST',
          headers: { 'X-Secret': secret }
        });
        const data = await res.json();
        showAlert('serviceAlert', data.message, 'success');
      } catch (error) {
        showAlert('serviceAlert', '操作失败: ' + error.message, 'error');
      }
    }
    
    // 页面加载时初始化
    window.addEventListener('DOMContentLoaded', () => {
      loadCurrentConfig();
    });
    
    // 自动刷新日志
    setInterval(() => {
      if (document.getElementById('logs').classList.contains('active')) {
        refreshLogs();
      }
    }, 5000);
    
    // 节点管理功能
    let nodesData = null;
    
    async function refreshNodes() {
      try {
        const secret = savedSecret || prompt('输入密钥（留空使用已保存密钥）:');
        if (secret) savedSecret = secret;
        localStorage.setItem('zeromaps-secret', savedSecret);
        
        const res = await fetch('/api/nodes', {
          headers: { 'X-Secret': savedSecret }
        });
        
        if (!res.ok) {
          showAlert('nodesAlert', '获取节点信息失败: 请检查密钥', 'error');
          return;
        }
        
        nodesData = await res.json();
        renderNodesStats();
        renderNodesTable();
        
      } catch (error) {
        showAlert('nodesAlert', '获取节点信息失败: ' + error.message, 'error');
      }
    }
    
    function renderNodesStats() {
      if (!nodesData || !nodesData.stats) return;
      
      const stats = nodesData.stats;
      const statsHtml = \`
        <div class="stat-item">
          <div class="stat-value">\${stats.total}</div>
          <div class="stat-label">总节点</div>
        </div>
        <div class="stat-item">
          <div class="stat-value">\${stats.online}</div>
          <div class="stat-label">在线</div>
        </div>
        <div class="stat-item">
          <div class="stat-value">\${stats.offline}</div>
          <div class="stat-label">离线</div>
        </div>
        <div class="stat-item">
          <div class="stat-value">\${stats.enabled}</div>
          <div class="stat-label">启用</div>
        </div>
        <div class="stat-item">
          <div class="stat-value">\${stats.disabled}</div>
          <div class="stat-label">禁用</div>
        </div>
      \`;
      
      document.getElementById('nodesStats').innerHTML = statsHtml;
    }
    
    function renderNodesTable() {
      if (!nodesData || !nodesData.nodes) return;
      
      const tbody = document.getElementById('nodesTableBody');
      tbody.innerHTML = '';
      
      nodesData.nodes.forEach(node => {
        const health = nodesData.health.find(h => h.nodeId === node.id);
        const row = document.createElement('tr');
        
        row.innerHTML = \`
          <td>\${node.name}</td>
          <td>\${node.domain}</td>
          <td>\${node.ipv4 || 'unknown'}</td>
          <td><span class="status-\${node.status}">\${node.status}</span></td>
          <td><span class="health-\${health?.status || 'offline'}">\${health?.status || 'offline'}</span></td>
          <td>\${health?.responseTime ? health.responseTime + 'ms' : '-'}</td>
          <td><span class="enabled-\${node.enabled}">\${node.enabled ? '启用' : '禁用'}</span></td>
          <td class="node-actions">
            <button class="btn-small btn-toggle" onclick="toggleNode('\${node.id}', \${!node.enabled})">
              \${node.enabled ? '禁用' : '启用'}
            </button>
            <button class="btn-small btn-delete" onclick="deleteNode('\${node.id}')">删除</button>
          </td>
        \`;
        
        tbody.appendChild(row);
      });
    }
    
    async function toggleNode(nodeId, enabled) {
      if (!confirm(\`确认\${enabled ? '启用' : '禁用'}节点 \${nodeId}？\`)) return;
      
      try {
        const secret = savedSecret || prompt('输入密钥:');
        if (!secret) return;
        
        const res = await fetch(\`/api/nodes/\${nodeId}/toggle\`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Secret': secret
          },
          body: JSON.stringify({ enabled })
        });
        
        if (res.ok) {
          showAlert('nodesAlert', \`节点 \${nodeId} \${enabled ? '已启用' : '已禁用'}\`, 'success');
          refreshNodes();
        } else {
          const error = await res.json();
          showAlert('nodesAlert', '操作失败: ' + error.error, 'error');
        }
      } catch (error) {
        showAlert('nodesAlert', '操作失败: ' + error.message, 'error');
      }
    }
    
    async function deleteNode(nodeId) {
      if (!confirm(\`确认删除节点 \${nodeId}？此操作不可撤销！\`)) return;
      
      try {
        const secret = savedSecret || prompt('输入密钥:');
        if (!secret) return;
        
        const res = await fetch(\`/api/nodes/\${nodeId}\`, {
          method: 'DELETE',
          headers: { 'X-Secret': secret }
        });
        
        if (res.ok) {
          showAlert('nodesAlert', \`节点 \${nodeId} 已删除\`, 'success');
          refreshNodes();
        } else {
          const error = await res.json();
          showAlert('nodesAlert', '删除失败: ' + error.error, 'error');
        }
      } catch (error) {
        showAlert('nodesAlert', '删除失败: ' + error.message, 'error');
      }
    }
    
    function showAddNodeForm() {
      document.getElementById('addNodeModal').style.display = 'block';
    }
    
    function hideAddNodeForm() {
      document.getElementById('addNodeModal').style.display = 'none';
      document.getElementById('addNodeForm').reset();
    }
    
    // 添加节点表单提交
    document.getElementById('addNodeForm').addEventListener('submit', async function(e) {
      e.preventDefault();
      
      const nodeData = {
        name: document.getElementById('nodeName').value,
        domain: document.getElementById('nodeDomain').value,
        ipv4: document.getElementById('nodeIPv4').value,
        ipv6Prefix: document.getElementById('nodeIPv6Prefix').value,
        location: document.getElementById('nodeLocation').value,
        description: document.getElementById('nodeDescription').value,
        config: {
          rpcPort: parseInt(document.getElementById('nodeRpcPort').value),
          monitorPort: parseInt(document.getElementById('nodeMonitorPort').value)
        }
      };
      
      try {
        const secret = savedSecret || prompt('输入密钥:');
        if (!secret) return;
        
        const res = await fetch('/api/nodes', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Secret': secret
          },
          body: JSON.stringify(nodeData)
        });
        
        if (res.ok) {
          showAlert('nodesAlert', '节点添加成功', 'success');
          hideAddNodeForm();
          refreshNodes();
        } else {
          const error = await res.json();
          showAlert('nodesAlert', '添加失败: ' + error.error, 'error');
        }
      } catch (error) {
        showAlert('nodesAlert', '添加失败: ' + error.message, 'error');
      }
    });
    
    // 点击模态框外部关闭
    window.onclick = function(event) {
      const modal = document.getElementById('addNodeModal');
      if (event.target === modal) {
        hideAddNodeForm();
      }
    };
    
    // IP池同步功能
    let ipPoolData = null;
    let syncLog = [];
    let healthCheckStats = null;
    let healthStatuses = [];
    
    async function refreshIPPoolData() {
      try {
        const res = await fetch('/api/ip-pool/data');
        if (!res.ok) {
          showAlert('ippoolAlert', '获取IP池数据失败', 'error');
          return;
        }
        
        ipPoolData = await res.json();
        renderIPPoolStats();
        renderIPPoolTable();
        
        // 获取同步统计
        const statsRes = await fetch('/api/ip-pool/stats');
        if (statsRes.ok) {
          const stats = await statsRes.json();
          renderSyncStats(stats);
        }
        
        showAlert('ippoolAlert', 'IP池数据已刷新', 'success');
      } catch (error) {
        showAlert('ippoolAlert', '刷新失败: ' + error.message, 'error');
      }
    }
    
    async function refreshHealthStatus() {
      try {
        // 获取健康检查统计
        const statsRes = await fetch('/api/ip-pool/health/stats');
        if (statsRes.ok) {
          healthCheckStats = await statsRes.json();
          renderHealthCheckStats();
        }
        
        // 获取IP健康状态
        const statusRes = await fetch('/api/ip-pool/health/status');
        if (statusRes.ok) {
          healthStatuses = await statusRes.json();
          renderHealthStatusTable();
        }
        
        showAlert('ippoolAlert', '健康状态已刷新', 'success');
      } catch (error) {
        showAlert('ippoolAlert', '刷新健康状态失败: ' + error.message, 'error');
      }
    }
    
    async function startHealthCheck() {
      try {
        showAlert('ippoolAlert', '正在启动健康检查...', 'info');
        addSyncLog('info', '启动IP健康检查');
        
        const res = await fetch('/api/ip-pool/health/start', {
          method: 'POST'
        });
        
        if (res.ok) {
          showAlert('ippoolAlert', '健康检查已启动', 'success');
          addSyncLog('success', '健康检查启动成功');
          
          // 显示健康检查相关区域
          document.getElementById('healthCheckStats').style.display = 'block';
          document.getElementById('healthStatusContainer').style.display = 'block';
          
          // 刷新健康状态
          setTimeout(refreshHealthStatus, 1000);
        } else {
          const error = await res.json();
          showAlert('ippoolAlert', '启动失败: ' + error.message, 'error');
          addSyncLog('error', '健康检查启动失败: ' + error.message);
        }
      } catch (error) {
        showAlert('ippoolAlert', '启动失败: ' + error.message, 'error');
        addSyncLog('error', '健康检查启动异常: ' + error.message);
      }
    }
    
    async function stopHealthCheck() {
      try {
        showAlert('ippoolAlert', '正在停止健康检查...', 'info');
        addSyncLog('info', '停止IP健康检查');
        
        const res = await fetch('/api/ip-pool/health/stop', {
          method: 'POST'
        });
        
        if (res.ok) {
          showAlert('ippoolAlert', '健康检查已停止', 'success');
          addSyncLog('success', '健康检查停止成功');
        } else {
          const error = await res.json();
          showAlert('ippoolAlert', '停止失败: ' + error.message, 'error');
          addSyncLog('error', '健康检查停止失败: ' + error.message);
        }
      } catch (error) {
        showAlert('ippoolAlert', '停止失败: ' + error.message, 'error');
        addSyncLog('error', '健康检查停止异常: ' + error.message);
      }
    }
    
    async function testIPManually(ip, domain = 'kh.google.com') {
      try {
        showAlert('ippoolAlert', \`正在测试IP \${ip}...\`, 'info');
        addSyncLog('info', \`手动测试IP: \${ip} (\${domain})\`);
        
        const res = await fetch(\`/api/ip-pool/health/test/\${encodeURIComponent(ip)}?domain=\${domain}\`, {
          method: 'POST'
        });
        
        if (res.ok) {
          const result = await res.json();
          const testResult = result.result;
          
          if (testResult.success) {
            showAlert('ippoolAlert', \`IP \${ip} 测试成功 (状态码: \${testResult.statusCode}, 响应时间: \${testResult.responseTime}ms)\`, 'success');
            addSyncLog('success', \`IP \${ip} 测试成功: \${testResult.statusCode} - \${testResult.responseTime}ms\`);
          } else {
            showAlert('ippoolAlert', \`IP \${ip} 测试失败: \${testResult.error}\`, 'error');
            addSyncLog('error', \`IP \${ip} 测试失败: \${testResult.error}\`);
          }
          
          // 刷新健康状态
          setTimeout(refreshHealthStatus, 1000);
        } else {
          const error = await res.json();
          showAlert('ippoolAlert', '测试失败: ' + error.message, 'error');
          addSyncLog('error', \`IP \${ip} 测试失败: \${error.message}\`);
        }
      } catch (error) {
        showAlert('ippoolAlert', '测试失败: ' + error.message, 'error');
        addSyncLog('error', \`IP \${ip} 测试异常: \${error.message}\`);
      }
    }
    
    async function updateIPStatus(ip, domain, status) {
      try {
        showAlert('ippoolAlert', \`正在更新IP \${ip} 状态为 \${status}...\`, 'info');
        addSyncLog('info', \`更新IP状态: \${ip} -> \${status}\`);
        
        const res = await fetch(\`/api/ip-pool/health/update-status/\${encodeURIComponent(ip)}?domain=\${domain}\`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ status })
        });
        
        if (res.ok) {
          showAlert('ippoolAlert', \`IP \${ip} 状态已更新为 \${status}\`, 'success');
          addSyncLog('success', \`IP \${ip} 状态更新成功: \${status}\`);
          
          // 刷新健康状态
          setTimeout(refreshHealthStatus, 1000);
        } else {
          const error = await res.json();
          showAlert('ippoolAlert', '更新失败: ' + error.message, 'error');
          addSyncLog('error', \`IP \${ip} 状态更新失败: \${error.message}\`);
        }
      } catch (error) {
        showAlert('ippoolAlert', '更新失败: ' + error.message, 'error');
        addSyncLog('error', \`IP \${ip} 状态更新异常: \${error.message}\`);
      }
    }
    
    async function clearIPStats(ip, domain) {
      try {
        showAlert('ippoolAlert', \`正在清除IP \${ip} 统计数据...\`, 'info');
        addSyncLog('info', \`清除IP统计数据: \${ip}\`);
        
        const res = await fetch(\`/api/ip-pool/health/clear-stats/\${encodeURIComponent(ip)}?domain=\${domain}\`, {
          method: 'POST'
        });
        
        if (res.ok) {
          showAlert('ippoolAlert', \`IP \${ip} 统计数据已清除\`, 'success');
          addSyncLog('success', \`IP \${ip} 统计数据清除成功\`);
          
          // 刷新健康状态
          setTimeout(refreshHealthStatus, 1000);
        } else {
          const error = await res.json();
          showAlert('ippoolAlert', '清除失败: ' + error.message, 'error');
          addSyncLog('error', \`IP \${ip} 统计数据清除失败: \${error.message}\`);
        }
      } catch (error) {
        showAlert('ippoolAlert', '清除失败: ' + error.message, 'error');
        addSyncLog('error', \`IP \${ip} 统计数据清除异常: \${error.message}\`);
      }
    }
    
    function renderHealthCheckStats() {
      if (!healthCheckStats) return;
      
      const container = document.getElementById('healthStatsContent');
      container.innerHTML = \`
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px;">
          <div class="stat-item">
            <div class="stat-label">总IP数</div>
            <div class="stat-value">\${healthCheckStats.totalIPs || 0}</div>
          </div>
          <div class="stat-item">
            <div class="stat-label">活跃IP</div>
            <div class="stat-value" style="color: #28a745;">\${healthCheckStats.activeCount || 0}</div>
          </div>
          <div class="stat-item">
            <div class="stat-label">黑名单IP</div>
            <div class="stat-value" style="color: #dc3545;">\${healthCheckStats.blacklistedCount || 0}</div>
          </div>
          <div class="stat-item">
            <div class="stat-label">总测试次数</div>
            <div class="stat-value">\${healthCheckStats.totalTests || 0}</div>
          </div>
          <div class="stat-item">
            <div class="stat-label">成功率</div>
            <div class="stat-value" style="color: #28a745;">\${(healthCheckStats.overallSuccessRate || 0).toFixed(1)}%</div>
          </div>
          <div class="stat-item">
            <div class="stat-label">运行状态</div>
            <div class="stat-value" style="color: \${healthCheckStats.isRunning ? '#28a745' : '#dc3545'};">\${healthCheckStats.isRunning ? '运行中' : '已停止'}</div>
          </div>
        </div>
      \`;
    }
    
    function renderHealthStatusTable() {
      const tbody = document.getElementById('healthStatusTableBody');
      if (!healthStatuses || healthStatuses.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" style="text-align: center; color: #666;">暂无健康状态数据</td></tr>';
        return;
      }
      
      tbody.innerHTML = healthStatuses.map(status => {
        const statusClass = \`status-\${status.status}\`;
        const statusText = status.status === 'active' ? '活跃' : 
                         status.status === 'blacklisted' ? '黑名单' : '测试中';
        
        const lastTestTime = status.lastTest ? new Date(status.lastTest).toLocaleString() : '从未测试';
        const avgResponseTime = status.avgResponseTime ? \`\${status.avgResponseTime.toFixed(0)}ms\` : '-';
        
        return \`
          <tr>
            <td>\${status.ip}</td>
            <td>\${status.domain}</td>
            <td><span class="\${statusClass}">\${statusText}</span></td>
            <td>\${status.successRate.toFixed(1)}%</td>
            <td>\${avgResponseTime}</td>
            <td>\${status.totalTests}</td>
            <td>\${lastTestTime}</td>
            <td>
              <button class="health-action-btn test" onclick="testIPManually('\${status.ip}', '\${status.domain}')">测试</button>
              <button class="health-action-btn activate" onclick="updateIPStatus('\${status.ip}', '\${status.domain}', 'active')">激活</button>
              <button class="health-action-btn blacklist" onclick="updateIPStatus('\${status.ip}', '\${status.domain}', 'blacklisted')">拉黑</button>
              <button class="health-action-btn clear" onclick="clearIPStats('\${status.ip}', '\${status.domain}')">清除</button>
            </td>
          </tr>
        \`;
      }).join('');
    }
        const statsRes = await fetch('/api/ip-pool/stats');
        if (statsRes.ok) {
          const stats = await statsRes.json();
          renderIPPoolStats(stats);
        }
        
      } catch (error) {
        showAlert('ippoolAlert', '获取IP池数据失败: ' + error.message, 'error');
      }
    }
    
    function renderIPPoolStats(stats) {
      if (!stats) return;
      
      const statsHtml = \`
        <div class="stat-item">
          <div class="stat-value">\${stats.totalIPs || 0}</div>
          <div class="stat-label">总IP数</div>
        </div>
        <div class="stat-item">
          <div class="stat-value">\${stats.knownNodes || 0}</div>
          <div class="stat-label">已知节点</div>
        </div>
        <div class="stat-item">
          <div class="stat-value">\${stats.syncCount || 0}</div>
          <div class="stat-label">同步次数</div>
        </div>
        <div class="stat-item">
          <div class="stat-value">\${stats.syncInProgress ? '进行中' : '空闲'}</div>
          <div class="stat-label">同步状态</div>
        </div>
        <div class="stat-item">
          <div class="stat-value">\${stats.nodeId || 'unknown'}</div>
          <div class="stat-label">节点ID</div>
        </div>
      \`;
      
      document.getElementById('ippoolStats').innerHTML = statsHtml;
    }
    
    function renderIPPoolTable() {
      if (!ipPoolData || !ipPoolData.domains) return;
      
      const tbody = document.getElementById('ippoolTableBody');
      tbody.innerHTML = '';
      
      for (const [domain, domainData] of Object.entries(ipPoolData.domains)) {
        const row = document.createElement('tr');
        
        row.innerHTML = \`
          <td>\${domain}</td>
          <td>\${domainData.ipv4.length}</td>
          <td>\${domainData.ipv6.length}</td>
          <td>\${domainData.blacklist.length}</td>
          <td>\${domainData.preferIPv6 ? '是' : '否'}</td>
          <td>\${new Date(ipPoolData.lastUpdate).toLocaleString()}</td>
          <td>
            <button class="btn-small btn-info" onclick="showDomainDetails('\${domain}')">详情</button>
          </td>
        \`;
        
        tbody.appendChild(row);
      }
    }
    
    async function triggerIPPoolSync() {
      try {
        showAlert('ippoolAlert', '正在触发IP池同步...', 'info');
        addSyncLog('info', '手动触发IP池同步');
        
        const res = await fetch('/api/ip-pool/trigger', {
          method: 'POST'
        });
        
        if (res.ok) {
          const result = await res.json();
          showAlert('ippoolAlert', 'IP池同步已触发', 'success');
          addSyncLog('success', 'IP池同步触发成功');
          
          // 延迟刷新数据
          setTimeout(() => {
            refreshIPPoolData();
          }, 2000);
        } else {
          throw new Error('同步触发失败');
        }
      } catch (error) {
        showAlert('ippoolAlert', '触发同步失败: ' + error.message, 'error');
        addSyncLog('error', '同步触发失败: ' + error.message);
      }
    }
    
    function exportIPPoolData() {
      if (!ipPoolData) {
        showAlert('ippoolAlert', '没有可导出的数据', 'error');
        return;
      }
      
      const dataStr = JSON.stringify(ipPoolData, null, 2);
      const dataBlob = new Blob([dataStr], { type: 'application/json' });
      const url = URL.createObjectURL(dataBlob);
      
      const link = document.createElement('a');
      link.href = url;
      link.download = \`ip-pool-\${new Date().toISOString().split('T')[0]}.json\`;
      link.click();
      
      URL.revokeObjectURL(url);
      showAlert('ippoolAlert', 'IP池数据已导出', 'success');
    }
    
    function showIPPoolDetails() {
      if (!ipPoolData) {
        showAlert('ippoolAlert', '没有可显示的数据', 'error');
        return;
      }
      
      const content = document.getElementById('ippoolDetailsContent');
      content.innerHTML = \`
        <div style="max-height: 400px; overflow-y: auto;">
          <pre>\${JSON.stringify(ipPoolData, null, 2)}</pre>
        </div>
      \`;
      
      document.getElementById('ippoolDetailsModal').style.display = 'block';
    }
    
    function hideIPPoolDetails() {
      document.getElementById('ippoolDetailsModal').style.display = 'none';
    }
    
    function showDomainDetails(domain) {
      if (!ipPoolData || !ipPoolData.domains[domain]) return;
      
      const domainData = ipPoolData.domains[domain];
      const content = document.getElementById('ippoolDetailsContent');
      
      content.innerHTML = \`
        <h4>\${domain} 详情</h4>
        <div style="max-height: 400px; overflow-y: auto;">
          <h5>IPv4 地址 (\${domainData.ipv4.length}):</h5>
          <ul>\${domainData.ipv4.map(ip => \`<li>\${ip}</li>\`).join('')}</ul>
          
          <h5>IPv6 地址 (\${domainData.ipv6.length}):</h5>
          <ul>\${domainData.ipv6.map(ip => \`<li>\${ip}</li>\`).join('')}</ul>
          
          <h5>黑名单 (\${domainData.blacklist.length}):</h5>
          <ul>\${domainData.blacklist.map(ip => \`<li>\${ip}</li>\`).join('')}</ul>
          
          <h5>健康数据:</h5>
          <pre>\${JSON.stringify(domainData.health, null, 2)}</pre>
        </div>
      \`;
      
      document.getElementById('ippoolDetailsModal').style.display = 'block';
    }
    
    function addSyncLog(type, message) {
      const timestamp = new Date().toLocaleTimeString();
      syncLog.push({ type, message, timestamp });
      
      // 保持最近50条日志
      if (syncLog.length > 50) {
        syncLog = syncLog.slice(-50);
      }
      
      renderSyncLog();
    }
    
    function renderSyncLog() {
      const content = document.getElementById('syncLogContent');
      content.innerHTML = syncLog.map(entry => 
        \`<div class="log-entry \${entry.type}">[\${entry.timestamp}] \${entry.message}</div>\`
      ).join('');
      
      // 滚动到底部
      content.scrollTop = content.scrollHeight;
    }
    
    // 点击模态框外部关闭
    window.onclick = function(event) {
      const addNodeModal = document.getElementById('addNodeModal');
      const ippoolDetailsModal = document.getElementById('ippoolDetailsModal');
      
      if (event.target === addNodeModal) {
        hideAddNodeForm();
      }
      if (event.target === ippoolDetailsModal) {
        hideIPPoolDetails();
      }
    };
  </script>
</body>
</html>`;
  }

  /**
   * 节点管理 API
   * GET    /api/nodes           → 获取所有节点
   * GET    /api/nodes/{id}       → 获取单个节点
   * POST   /api/nodes            → 添加新节点
   * PUT    /api/nodes/{id}       → 更新节点
   * DELETE /api/nodes/{id}       → 删除节点
   * POST   /api/nodes/{id}/toggle → 启用/禁用节点
   * GET    /api/nodes/{id}/health → 获取节点健康状态
   */
  private async serveNodeManagement(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url || '', 'http://localhost')
      const pathParts = url.pathname.split('/').filter(p => p)
      
      // 解析节点ID（如果有）
      const nodeId = pathParts[3] // /api/nodes/{id}
      const action = pathParts[4] // /api/nodes/{id}/action
      
      // 设置CORS头
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Secret')
      
      // 处理OPTIONS请求
      if (req.method === 'OPTIONS') {
        res.writeHead(200)
        res.end()
        return
      }
      
      // 验证权限（使用webhook secret）
      const config = getConfig()
      const secret = config.get<string>('server.webhook.secret')
      const providedSecret = req.headers['x-secret'] as string
      
      if (secret && providedSecret !== secret) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Unauthorized' }))
        return
      }
      
      switch (req.method) {
        case 'GET':
          if (nodeId) {
            if (action === 'health') {
              // 获取节点健康状态
              const health = this.nodeManager.getNodeHealth(nodeId)
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify(health))
            } else {
              // 获取单个节点
              const node = this.nodeManager.getNode(nodeId)
              if (node) {
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify(node))
              } else {
                res.writeHead(404, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ error: 'Node not found' }))
              }
            }
          } else {
            // 获取所有节点
            const nodes = this.nodeManager.getAllNodes()
            const healthData = this.nodeManager.getAllNodeHealth()
            const stats = this.nodeManager.getStats()
            
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({
              nodes,
              health: healthData,
              stats
            }))
          }
          break
          
        case 'POST':
          if (nodeId && action === 'toggle') {
            // 切换节点启用/禁用状态
            const body = await this.readRequestBody(req)
            const { enabled } = JSON.parse(body)
            
            const success = await this.nodeManager.toggleNode(nodeId, enabled)
            if (success) {
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ success: true, message: `Node ${enabled ? 'enabled' : 'disabled'}` }))
            } else {
              res.writeHead(404, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: 'Node not found' }))
            }
          } else {
            // 添加新节点
            const body = await this.readRequestBody(req)
            const nodeData = JSON.parse(body)
            
            const node = await this.nodeManager.addNode(nodeData)
            res.writeHead(201, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(node))
          }
          break
          
        case 'PUT':
          if (nodeId) {
            // 更新节点
            const body = await this.readRequestBody(req)
            const updates = JSON.parse(body)
            
            const node = await this.nodeManager.updateNode(nodeId, updates)
            if (node) {
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify(node))
            } else {
              res.writeHead(404, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: 'Node not found' }))
            }
          } else {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'Node ID required' }))
          }
          break
          
        case 'DELETE':
          if (nodeId) {
            // 删除节点
            const success = await this.nodeManager.removeNode(nodeId)
            if (success) {
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ success: true, message: 'Node deleted' }))
            } else {
              res.writeHead(404, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: 'Node not found' }))
            }
          } else {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'Node ID required' }))
          }
          break
          
        default:
          res.writeHead(405, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Method not allowed' }))
      }
      
    } catch (error) {
      logger.error('节点管理API错误', error as Error)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Internal server error' }))
    }
  }
  
  /**
   * 读取请求体
   */
  private async readRequestBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => resolve(Buffer.concat(chunks).toString()))
      req.on('error', reject)
    })
  }

  /**
   * IP池同步 API
   * GET    /api/ip-pool/data        → 获取当前IP池数据
   * GET    /api/ip-pool/stats       → 获取同步统计
   * POST   /api/ip-pool/sync        → 处理同步请求
   * POST   /api/ip-pool/trigger     → 手动触发同步
   */
  private async serveIPPoolSync(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url || '', 'http://localhost')
      const pathParts = url.pathname.split('/').filter(p => p)
      
      // 解析API路径
      const action = pathParts[3] // /api/ip-pool/{action}
      
      // 设置CORS头
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Secret')
      
      // 处理OPTIONS请求
      if (req.method === 'OPTIONS') {
        res.writeHead(200)
        res.end()
        return
      }
      
      switch (req.method) {
        case 'GET':
          if (action === 'data') {
            // 获取当前IP池数据
            const data = this.ipPoolSyncManager.getCurrentData()
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(data))
          } else if (action === 'stats') {
            // 获取同步统计
            const stats = this.ipPoolSyncManager.getSyncStats()
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(stats))
          } else if (action === 'health' && pathParts[4] === 'stats') {
            // 获取健康检查统计
            const stats = this.ipPoolSyncManager.getHealthCheckStats()
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(stats))
          } else if (action === 'health' && pathParts[4] === 'status') {
            // 获取所有IP健康状态
            const statuses = this.ipPoolSyncManager.getAllIPHealthStatus()
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(statuses))
          } else {
            res.writeHead(404, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'Not found' }))
          }
          break
          
        case 'POST':
          if (action === 'sync') {
            // 处理同步请求
            const body = await this.readRequestBody(req)
            const syncRequest = JSON.parse(body)
            
            const response = await this.ipPoolSyncManager.handleSyncRequest(syncRequest)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(response))
          } else if (action === 'trigger') {
            // 手动触发同步
            await this.ipPoolSyncManager.triggerSync()
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true, message: '同步已触发' }))
          } else if (action === 'health' && pathParts[4] === 'start') {
            // 启动健康检查
            this.ipPoolSyncManager.startHealthCheck()
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true, message: '健康检查已启动' }))
          } else if (action === 'health' && pathParts[4] === 'stop') {
            // 停止健康检查
            this.ipPoolSyncManager.stopHealthCheck()
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true, message: '健康检查已停止' }))
          } else if (action === 'health' && pathParts[4] === 'test' && pathParts[5]) {
            // 手动测试IP
            const ip = decodeURIComponent(pathParts[5])
            const domain = url.searchParams.get('domain') || 'kh.google.com'
            
            try {
              const result = await this.ipPoolSyncManager.testIPManually(ip, domain)
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ success: true, result }))
            } catch (error) {
              res.writeHead(500, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ success: false, message: (error as Error).message }))
            }
          } else if (action === 'health' && pathParts[4] === 'update-status' && pathParts[5]) {
            // 强制更新IP状态
            const ip = decodeURIComponent(pathParts[5])
            const domain = url.searchParams.get('domain') || 'kh.google.com'
            
            const body = await this.readRequestBody(req)
            const { status } = JSON.parse(body)
            
            if (status !== 'active' && status !== 'blacklisted') {
              res.writeHead(400, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ success: false, message: 'Invalid status. Must be "active" or "blacklisted"' }))
              return
            }
            
            this.ipPoolSyncManager.updateIPStatus(ip, domain, status)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true, message: 'IP状态已更新' }))
          } else if (action === 'health' && pathParts[4] === 'clear-stats' && pathParts[5]) {
            // 清除IP统计数据
            const ip = decodeURIComponent(pathParts[5])
            const domain = url.searchParams.get('domain') || 'kh.google.com'
            
            this.ipPoolSyncManager.clearIPStats(ip, domain)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true, message: 'IP统计数据已清除' }))
          } else {
            res.writeHead(404, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'Not found' }))
          }
          break
          
        default:
          res.writeHead(405, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Method not allowed' }))
      }
      
    } catch (error) {
      logger.error('IP池同步API错误', error as Error)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Internal server error' }))
    }
  }

  /**
   * 停止监控服务器
   */
  public stop(): void {
    if (this.metricsInterval) {
      clearInterval(this.metricsInterval)
      this.metricsInterval = null
    }
    if (this.nodeManager) {
      this.nodeManager.stop()
    }
    if (this.ipPoolSyncManager) {
      this.ipPoolSyncManager.stop()
    }
    if (this.server) {
      this.server.close()
      logger.info('监控服务器已停止')
    }
  }
}

