/**
 * API路由处理器
 * 负责处理所有HTTP API请求
 */

import * as http from 'http'
import * as fs from 'fs'
import * as path from 'path'
import { RpcServer } from './rpc-server.js'
import { NodeManager } from './node-manager.js'
import { IPPoolSyncManager } from './ip-pool-sync.js'
import { createLogger } from './logger.js'
import { getConfig } from './config-manager.js'

const logger = createLogger('APIRoutes')

export class APIRoutes {
  constructor(
    private rpcServer: RpcServer,
    private nodeManager: NodeManager,
    private ipPoolSyncManager: IPPoolSyncManager,
    private getVersion: () => string
  ) {}

  /**
   * 处理API请求
   */
  public async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url!, `http://${req.headers.host}`)
    const pathname = url.pathname

    try {
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

      // 路由分发
      if (pathname === '/api/stats') {
        await this.serveStats(res)
      } else if (pathname.startsWith('/api/stats/export')) {
        await this.serveStatsExport(req, res)
      } else if (pathname === '/api/ipv6') {
        this.serveIPv6(res)
      } else if (pathname === '/api/error-logs') {
        this.serveErrorLogs(res)
      } else if (pathname === '/api/config') {
        await this.serveConfig(req, res)
      } else if (pathname.startsWith('/api/fetch')) {
        await this.serveFetch(req, res, pathname)
      } else if (pathname === '/api/logs') {
        await this.serveLogs(req, res)
      } else if (pathname === '/api/service-control') {
        await this.serveServiceControl(req, res)
      } else if (pathname.startsWith('/api/nodes')) {
        await this.serveNodeManagement(req, res)
      } else if (pathname.startsWith('/api/ip-pool')) {
        await this.serveIPPoolSync(req, res)
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Not found' }))
      }

    } catch (error) {
      logger.error('API请求处理失败', error as Error)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Internal server error' }))
    }
  }

  /**
   * 提供统计数据API
   */
  private async serveStats(res: http.ServerResponse): Promise<void> {
    try {
      const stats = await this.rpcServer.getStats()
      const ipv6Pool = this.rpcServer.getIPv6Pool()
      const detailedStats = ipv6Pool.getDetailedStats()

      const response = {
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

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(response))
    } catch (error) {
      logger.error('获取统计数据失败', error as Error)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Failed to get stats' }))
    }
  }

  /**
   * 提供统计数据导出
   */
  private async serveStatsExport(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url!, `http://${req.headers.host}`)
      const format = url.searchParams.get('format') || 'json'
      const hours = parseInt(url.searchParams.get('hours') || '24')

      const metricsFilePath = path.join(process.cwd(), 'logs', 'metrics.log')
      
      if (!fs.existsSync(metricsFilePath)) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Metrics file not found' }))
        return
      }

      const data = fs.readFileSync(metricsFilePath, 'utf-8')
      const lines = data.trim().split('\n').filter(line => line.trim())
      
      const cutoffTime = Date.now() - (hours * 60 * 60 * 1000)
      const recentLines = lines.filter(line => {
        try {
          const record = JSON.parse(line)
          return record.ts >= cutoffTime
        } catch {
          return false
        }
      })

      const metrics = recentLines.map(line => JSON.parse(line))

      if (format === 'csv') {
        res.writeHead(200, {
          'Content-Type': 'text/csv',
          'Content-Disposition': `attachment; filename="metrics-${hours}h.csv"`
        })
        
        if (metrics.length > 0) {
          const headers = ['timestamp', 'clients', 'totalRequests', 'concurrentRequests', 'successRate', 'avgResponseTime']
          res.write(headers.join(',') + '\n')
          
          metrics.forEach(metric => {
            const stats = metric.stats
            const row = [
              new Date(metric.ts).toISOString(),
              stats.totalClients || 0,
              stats.fetcherStats?.totalRequests || 0,
              stats.fetcherStats?.concurrentRequests || 0,
              stats.ipv6Pool?.successRate || 0,
              stats.ipv6Pool?.avgResponseTime || 0
            ]
            res.write(row.join(',') + '\n')
          })
        }
        res.end()
      } else {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Disposition': `attachment; filename="metrics-${hours}h.json"`
        })
        res.end(JSON.stringify(metrics, null, 2))
      }
    } catch (error) {
      logger.error('导出统计数据失败', error as Error)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Export failed' }))
    }
  }

  /**
   * 提供IPv6信息
   */
  private serveIPv6(res: http.ServerResponse): void {
    try {
      const ipv6Pool = this.rpcServer.getIPv6Pool()
      const stats = ipv6Pool.getDetailedStats()
      const addresses = ipv6Pool.getAllAddresses()

      const response = {
        stats,
        addresses: addresses.slice(0, 100), // 限制返回数量
        total: addresses.length
      }

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(response))
    } catch (error) {
      logger.error('获取IPv6信息失败', error as Error)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Failed to get IPv6 info' }))
    }
  }

  /**
   * 提供错误日志
   */
  private serveErrorLogs(res: http.ServerResponse): void {
    try {
      const errorLogPath = path.join(process.cwd(), 'logs', 'error.log')
      
      if (!fs.existsSync(errorLogPath)) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ logs: [] }))
        return
      }

      const logs = fs.readFileSync(errorLogPath, 'utf-8')
        .split('\n')
        .filter(line => line.trim())
        .slice(-50) // 最近50条
        .map(line => {
          try {
            return JSON.parse(line)
          } catch {
            return { message: line, timestamp: Date.now() }
          }
        })

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ logs }))
    } catch (error) {
      logger.error('获取错误日志失败', error as Error)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Failed to get error logs' }))
    }
  }

  /**
   * 提供配置API
   */
  private async serveConfig(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const config = getConfig()
      
      // 对于 GET 请求，不需要认证（只读访问）
      if (req.method === 'GET') {
        const allConfig = config.getAll()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(allConfig))
        return
      }
      
      // 对于 POST 请求，需要认证
      if (req.method === 'POST') {
        const secret = req.headers['x-secret'] as string
        if (!secret || secret !== config.get<string>('server.webhook.secret')) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Unauthorized' }))
          return
        }
        
        const body = await this.readRequestBody(req)
        const updates = JSON.parse(body)
        
        for (const [path, value] of Object.entries(updates)) {
          await config.set(path, value)
        }
        
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: true }))
      } else {
        res.writeHead(405, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Method not allowed' }))
      }
    } catch (error) {
      logger.error('配置API处理失败', error as Error)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Config operation failed' }))
    }
  }

  /**
   * 提供数据获取API
   */
  private async serveFetch(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): Promise<void> {
    try {
      // 处理 POST 请求体中的 URI
      if (req.method === 'POST') {
        const body = await this.readRequestBody(req)
        const { uri } = JSON.parse(body)
        
        if (!uri) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'URI is required' }))
          return
        }
        
        const url = `https://kh.google.com/rt/earth/${uri}`
        logger.debug('[API] 收到请求', { uri: uri.substring(0, 80) })

        const fetcher = this.rpcServer.getFetcher()
        const result = await fetcher.fetch({ url, timeout: 10000 })

        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': result.body.length.toString()
        })
        res.end(Buffer.from(result.body))
      } else {
        // 处理 GET 请求中的 URI 参数
        const uri = decodeURIComponent(pathname.replace('/api/fetch/', ''))
        if (!uri) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'URI is required' }))
          return
        }
        
        const url = `https://kh.google.com/rt/earth/${uri}`
        logger.debug('[API] 收到请求', { uri: uri.substring(0, 80) })

        const fetcher = this.rpcServer.getFetcher()
        const result = await fetcher.fetch({ url, timeout: 10000 })

        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': result.body.length.toString()
        })
        res.end(Buffer.from(result.body))
      }
    } catch (error) {
      logger.error('[API] 请求失败', error as Error)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Fetch failed' }))
    }
  }

  /**
   * 提供日志API
   */
  private async serveLogs(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url!, `http://${req.headers.host}`)
      const type = url.searchParams.get('type') || 'combined'
      const lines = parseInt(url.searchParams.get('lines') || '100')

      const logPath = path.join(process.cwd(), 'logs', `${type}.log`)
      
      if (!fs.existsSync(logPath)) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Log file not found' }))
        return
      }

      const logContent = fs.readFileSync(logPath, 'utf-8')
      const logLines = logContent.split('\n').filter(line => line.trim())
      const recentLines = logLines.slice(-lines)

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ logs: recentLines }))
    } catch (error) {
      logger.error('获取日志失败', error as Error)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Failed to get logs' }))
    }
  }

  /**
   * 提供服务控制API
   */
  private async serveServiceControl(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const secret = req.headers['x-secret'] as string
      const config = getConfig()
      
      if (!secret || secret !== config.get<string>('server.secret')) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Unauthorized' }))
        return
      }

      const body = await this.readRequestBody(req)
      const { action } = JSON.parse(body)

      switch (action) {
        case 'restart':
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: true, message: 'Restart command sent' }))
          // 延迟重启，让响应先发送
          setTimeout(() => {
            process.exit(0)
          }, 1000)
          break

        case 'reload-config':
          config.reload()
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: true, message: 'Config reloaded' }))
          break

        default:
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Invalid action' }))
      }
    } catch (error) {
      logger.error('服务控制API处理失败', error as Error)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Service control failed' }))
    }
  }

  /**
   * 处理节点管理API
   */
  private async serveNodeManagement(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url!, `http://${req.headers.host}`)
      const pathParts = url.pathname.split('/').filter(p => p)
      
      const action = pathParts[2] // /api/nodes/{action}
      
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
      
      switch (req.method) {
        case 'GET':
          if (action === undefined) {
            // 获取所有节点
            const nodes = this.nodeManager.getAllNodes()
            const health = this.nodeManager.getAllNodeHealth()
            const stats = this.nodeManager.getStats()
            
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ nodes, health, stats }))
          } else {
            res.writeHead(404, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'Not found' }))
          }
          break
          
        case 'POST':
          if (action === undefined) {
            // 添加节点
            const body = await this.readRequestBody(req)
            const nodeData = JSON.parse(body)
            
            const newNode = await this.nodeManager.addNode(nodeData)
            res.writeHead(201, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(newNode))
          } else {
            res.writeHead(404, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'Not found' }))
          }
          break
          
        case 'PUT':
          if (action && pathParts[3]) {
            // 更新节点状态
            const nodeId = decodeURIComponent(pathParts[3])
            const body = await this.readRequestBody(req)
            const { enabled } = JSON.parse(body)
            
            const success = await this.nodeManager.toggleNode(nodeId, enabled)
            if (success) {
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ success: true }))
            } else {
              res.writeHead(404, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: 'Node not found' }))
            }
          } else {
            res.writeHead(404, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'Not found' }))
          }
          break
          
        case 'DELETE':
          if (action && pathParts[3]) {
            // 删除节点
            const nodeId = decodeURIComponent(pathParts[3])
            const success = await this.nodeManager.removeNode(nodeId)
            
            if (success) {
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ success: true }))
            } else {
              res.writeHead(404, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: 'Node not found' }))
            }
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
      logger.error('节点管理API错误', error as Error)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Internal server error' }))
    }
  }

  /**
   * 处理IP池同步API
   */
  private async serveIPPoolSync(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url!, `http://${req.headers.host}`)
      const pathParts = url.pathname.split('/').filter(p => p)
      
      // 解析API路径
      const action = pathParts[3] || 'data' // /api/ip-pool/{action}，默认为 'data'
      
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
   * 读取请求体
   */
  private async readRequestBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = ''
      req.on('data', chunk => {
        body += chunk.toString()
      })
      req.on('end', () => {
        resolve(body)
      })
      req.on('error', reject)
    })
  }
}
