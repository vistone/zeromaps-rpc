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

const logger = createLogger('MonitorServer')

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

interface WsMessage {
  type: 'fetch' | 'ping'
  id?: string
  uri?: string
}

interface WsResponse {
  type: 'response' | 'error' | 'pong' | 'stats'
  id?: string
  data?: any
  error?: string
}

export class MonitorServer {
  private server: http.Server | null = null
  private wss: WebSocketServer | null = null
  private rpcServer: RpcServer

  constructor(
    private port: number,
    rpcServer: RpcServer
  ) {
    this.rpcServer = rpcServer
  }

  /**
   * 实时读取版本号（每次调用时读取，确保获取最新版本）
   */
  private getVersion(): string {
    try {
      const packagePath = path.join(__dirname, '../package.json')
      const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf-8'))
      return packageJson.version || 'unknown'
    } catch (error) {
      logger.warn('读取版本号失败', { error: (error as Error).message })
      return 'unknown'
    }
  }

  /**
   * 启动监控服务器（HTTP + WebSocket）
   */
  public start(): void {
    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res)
    })

    // 创建 WebSocket 服务器（在同一个 HTTP 服务器上）
    this.wss = new WebSocketServer({
      server: this.server,
      path: '/ws'
    })

    // 处理 WebSocket 连接
    this.wss.on('connection', (ws: WebSocket, req) => {
      const clientIP = req.socket.remoteAddress
      logger.info('WebSocket 客户端连接', { clientIP })

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
                queueLength: stats.fetcherStats.queueLength || 0
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
                qps: parseFloat(detailedStats.requestsPerSecond)
              },
              system: stats.system,
              health: stats.health
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
        logger.info('WebSocket 客户端断开', { clientIP })
        clearInterval(statsInterval)  // 清理统计推送定时器
        this.rpcServer.off('requestLog', requestLogHandler)  // 移除请求日志监听器
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
    } else if (url === '/api/stats') {
      await this.serveStats(res)
    } else if (url === '/api/ipv6') {
      this.serveIPv6Stats(res)
    } else if (url.startsWith('/api/fetch')) {
      await this.serveFetch(req, res, url)
    } else {
      res.writeHead(404)
      res.end('Not Found')
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
        queueLength: stats.fetcherStats.queueLength || 0
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
        qps: parseFloat(detailedStats.requestsPerSecond)
      },
      system: stats.system,
      health: stats.health
    }

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(data, null, 2))
  }

  /**
   * 返回每个IPv6的详细统计
   */
  private serveIPv6Stats(res: http.ServerResponse): void {
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
        <div class="logs-title">📋 实时请求日志</div>
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
            healthBanner.innerHTML = '✅ 节点状态正常 - Google Earth 可访问 (上次检测: ' + lastCheck + ')';
          } else if (status === 403) {
            healthBanner.style.background = '#ef4444';
            healthBanner.style.color = 'white';
            healthBanner.innerHTML = '⚠️ 节点被拉黑 - Google 返回 403 禁止访问 (上次检测: ' + lastCheck + ')';
          } else {
            healthBanner.style.background = '#f59e0b';
            healthBanner.style.color = 'white';
            healthBanner.innerHTML = '⚠️ 健康检查异常: ' + message + ' (上次检测: ' + lastCheck + ')';
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
        document.getElementById('ipv6Total').textContent = formatNumber(stats.ipv6.total);
        document.getElementById('avgPerIP').textContent = formatNumber(stats.ipv6.avgPerIP);
        document.getElementById('balance').textContent = stats.ipv6.balance;

        // 更新IPv6表格（按请求数排序）
        const sorted = ipv6Data.items.sort((a, b) => b.requests - a.requests).slice(0, 20);
        const tbody = document.getElementById('ipv6Table');
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
    const maxLogs = 50;

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
            IPv6: \${log.ipv6 || 'N/A'} | 等待: \${log.waitTime || 0}ms | 执行: \${log.duration || log.curlTime || 0}ms
            \${log.error ? ' | 错误: ' + log.error : ''}
          </div>
        </div>\`;
      }).join('');
    }

    function clearLogs() {
      requestLogs.length = 0;
      renderLogs();
    }

    // 连接 WebSocket
    connectWebSocket();
  </script>
</body>
</html>`;
  }

  /**
   * 停止监控服务器
   */
  public stop(): void {
    if (this.server) {
      this.server.close()
      logger.info('监控服务器已停止')
    }
  }
}

