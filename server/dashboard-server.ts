/**
 * 统一监控面板服务器
 * 聚合所有VPS节点的监控数据，提供集中管理界面
 */

import * as http from 'http'
import * as https from 'https'

interface VPSConfig {
  name: string
  domain: string
  ip: string
  ipv6Prefix: string
  monitorUrl: string
}

export class DashboardServer {
  private server: http.Server | null = null
  private vpsConfigs: VPSConfig[] = []

  constructor(private port: number) {
    // 7个VPS配置
    this.vpsConfigs = [
      {
        name: 'tile0',
        domain: 'tile0.zeromaps.cn',
        ip: '172.93.47.57',
        ipv6Prefix: '2607:8700:5500:2943',
        monitorUrl: 'http://tile0.zeromaps.cn:9528'
      },
      {
        name: 'tile3',
        domain: 'tile3.zeromaps.cn',
        ip: '65.49.192.85',
        ipv6Prefix: '2607:8700:5500:e639',
        monitorUrl: 'http://tile3.zeromaps.cn:9528'
      },
      {
        name: 'tile4',
        domain: 'tile4.zeromaps.cn',
        ip: '65.49.195.185',
        ipv6Prefix: '2607:8700:5500:1e09',
        monitorUrl: 'http://tile4.zeromaps.cn:9528'
      },
      {
        name: 'tile5',
        domain: 'tile5.zeromaps.cn',
        ip: '65.49.194.100',
        ipv6Prefix: '2607:8700:5500:203e',
        monitorUrl: 'http://tile5.zeromaps.cn:9528'
      },
      {
        name: 'tile6',
        domain: 'tile6.zeromaps.cn',
        ip: '66.112.211.45',
        ipv6Prefix: '2607:8700:5500:bf4b',
        monitorUrl: 'http://tile6.zeromaps.cn:9528'
      },
      {
        name: 'tile12',
        domain: 'tile12.zeromaps.cn',
        ip: '107.182.186.123',
        ipv6Prefix: '2607:8700:5500:2043',
        monitorUrl: 'http://tile12.zeromaps.cn:9528'
      },
      {
        name: 'www',
        domain: 'www.zeromaps.com.cn',
        ip: '45.78.5.252',
        ipv6Prefix: '2607:8700:5500:d197',
        monitorUrl: 'http://www.zeromaps.com.cn:9528'
      }
    ]
  }

