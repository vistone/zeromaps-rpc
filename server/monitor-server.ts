/**
 * Web监控服务器
 * 提供HTTP接口和Web界面查看服务器运行状态
 */

import * as http from 'http'
import { RpcServer } from './rpc-server'

export class MonitorServer {
  private server: http.Server | null = null
  private rpcServer: RpcServer

  constructor(
    private port: number,
    rpcServer: RpcServer
  ) {
    this.rpcServer = rpcServer
  }

  /**
   * 启动监控服务器
   */
  public start(): void {
    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res)
    })

    this.server.listen(this.port, () => {
      console.log(`📊 监控服务器启动: http://0.0.0.0:${this.port}`)
    })
  }

  /**
   * 处理HTTP请求
   */
  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // CORS 支持（浏览器直连需要）
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    // OPTIONS 预检
    if (req.method === 'OPTIONS') {
      res.writeHead(200)
      res.end()
      return
    }

    const url = req.url || '/'

    if (url === '/' || url === '/index.html') {
      this.serveHTML(res)
    } else if (url === '/api/stats') {
      this.serveStats(res)
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
  private serveStats(res: http.ServerResponse): void {
    const stats = this.rpcServer.getStats()
    const ipv6Pool = this.rpcServer.getIPv6Pool()
    const detailedStats = ipv6Pool.getDetailedStats()

    const data = {
      timestamp: Date.now(),
      clients: stats.totalClients,
      requests: {
        total: stats.curlStats.totalRequests,
        concurrent: stats.curlStats.concurrentRequests,
        maxConcurrent: stats.curlStats.maxConcurrent
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
      }
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

      // 使用 curl-impersonate 获取数据
      const curlFetcher = this.rpcServer.getCurlFetcher()
      const result = await curlFetcher.fetch({
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
      console.error('[HTTP API] 错误:', error)
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
  </style>
</head>
<body>
  <div class="container">
    <h1>🚀 ZeroMaps RPC 监控面板</h1>
    
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
      console.log('✓ 监控服务器已停止')
    }
  }
}