  /**
   * 启动管理面板服务器
   */
  public start(): void {
    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res)
    })

    this.server.listen(this.port, () => {
      console.log(`🎛️  统一管理面板启动: http://0.0.0.0:${this.port}`)
    })
  }

  /**
   * 处理HTTP请求
   */
  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    // 设置CORS
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    if (req.method === 'OPTIONS') {
      res.writeHead(200)
      res.end()
      return
    }

    const url = req.url || '/'

    if (url === '/' || url === '/index.html') {
      this.serveDashboard(res)
    } else if (url === '/api/all-stats') {
      this.serveAllStats(res)
    } else {
      res.writeHead(404)
      res.end('Not Found')
    }
  }

  /**
   * 从单个VPS获取统计数据
   */
  private async fetchVPSStats(vps: VPSConfig): Promise<any> {
    return new Promise((resolve) => {
      const url = `${vps.monitorUrl}/api/stats`
      
      http.get(url, { timeout: 3000 }, (response) => {
        let data = ''
        
        response.on('data', (chunk) => {
          data += chunk
        })
        
        response.on('end', () => {
          try {
            const stats = JSON.parse(data)
            resolve({
              ...vps,
              status: 'online',
              stats
            })
          } catch (error) {
            resolve({
              ...vps,
              status: 'error',
              error: '数据解析失败'
            })
          }
        })
      }).on('error', () => {
        resolve({
          ...vps,
          status: 'offline',
          error: '无法连接'
        })
      })
    })
  }

  /**
   * 获取所有VPS的统计数据
   */
  private async serveAllStats(res: http.ServerResponse): Promise<void> {
    const promises = this.vpsConfigs.map(vps => this.fetchVPSStats(vps))
    const results = await Promise.all(promises)

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      timestamp: Date.now(),
      total: results.length,
      online: results.filter(r => r.status === 'online').length,
      offline: results.filter(r => r.status === 'offline').length,
      nodes: results
    }, null, 2))
  }

  /**
   * 返回管理面板HTML
   */
  private serveDashboard(res: http.ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(this.getDashboardHTML())
  }

  /**
   * 生成管理面板HTML
   */
  private getDashboardHTML(): string {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ZeroMaps RPC 统一管理面板</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: #333;
      padding: 20px;
    }
    .container {
      max-width: 1600px;
      margin: 0 auto;
    }
    h1 {
      color: white;
      text-align: center;
      margin-bottom: 10px;
      font-size: 2.5em;
      text-shadow: 2px 2px 4px rgba(0,0,0,0.3);
    }
    .summary {
      text-align: center;
      color: white;
      margin-bottom: 30px;
      font-size: 1.2em;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(350px, 1fr));
      gap: 20px;
      margin-bottom: 30px;
    }
    .node-card {
      background: white;
      border-radius: 12px;
      padding: 20px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.2);
      transition: all 0.3s;
      border-left: 5px solid #ccc;
    }
    .node-card:hover {
      transform: translateY(-5px);
      box-shadow: 0 15px 40px rgba(0,0,0,0.3);
    }
    .node-card.online {
      border-left-color: #10b981;
    }
    .node-card.offline {
      border-left-color: #ef4444;
      opacity: 0.7;
    }
    .node-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 15px;
      padding-bottom: 10px;
      border-bottom: 2px solid #f0f0f0;
    }
    .node-name {
      font-size: 1.5em;
      font-weight: bold;
      color: #667eea;
    }
    .node-status {
      padding: 5px 12px;
      border-radius: 20px;
      font-size: 0.85em;
      font-weight: bold;
    }
    .status-online {
      background: #10b981;
      color: white;
    }
    .status-offline {
      background: #ef4444;
      color: white;
    }
    .node-info {
      font-size: 0.9em;
      color: #666;
      margin-bottom: 15px;
    }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 10px;
    }
    .stat-item {
      padding: 8px;
      background: #f8f9fa;
      border-radius: 6px;
    }
    .stat-label {
      font-size: 0.75em;
      color: #999;
      margin-bottom: 3px;
    }
    .stat-value {
      font-size: 1.3em;
      font-weight: bold;
      color: #667eea;
    }
    .stat-value.good { color: #10b981; }
    .stat-value.warning { color: #f59e0b; }
    .stat-value.bad { color: #ef4444; }
    .loading {
      text-align: center;
      padding: 40px;
      color: white;
      font-size: 1.5em;
    }
    .refresh-info {
      text-align: center;
      color: white;
      margin-top: 20px;
      font-size: 0.9em;
    }
    .node-link {
      display: block;
      text-align: center;
      margin-top: 10px;
      padding: 8px;
      background: #667eea;
      color: white;
      text-decoration: none;
      border-radius: 6px;
      font-size: 0.9em;
      transition: background 0.3s;
    }
    .node-link:hover {
      background: #5568d3;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>🎛️ ZeroMaps RPC 统一管理面板</h1>
    <div class="summary">
      <span id="onlineCount">-</span> / <span id="totalCount">7</span> 节点在线 | 
      总请求: <span id="totalRequests">-</span> | 
      总QPS: <span id="totalQPS">-</span>
    </div>
    
    <div id="nodesGrid" class="grid">
      <div class="loading">正在加载节点数据...</div>
    </div>

    <div class="refresh-info">
      📡 自动刷新中 (每5秒) | 上次更新: <span id="lastUpdate">-</span>
    </div>
  </div>

  <script>
    function formatNumber(num) {
      if (!num && num !== 0) return '-';
      return num.toLocaleString('zh-CN');
    }

    async function fetchAllStats() {
      try {
        const response = await fetch('/api/all-stats');
        const data = await response.json();
        
        // 更新摘要
        document.getElementById('onlineCount').textContent = data.online;
        document.getElementById('totalCount').textContent = data.total;
        
        let totalRequests = 0;
        let totalQPS = 0;
        
        data.nodes.forEach(node => {
          if (node.status === 'online' && node.stats) {
            totalRequests += node.stats.requests.total || 0;
            totalQPS += node.stats.ipv6.qps || 0;
          }
        });
        
        document.getElementById('totalRequests').textContent = formatNumber(totalRequests);
        document.getElementById('totalQPS').textContent = totalQPS.toFixed(2);
        
        // 渲染节点卡片
        renderNodes(data.nodes);
        
        document.getElementById('lastUpdate').textContent = new Date().toLocaleTimeString('zh-CN');
      } catch (error) {
        console.error('获取统计数据失败:', error);
      }
    }

    function renderNodes(nodes) {
      const grid = document.getElementById('nodesGrid');
      
      grid.innerHTML = nodes.map(node => {
        const isOnline = node.status === 'online';
        const stats = node.stats;
        
        if (!isOnline) {
          return \`
            <div class="node-card offline">
              <div class="node-header">
                <div class="node-name">\${node.name}</div>
                <span class="node-status status-offline">离线</span>
              </div>
              <div class="node-info">
                \${node.domain}<br>
                \${node.ip}
              </div>
              <div style="text-align: center; color: #999; padding: 20px;">
                \${node.error || '无法连接到服务器'}
              </div>
              <a href="\${node.monitorUrl}" target="_blank" class="node-link">查看详情 →</a>
            </div>
          \`;
        }
        
        const successRate = stats.ipv6.successRate || 0;
        const successClass = successRate >= 99 ? 'good' : (successRate >= 95 ? 'warning' : 'bad');
        
        return \`
          <div class="node-card online">
            <div class="node-header">
              <div class="node-name">\${node.name}</div>
              <span class="node-status status-online">在线</span>
            </div>
            <div class="node-info">
              \${node.domain}<br>
              \${node.ip}
            </div>
            <div class="stats-grid">
              <div class="stat-item">
                <div class="stat-label">客户端</div>
                <div class="stat-value">\${formatNumber(stats.clients)}</div>
              </div>
              <div class="stat-item">
                <div class="stat-label">总请求</div>
                <div class="stat-value">\${formatNumber(stats.requests.total)}</div>
              </div>
              <div class="stat-item">
                <div class="stat-label">当前并发</div>
                <div class="stat-value">\${stats.requests.concurrent}</div>
              </div>
              <div class="stat-item">
                <div class="stat-label">QPS</div>
                <div class="stat-value">\${stats.ipv6.qps.toFixed(2)}</div>
              </div>
              <div class="stat-item">
                <div class="stat-label">成功率</div>
                <div class="stat-value \${successClass}">\${successRate.toFixed(2)}%</div>
              </div>
              <div class="stat-item">
                <div class="stat-label">平均RT</div>
                <div class="stat-value">\${stats.ipv6.avgResponseTime}ms</div>
              </div>
              <div class="stat-item">
                <div class="stat-label">IPv6池</div>
                <div class="stat-value">\${stats.ipv6.total}</div>
              </div>
              <div class="stat-item">
                <div class="stat-label">平衡度</div>
                <div class="stat-value">\${stats.ipv6.balance}</div>
              </div>
            </div>
            <a href="\${node.monitorUrl}" target="_blank" class="node-link">查看详情 →</a>
          </div>
        \`;
      }).join('');
    }

    // 初始加载
    fetchAllStats();

    // 每5秒自动刷新
    setInterval(fetchAllStats, 5000);
  </script>
</body>
</html>`;
  }

  /**
   * 停止服务器
   */
  public stop(): void {
    if (this.server) {
      this.server.close()
      console.log('✓ 管理面板服务器已停止')
    }
  }
}

