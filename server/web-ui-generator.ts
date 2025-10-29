/**
 * Web界面生成器模块
 * 负责生成管理面板的HTML、CSS和JavaScript代码
 */

export class WebUIGenerator {
    /**
     * 生成完整的HTML页面
     */
    public static generateHTML(): string {
        return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ZeroMaps RPC 统一管理面板</title>
    <style>
        ${this.generateCSS()}
    </style>
</head>
<body>
    <div class="container">
        <header class="header">
            <h1>🌍 ZeroMaps RPC 统一管理面板</h1>
            <div class="status-indicator">
                <span id="connection-status" class="status-disconnected">未连接</span>
                <span id="last-update">最后更新: --</span>
            </div>
        </header>

        <nav class="tabs">
            <button class="tab-button active" onclick="switchTab('stats')">📊 实时统计</button>
            <button class="tab-button" onclick="switchTab('ipv6')">🌐 IPv6 监控</button>
            <button class="tab-button" onclick="switchTab('logs')">📝 日志查看</button>
            <button class="tab-button" onclick="switchTab('config')">⚙️ 配置管理</button>
            <button class="tab-button" onclick="switchTab('fetch')">🚀 数据获取</button>
            <button class="tab-button" onclick="switchTab('nodes')">🌐 节点管理</button>
            <button class="tab-button" onclick="switchTab('ippool')">🌍 IP池同步</button>
        </nav>

        <main class="content">
            <!-- 实时统计页面 -->
            <div id="stats-tab" class="tab-content active">
                ${this.generateStatsTab()}
            </div>

            <!-- IPv6 监控页面 -->
            <div id="ipv6-tab" class="tab-content">
                ${this.generateIPv6Tab()}
            </div>

            <!-- 日志查看页面 -->
            <div id="logs-tab" class="tab-content">
                ${this.generateLogsTab()}
            </div>

            <!-- 配置管理页面 -->
            <div id="config-tab" class="tab-content">
                ${this.generateConfigTab()}
            </div>

            <!-- 数据获取页面 -->
            <div id="fetch-tab" class="tab-content">
                ${this.generateFetchTab()}
            </div>

            <!-- 节点管理页面 -->
            <div id="nodes-tab" class="tab-content">
                ${this.generateNodesTab()}
            </div>

            <!-- IP池同步页面 -->
            <div id="ippool-tab" class="tab-content">
                ${this.generateIPPoolTab()}
            </div>
        </main>
    </div>

    <script>
        ${this.generateJavaScript()}
    </script>
</body>
</html>`;
    }

    /**
     * 生成CSS样式
     */
    private static generateCSS(): string {
        return `
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            color: #333;
        }

        .container {
            max-width: 1400px;
            margin: 0 auto;
            padding: 20px;
        }

        .header {
            background: rgba(255, 255, 255, 0.95);
            padding: 20px;
            border-radius: 15px;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.1);
            backdrop-filter: blur(10px);
            margin-bottom: 20px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .header h1 {
            color: #2c3e50;
            font-size: 2.5em;
            font-weight: 700;
        }

        .status-indicator {
            display: flex;
            flex-direction: column;
            align-items: flex-end;
            gap: 5px;
        }

        .status-connected {
            color: #27ae60;
            font-weight: bold;
        }

        .status-disconnected {
            color: #e74c3c;
            font-weight: bold;
        }

        .tabs {
            display: flex;
            background: rgba(255, 255, 255, 0.9);
            border-radius: 15px;
            padding: 10px;
            margin-bottom: 20px;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.1);
            overflow-x: auto;
        }

        .tab-button {
            background: transparent;
            border: none;
            padding: 15px 25px;
            margin: 0 5px;
            border-radius: 10px;
            cursor: pointer;
            font-size: 16px;
            font-weight: 600;
            color: #666;
            transition: all 0.3s ease;
            white-space: nowrap;
        }

        .tab-button:hover {
            background: rgba(102, 126, 234, 0.1);
            color: #667eea;
        }

        .tab-button.active {
            background: linear-gradient(135deg, #667eea, #764ba2);
            color: white;
            box-shadow: 0 4px 15px rgba(102, 126, 234, 0.3);
        }

        .content {
            background: rgba(255, 255, 255, 0.95);
            border-radius: 15px;
            padding: 30px;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.1);
            backdrop-filter: blur(10px);
            min-height: 600px;
        }

        .tab-content {
            display: none;
        }

        .tab-content.active {
            display: block;
        }

        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 20px;
            margin-bottom: 30px;
        }

        .stat-card {
            background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
            color: white;
            padding: 25px;
            border-radius: 15px;
            box-shadow: 0 8px 25px rgba(0, 0, 0, 0.1);
            transition: transform 0.3s ease;
        }

        .stat-card:hover {
            transform: translateY(-5px);
        }

        .stat-card h3 {
            font-size: 1.2em;
            margin-bottom: 10px;
            opacity: 0.9;
        }

        .stat-value {
            font-size: 2.5em;
            font-weight: bold;
            margin-bottom: 5px;
        }

        .stat-label {
            font-size: 0.9em;
            opacity: 0.8;
        }

        .chart-container {
            background: white;
            border-radius: 15px;
            padding: 25px;
            margin-bottom: 20px;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.1);
        }

        .chart-title {
            font-size: 1.5em;
            font-weight: 600;
            margin-bottom: 20px;
            color: #2c3e50;
        }

        .chart {
            width: 100%;
            height: 300px;
            background: #f8f9fa;
            border-radius: 10px;
            display: flex;
            align-items: center;
            justify-content: center;
            color: #666;
            font-size: 1.1em;
            padding: 20px;
        }
        
        .simple-chart {
            width: 100%;
            height: 100%;
            display: flex;
            flex-direction: column;
            justify-content: center;
            align-items: center;
        }
        
        .chart-bar {
            width: 100%;
            max-width: 500px;
        }
        
        .bar-label {
            font-size: 1.2em;
            font-weight: 600;
            margin-bottom: 15px;
            text-align: center;
            color: #2c3e50;
        }
        
        .bar-container {
            width: 100%;
            height: 30px;
            background: #e9ecef;
            border-radius: 15px;
            overflow: hidden;
            display: flex;
            margin-bottom: 10px;
        }
        
        .bar-success {
            background: linear-gradient(90deg, #28a745, #20c997);
            height: 100%;
            transition: width 0.3s ease;
        }
        
        .bar-failure {
            background: linear-gradient(90deg, #dc3545, #fd7e14);
            height: 100%;
            transition: width 0.3s ease;
        }
        
        .bar-legend {
            display: flex;
            justify-content: space-between;
            font-size: 0.9em;
        }
        
        .legend-success {
            color: #28a745;
            font-weight: 600;
        }
        
        .legend-failure {
            color: #dc3545;
            font-weight: 600;
        }
        
        .chart-metrics {
            display: flex;
            gap: 30px;
            margin-bottom: 20px;
        }
        
        .metric-item {
            text-align: center;
        }
        
        .metric-label {
            font-size: 0.9em;
            color: #666;
            margin-bottom: 8px;
        }
        
        .metric-value {
            font-size: 1.8em;
            font-weight: bold;
            padding: 8px 16px;
            border-radius: 8px;
        }
        
        .metric-value.good {
            background: #d4edda;
            color: #155724;
        }
        
        .metric-value.warning {
            background: #fff3cd;
            color: #856404;
        }
        
        .metric-value.bad {
            background: #f8d7da;
            color: #721c24;
        }
        
        .chart-indicator {
            width: 100%;
            max-width: 400px;
        }
        
        .indicator-bar {
            width: 100%;
            height: 20px;
            background: #e9ecef;
            border-radius: 10px;
            overflow: hidden;
            margin-bottom: 8px;
        }
        
        .indicator-fill {
            height: 100%;
            background: linear-gradient(90deg, #dc3545, #ffc107, #28a745);
            transition: width 0.3s ease;
        }
        
        .indicator-labels {
            display: flex;
            justify-content: space-between;
            font-size: 0.8em;
            color: #666;
        }

        .button {
            background: linear-gradient(135deg, #667eea, #764ba2);
            color: white;
            border: none;
            padding: 12px 24px;
            border-radius: 8px;
            cursor: pointer;
            font-size: 14px;
            font-weight: 600;
            transition: all 0.3s ease;
            margin: 5px;
        }

        .button:hover {
            transform: translateY(-2px);
            box-shadow: 0 4px 15px rgba(102, 126, 234, 0.3);
        }

        .button:active {
            transform: translateY(0);
        }

        .button.danger {
            background: linear-gradient(135deg, #ff6b6b, #ee5a52);
        }

        .button.success {
            background: linear-gradient(135deg, #51cf66, #40c057);
        }

        .button.warning {
            background: linear-gradient(135deg, #ffd43b, #fab005);
        }

        .form-group {
            margin-bottom: 20px;
        }

        .form-group label {
            display: block;
            margin-bottom: 8px;
            font-weight: 600;
            color: #2c3e50;
        }

        .form-group input,
        .form-group textarea,
        .form-group select {
            width: 100%;
            padding: 12px;
            border: 2px solid #e9ecef;
            border-radius: 8px;
            font-size: 14px;
            transition: border-color 0.3s ease;
        }

        .form-group input:focus,
        .form-group textarea:focus,
        .form-group select:focus {
            outline: none;
            border-color: #667eea;
        }

        .table-container {
            background: white;
            border-radius: 15px;
            padding: 25px;
            margin-bottom: 20px;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.1);
            overflow-x: auto;
        }

        .table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 15px;
        }

        .table th,
        .table td {
            padding: 12px;
            text-align: left;
            border-bottom: 1px solid #e9ecef;
        }

        .table th {
            background: #f8f9fa;
            font-weight: 600;
            color: #2c3e50;
        }

        .table tr:hover {
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

        .status-warning {
            color: #f39c12;
            font-weight: bold;
        }

        .log-entry {
            padding: 10px;
            margin: 5px 0;
            border-radius: 8px;
            font-family: 'Courier New', monospace;
            font-size: 13px;
        }

        .log-info {
            background: #e3f2fd;
            color: #1976d2;
        }

        .log-warn {
            background: #fff3e0;
            color: #f57c00;
        }

        .log-error {
            background: #ffebee;
            color: #d32f2f;
        }

        .log-debug {
            background: #f3e5f5;
            color: #7b1fa2;
        }

        .node-card {
            background: white;
            border-radius: 15px;
            padding: 20px;
            margin-bottom: 15px;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.1);
            border-left: 5px solid #667eea;
        }

        .node-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 15px;
        }

        .node-name {
            font-size: 1.3em;
            font-weight: 600;
            color: #2c3e50;
        }

        .node-status {
            padding: 5px 15px;
            border-radius: 20px;
            font-size: 0.9em;
            font-weight: 600;
        }

        .node-details {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 15px;
            margin-top: 15px;
        }

        .node-detail {
            background: #f8f9fa;
            padding: 10px;
            border-radius: 8px;
        }

        .node-detail-label {
            font-size: 0.8em;
            color: #666;
            margin-bottom: 5px;
        }

        .node-detail-value {
            font-weight: 600;
            color: #2c3e50;
        }

        .health-check-stats {
            background: white;
            border-radius: 15px;
            padding: 25px;
            margin-bottom: 20px;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.1);
        }

        .health-status-container {
            background: white;
            border-radius: 15px;
            padding: 25px;
            margin-bottom: 20px;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.1);
        }

        .health-status-table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 15px;
        }

        .health-status-table th,
        .health-status-table td {
            padding: 12px;
            text-align: left;
            border-bottom: 1px solid #e9ecef;
        }

        .health-status-table th {
            background: #f8f9fa;
            font-weight: 600;
            color: #2c3e50;
        }

        .status-active {
            color: #27ae60;
            font-weight: bold;
        }

        .status-blacklisted {
            color: #e74c3c;
            font-weight: bold;
        }

        .status-testing {
            color: #f39c12;
            font-weight: bold;
        }

        .health-action-btn {
            padding: 6px 12px;
            margin: 2px;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
            font-weight: 600;
            transition: all 0.3s ease;
        }

        .health-action-btn.test {
            background: #3498db;
            color: white;
        }

        .health-action-btn.test:hover {
            background: #2980b9;
        }

        .health-action-btn.whitelist {
            background: #27ae60;
            color: white;
        }

        .health-action-btn.whitelist:hover {
            background: #229954;
        }

        .health-action-btn.blacklist {
            background: #e74c3c;
            color: white;
        }

        .health-action-btn.blacklist:hover {
            background: #c0392b;
        }

        .health-action-btn.clear {
            background: #95a5a6;
            color: white;
        }

        .health-action-btn.clear:hover {
            background: #7f8c8d;
        }

        @media (max-width: 768px) {
            .container {
                padding: 10px;
            }

            .header {
                flex-direction: column;
                text-align: center;
                gap: 15px;
            }

            .header h1 {
                font-size: 2em;
            }

            .tabs {
                flex-wrap: wrap;
            }

            .tab-button {
                flex: 1;
                min-width: 120px;
            }

            .stats-grid {
                grid-template-columns: 1fr;
            }

            .node-details {
                grid-template-columns: 1fr;
            }
        }
        `;
    }

    /**
     * 生成实时统计页面
     */
    private static generateStatsTab(): string {
        return `
            <div class="stats-grid">
                <div class="stat-card">
                    <h3>📊 总请求数</h3>
                    <div class="stat-value" id="total-requests">0</div>
                    <div class="stat-label">累计请求</div>
                </div>
                <div class="stat-card">
                    <h3>✅ 成功请求</h3>
                    <div class="stat-value" id="success-requests">0</div>
                    <div class="stat-label">成功率: <span id="success-rate">0%</span></div>
                </div>
                <div class="stat-card">
                    <h3>⚡ 平均响应时间</h3>
                    <div class="stat-value" id="avg-response-time">0ms</div>
                    <div class="stat-label">毫秒</div>
                </div>
                <div class="stat-card">
                    <h3>🌐 活跃连接</h3>
                    <div class="stat-value" id="active-connections">0</div>
                    <div class="stat-label">当前连接</div>
                </div>
            </div>

            <div class="chart-container">
                <h3 class="chart-title">📈 请求趋势</h3>
                <div class="chart" id="requests-chart">
                    图表加载中...
                </div>
            </div>

            <div class="chart-container">
                <h3 class="chart-title">⚡ 响应时间分布</h3>
                <div class="chart" id="response-time-chart">
                    图表加载中...
                </div>
            </div>
        `;
    }

    /**
     * 生成IPv6监控页面
     */
    private static generateIPv6Tab(): string {
        return `
            <div class="table-container">
                <h3>🌐 IPv6 地址池状态</h3>
                <button class="button" onclick="refreshIPv6Status()">🔄 刷新状态</button>
                <table class="table" id="ipv6-table">
                    <thead>
                        <tr>
                            <th>IPv6 地址</th>
                            <th>状态</th>
                            <th>最后使用</th>
                            <th>使用次数</th>
                            <th>成功率</th>
                        </tr>
                    </thead>
                    <tbody id="ipv6-tbody">
                        <tr>
                            <td colspan="5" style="text-align: center;">加载中...</td>
                        </tr>
                    </tbody>
                </table>
            </div>
        `;
    }

    /**
     * 生成日志查看页面
     */
    private static generateLogsTab(): string {
        return `
            <div class="form-group">
                <label for="log-level">日志级别:</label>
                <select id="log-level">
                    <option value="all">全部</option>
                    <option value="info">信息</option>
                    <option value="warn">警告</option>
                    <option value="error">错误</option>
                    <option value="debug">调试</option>
                </select>
            </div>

            <div class="form-group">
                <label for="log-lines">显示行数:</label>
                <select id="log-lines">
                    <option value="50">50 行</option>
                    <option value="100" selected>100 行</option>
                    <option value="200">200 行</option>
                    <option value="500">500 行</option>
                </select>
            </div>

            <button class="button" onclick="refreshLogs()">🔄 刷新日志</button>
            <button class="button" onclick="clearLogs()">🗑️ 清空日志</button>

            <div id="logs-container" style="margin-top: 20px;">
                <div class="log-entry log-info">正在加载日志...</div>
            </div>
        `;
    }

    /**
     * 生成配置管理页面
     */
    private static generateConfigTab(): string {
        return `
            <div class="form-group">
                <label for="config-content">配置文件内容:</label>
                <textarea id="config-content" rows="20" style="font-family: 'Courier New', monospace;"></textarea>
            </div>

            <button class="button" onclick="loadConfig()">📥 加载配置</button>
            <button class="button success" onclick="saveConfig()">💾 保存配置</button>
            <button class="button warning" onclick="restartService()">🔄 重启服务</button>

            <div id="config-status" style="margin-top: 15px; padding: 10px; border-radius: 8px; display: none;"></div>
        `;
    }

    /**
     * 生成数据获取页面
     */
    private static generateFetchTab(): string {
        return `
            <div class="form-group">
                <label for="fetch-url">请求URL:</label>
                <input type="text" id="fetch-url" placeholder="https://kh.google.com/rt/earth/PlanetoidMetadata" value="https://kh.google.com/rt/earth/PlanetoidMetadata">
            </div>

            <div class="form-group">
                <label for="fetch-headers">请求头 (JSON格式):</label>
                <textarea id="fetch-headers" rows="5" placeholder='{"Host": "kh.google.com", "User-Agent": "Mozilla/5.0..."}'>{"Host": "kh.google.com", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}</textarea>
            </div>

            <div class="form-group">
                <label for="fetch-timeout">超时时间 (秒):</label>
                <input type="number" id="fetch-timeout" value="30" min="1" max="300">
            </div>

            <button class="button" onclick="executeFetch()">🚀 执行请求</button>
            <button class="button warning" onclick="clearFetchResult()">🗑️ 清空结果</button>

            <div id="fetch-result" style="margin-top: 20px; padding: 15px; background: #f8f9fa; border-radius: 8px; display: none;">
                <h4>请求结果:</h4>
                <pre id="fetch-result-content" style="white-space: pre-wrap; word-wrap: break-word;"></pre>
            </div>
        `;
    }

    /**
     * 生成节点管理页面
     */
    private static generateNodesTab(): string {
        return `
            <div class="form-group">
                <h3>🌐 节点管理</h3>
                <button class="button" onclick="refreshNodes()">🔄 刷新节点</button>
                <button class="button success" onclick="showAddNodeForm()">➕ 添加节点</button>
            </div>

            <div id="add-node-form" style="display: none; background: #f8f9fa; padding: 20px; border-radius: 10px; margin-bottom: 20px;">
                <h4>添加新节点</h4>
                <div class="form-group">
                    <label for="node-name">节点名称:</label>
                    <input type="text" id="node-name" placeholder="tile1">
                </div>
                <div class="form-group">
                    <label for="node-host">主机地址:</label>
                    <input type="text" id="node-host" placeholder="192.168.1.100">
                </div>
                <div class="form-group">
                    <label for="node-port">端口:</label>
                    <input type="number" id="node-port" value="9527" min="1" max="65535">
                </div>
                <div class="form-group">
                    <label for="node-description">描述:</label>
                    <input type="text" id="node-description" placeholder="节点描述">
                </div>
                <button class="button success" onclick="addNode()">✅ 添加节点</button>
                <button class="button" onclick="hideAddNodeForm()">❌ 取消</button>
            </div>

            <div id="nodes-container">
                <div class="log-entry log-info">正在加载节点信息...</div>
            </div>
        `;
    }

    /**
     * 生成IP池同步页面
     */
    private static generateIPPoolTab(): string {
        return `
            <div class="form-group">
                <h3>🌍 IP池同步管理</h3>
                <button class="button" onclick="refreshIPPoolData()">🔄 刷新数据</button>
                <button class="button success" onclick="triggerSync()">🔄 触发同步</button>
                <button class="button warning" onclick="exportIPPoolData()">📤 导出数据</button>
                <button class="button" onclick="viewIPPoolDetails()">👁️ 查看详情</button>
            </div>

            <div class="health-check-stats">
                <h4>健康检查统计</h4>
                <div id="health-check-stats">
                    <div class="log-entry log-info">正在加载健康检查统计...</div>
                </div>
                <button class="button success" onclick="startHealthCheck()">启动健康检查</button>
                <button class="button danger" onclick="stopHealthCheck()">停止健康检查</button>
                <button class="button" onclick="refreshHealthStatus()">刷新健康状态</button>
            </div>

            <div class="health-status-container">
                <h4>IP健康状态</h4>
                <table class="health-status-table" id="health-status-table">
                    <thead>
                        <tr>
                            <th>IP地址</th>
                            <th>状态</th>
                            <th>总请求</th>
                            <th>成功</th>
                            <th>失败</th>
                            <th>成功率</th>
                            <th>平均响应时间</th>
                            <th>最后成功</th>
                            <th>最后失败</th>
                            <th>操作</th>
                        </tr>
                    </thead>
                    <tbody id="health-status-tbody">
                        <tr>
                            <td colspan="10" style="text-align: center;">正在加载...</td>
                        </tr>
                    </tbody>
                </table>
            </div>

            <div id="ip-pool-details" style="display: none; background: #f8f9fa; padding: 20px; border-radius: 10px; margin-top: 20px;">
                <h4>IP池详细信息</h4>
                <pre id="ip-pool-details-content" style="white-space: pre-wrap; word-wrap: break-word;"></pre>
            </div>
        `;
    }

    /**
     * 生成JavaScript代码
     */
    private static generateJavaScript(): string {
        return `
        // 全局变量
        let ws = null;
        let reconnectInterval = null;
        let statsData = {
            totalRequests: 0,
            successRequests: 0,
            avgResponseTime: 0,
            activeConnections: 0
        };
        let nodesData = [];
        let ipPoolData = null;
        let healthCheckStats = null;
        let healthStatuses = [];

        // WebSocket连接
        function connectWebSocket() {
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const wsUrl = \`\${protocol}//\${window.location.host}/ws\`;
            
            try {
                ws = new WebSocket(wsUrl);
                
                ws.onopen = function() {
                    console.log('WebSocket连接已建立');
                    updateConnectionStatus(true);
                    clearInterval(reconnectInterval);
                    reconnectInterval = null;
                    
                    // 连接成功后立即获取统计数据
                    fetchStats();
                };
                
                ws.onmessage = function(event) {
                    try {
                        const data = JSON.parse(event.data);
                        handleWebSocketMessage(data);
                    } catch (e) {
                        console.error('解析WebSocket消息失败:', e);
                    }
                };
                
                ws.onclose = function() {
                    console.log('WebSocket连接已关闭');
                    updateConnectionStatus(false);
                    
                    // 尝试重连
                    if (!reconnectInterval) {
                        reconnectInterval = setInterval(connectWebSocket, 5000);
                    }
                };
                
                ws.onerror = function(error) {
                    console.error('WebSocket错误:', error);
                    updateConnectionStatus(false);
                };
            } catch (e) {
                console.error('创建WebSocket连接失败:', e);
                updateConnectionStatus(false);
            }
        }

        // 处理WebSocket消息
        function handleWebSocketMessage(data) {
            switch (data.type) {
                case 'stats':
                    updateStatsDisplay(data.data);
                    break;
                case 'log':
                    addLogEntry(data.data);
                    break;
                case 'ipv6':
                    updateIPv6Display(data.data);
                    break;
                case 'nodes':
                    updateNodesDisplay(data.data);
                    break;
                case 'ip-pool':
                    updateIPPoolDisplay(data.data);
                    break;
                case 'health-check':
                    updateHealthCheckDisplay(data.data);
                    break;
                default:
                    console.log('未知消息类型:', data.type);
            }
        }

        // 更新连接状态
        function updateConnectionStatus(connected) {
            const statusElement = document.getElementById('connection-status');
            const lastUpdateElement = document.getElementById('last-update');
            
            if (connected) {
                statusElement.textContent = '已连接';
                statusElement.className = 'status-connected';
                lastUpdateElement.textContent = \`最后更新: \${new Date().toLocaleTimeString()}\`;
            } else {
                statusElement.textContent = '未连接';
                statusElement.className = 'status-disconnected';
            }
        }

        // 获取统计数据
        async function fetchStats() {
            try {
                const response = await fetch('/api/stats');
                const data = await response.json();
                updateStatsDisplay(data);
            } catch (error) {
                console.error('获取统计数据失败:', error);
            }
        }

        // 更新统计显示
        function updateStatsDisplay(data) {
            statsData = data;
            
            // 映射 API 数据结构到页面显示
            const totalRequests = data.requests?.total || 0;
            const successRequests = data.ipv6?.totalSuccess || 0;
            const avgResponseTime = data.ipv6?.avgResponseTime || 0;
            const activeConnections = data.clients || 0;
            
            document.getElementById('total-requests').textContent = totalRequests;
            document.getElementById('success-requests').textContent = successRequests;
            document.getElementById('avg-response-time').textContent = \`\${avgResponseTime}ms\`;
            document.getElementById('active-connections').textContent = activeConnections;
            
            const successRate = data.ipv6?.successRate || 0;
            document.getElementById('success-rate').textContent = \`\${successRate.toFixed(1)}%\`;
            
            updateConnectionStatus(true);
            
            // 更新图表
            updateCharts(data);
        }
        
        // 更新图表显示
        function updateCharts(data) {
            updateRequestsChart(data);
            updateResponseTimeChart(data);
        }
        
        // 更新请求趋势图表
        function updateRequestsChart(data) {
            const chartElement = document.getElementById('requests-chart');
            if (!chartElement) return;
            
            const totalRequests = data.requests?.total || 0;
            const successRequests = data.ipv6?.totalSuccess || 0;
            const failureRequests = totalRequests - successRequests;
            
            // 简单的文本图表
            chartElement.innerHTML = \`
                <div class="simple-chart">
                    <div class="chart-bar">
                        <div class="bar-label">总请求: \${totalRequests}</div>
                        <div class="bar-container">
                            <div class="bar-success" style="width: \${totalRequests > 0 ? (successRequests / totalRequests * 100) : 0}%"></div>
                            <div class="bar-failure" style="width: \${totalRequests > 0 ? (failureRequests / totalRequests * 100) : 0}%"></div>
                        </div>
                        <div class="bar-legend">
                            <span class="legend-success">✅ 成功: \${successRequests}</span>
                            <span class="legend-failure">❌ 失败: \${failureRequests}</span>
                        </div>
                    </div>
                </div>
            \`;
        }
        
        // 更新响应时间分布图表
        function updateResponseTimeChart(data) {
            const chartElement = document.getElementById('response-time-chart');
            if (!chartElement) return;
            
            const avgResponseTime = data.ipv6?.avgResponseTime || 0;
            const successRate = data.ipv6?.successRate || 0;
            
            // 简单的文本图表
            chartElement.innerHTML = \`
                <div class="simple-chart">
                    <div class="chart-metrics">
                        <div class="metric-item">
                            <div class="metric-label">平均响应时间</div>
                            <div class="metric-value \${avgResponseTime < 1000 ? 'good' : avgResponseTime < 3000 ? 'warning' : 'bad'}">\${avgResponseTime}ms</div>
                        </div>
                        <div class="metric-item">
                            <div class="metric-label">成功率</div>
                            <div class="metric-value \${successRate > 80 ? 'good' : successRate > 50 ? 'warning' : 'bad'}">\${successRate.toFixed(1)}%</div>
                        </div>
                    </div>
                    <div class="chart-indicator">
                        <div class="indicator-bar">
                            <div class="indicator-fill" style="width: \${Math.min(successRate, 100)}%"></div>
                        </div>
                        <div class="indicator-labels">
                            <span>0%</span>
                            <span>50%</span>
                            <span>100%</span>
                        </div>
                    </div>
                </div>
            \`;
        }

        // 切换标签页
        function switchTab(tabName) {
            // 隐藏所有标签页内容
            const tabContents = document.querySelectorAll('.tab-content');
            tabContents.forEach(tab => tab.classList.remove('active'));
            
            // 移除所有标签按钮的激活状态
            const tabButtons = document.querySelectorAll('.tab-button');
            tabButtons.forEach(btn => btn.classList.remove('active'));
            
            // 显示选中的标签页内容
            document.getElementById(\`\${tabName}-tab\`).classList.add('active');
            
            // 激活对应的标签按钮
            event.target.classList.add('active');
            
            // 根据标签页加载相应数据
            switch (tabName) {
                case 'stats':
                    fetchStats();
                    break;
                case 'ipv6':
                    refreshIPv6Status();
                    break;
                case 'logs':
                    refreshLogs();
                    break;
                case 'config':
                    loadConfig();
                    break;
                case 'nodes':
                    refreshNodes();
                    break;
                case 'ippool':
                    refreshIPPoolData();
                    refreshHealthStatus();
                    break;
            }
        }

        // IPv6相关函数
        async function refreshIPv6Status() {
            try {
                const response = await fetch('/api/ipv6');
                const data = await response.json();
                updateIPv6Display(data);
            } catch (error) {
                console.error('获取IPv6状态失败:', error);
            }
        }

        function updateIPv6Display(data) {
            const tbody = document.getElementById('ipv6-tbody');
            if (!tbody) return;
            
            if (!data || !data.addresses || data.addresses.length === 0) {
                tbody.innerHTML = '<tr><td colspan="5" style="text-align: center;">暂无IPv6数据</td></tr>';
                return;
            }
            
            // 显示前20个地址
            const addresses = data.addresses.slice(0, 20);
            tbody.innerHTML = addresses.map(addr => \`
                <tr>
                    <td><code>\${addr}</code></td>
                    <td><span class="status-active">active</span></td>
                    <td>--</td>
                    <td>0</td>
                    <td>0%</td>
                </tr>
            \`).join('');
            
            // 更新统计信息
            if (data.stats) {
                const stats = data.stats;
                document.getElementById('ipv6-total').textContent = stats.totalAddresses || 0;
                document.getElementById('ipv6-active').textContent = stats.totalSuccess || 0;
                document.getElementById('ipv6-blacklisted').textContent = stats.totalFailure || 0;
                document.getElementById('ipv6-testing').textContent = '0';
            }
        }

        // 日志相关函数
        async function refreshLogs() {
            const level = document.getElementById('log-level').value;
            const lines = document.getElementById('log-lines').value;
            
            try {
                const response = await fetch(\`/api/logs?level=\${level}&lines=\${lines}\`);
                const data = await response.json();
                updateLogsDisplay(data);
            } catch (error) {
                console.error('获取日志失败:', error);
            }
        }

        function updateLogsDisplay(data) {
            const container = document.getElementById('logs-container');
            if (!container) return;
            
            if (!data || !data.logs || data.logs.length === 0) {
                container.innerHTML = '<div class="log-entry log-info">暂无日志数据</div>';
                return;
            }
            
            container.innerHTML = data.logs.map(logStr => {
                try {
                    const log = JSON.parse(logStr);
                    return \`<div class="log-entry log-\${log.level}">
                        [\${log.timestamp}] \${log.message}
                        \${log.context ? \`<br><small>上下文: \${JSON.stringify(log.context)}</small>\` : ''}
                    </div>\`;
                } catch (e) {
                    return \`<div class="log-entry log-error">解析日志失败: \${logStr}</div>\`;
                }
            }).join('');
        }

        function addLogEntry(log) {
            const container = document.getElementById('logs-container');
            if (!container) return;
            
            const logElement = document.createElement('div');
            logElement.className = \`log-entry log-\${log.level}\`;
            logElement.textContent = \`[\${log.timestamp}] \${log.message}\`;
            
            container.insertBefore(logElement, container.firstChild);
            
            // 保持最多100条日志
            while (container.children.length > 100) {
                container.removeChild(container.lastChild);
            }
        }

        async function clearLogs() {
            try {
                await fetch('/api/logs', { method: 'DELETE' });
                document.getElementById('logs-container').innerHTML = '<div class="log-entry log-info">日志已清空</div>';
            } catch (error) {
                console.error('清空日志失败:', error);
                alert('清空日志失败: ' + error.message);
            }
        }

        // 配置相关函数
        async function loadConfig() {
            try {
                const response = await fetch('/api/config');
                const data = await response.json();
                document.getElementById('config-content').value = JSON.stringify(data, null, 2);
            } catch (error) {
                console.error('加载配置失败:', error);
                alert('加载配置失败: ' + error.message);
            }
        }

        async function saveConfig() {
            try {
                const configText = document.getElementById('config-content').value;
                const config = JSON.parse(configText);
                
                const response = await fetch('/api/config', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(config)
                });
                
                if (response.ok) {
                    showConfigStatus('配置保存成功', 'success');
                } else {
                    throw new Error('保存失败');
                }
            } catch (error) {
                console.error('保存配置失败:', error);
                showConfigStatus('保存配置失败: ' + error.message, 'error');
            }
        }

        function showConfigStatus(message, type) {
            const statusElement = document.getElementById('config-status');
            statusElement.textContent = message;
            statusElement.className = \`log-entry log-\${type}\`;
            statusElement.style.display = 'block';
            
            setTimeout(() => {
                statusElement.style.display = 'none';
            }, 3000);
        }

        async function restartService() {
            if (confirm('确定要重启服务吗？')) {
                try {
                    await fetch('/api/restart', { method: 'POST' });
                    showConfigStatus('服务重启中...', 'info');
                } catch (error) {
                    console.error('重启服务失败:', error);
                    showConfigStatus('重启服务失败: ' + error.message, 'error');
                }
            }
        }

        // 数据获取相关函数
        async function executeFetch() {
            const url = document.getElementById('fetch-url').value;
            const headersText = document.getElementById('fetch-headers').value;
            const timeout = parseInt(document.getElementById('fetch-timeout').value);
            
            if (!url) {
                alert('请输入请求URL');
                return;
            }
            
            try {
                const headers = headersText ? JSON.parse(headersText) : {};
                
                const response = await fetch('/api/fetch', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ url, headers, timeout })
                });
                
                const result = await response.json();
                showFetchResult(result);
            } catch (error) {
                console.error('执行请求失败:', error);
                showFetchResult({ error: error.message });
            }
        }

        function showFetchResult(result) {
            const resultElement = document.getElementById('fetch-result');
            const contentElement = document.getElementById('fetch-result-content');
            
            contentElement.textContent = JSON.stringify(result, null, 2);
            resultElement.style.display = 'block';
        }

        function clearFetchResult() {
            document.getElementById('fetch-result').style.display = 'none';
        }

        // 节点管理相关函数
        async function refreshNodes() {
            try {
                const response = await fetch('/api/nodes');
                const data = await response.json();
                updateNodesDisplay(data);
            } catch (error) {
                console.error('获取节点信息失败:', error);
            }
        }

        function updateNodesDisplay(data) {
            const container = document.getElementById('nodes-container');
            if (!container) return;
            
            // 处理 API 返回的数据结构
            const nodes = data.nodes || data;
            const health = data.health || [];
            const stats = data.stats || {};
            
            nodesData = nodes;
            
            if (!nodes || nodes.length === 0) {
                container.innerHTML = '<div class="log-entry log-info">暂无节点数据</div>';
                return;
            }
            
            // 创建健康状态映射
            const healthMap = {};
            health.forEach(h => {
                healthMap[h.nodeId] = h;
            });
            
            container.innerHTML = nodes.map(node => {
                const nodeHealth = healthMap[node.id] || {};
                const lastCheck = nodeHealth.timestamp ? new Date(nodeHealth.timestamp).toLocaleString() : '未知';
                const responseTime = nodeHealth.responseTime || 0;
                
                return \`
                    <div class="node-card">
                        <div class="node-header">
                            <div class="node-name">\${node.name}</div>
                            <div class="node-status status-\${node.status}">\${node.status}</div>
                        </div>
                        <div class="node-details">
                            <div class="node-detail">
                                <div class="node-detail-label">域名</div>
                                <div class="node-detail-value">\${node.domain}</div>
                            </div>
                            <div class="node-detail">
                                <div class="node-detail-label">IPv4</div>
                                <div class="node-detail-value">\${node.ipv4}</div>
                            </div>
                            <div class="node-detail">
                                <div class="node-detail-label">IPv6前缀</div>
                                <div class="node-detail-value">\${node.ipv6Prefix || 'N/A'}</div>
                            </div>
                            <div class="node-detail">
                                <div class="node-detail-label">位置</div>
                                <div class="node-detail-value">\${node.location || 'N/A'}</div>
                            </div>
                            <div class="node-detail">
                                <div class="node-detail-label">最后检查</div>
                                <div class="node-detail-value">\${lastCheck}</div>
                            </div>
                            <div class="node-detail">
                                <div class="node-detail-label">响应时间</div>
                                <div class="node-detail-value">\${responseTime}ms</div>
                            </div>
                        </div>
                        <div style="margin-top: 15px;">
                            <button class="button \${node.enabled ? 'warning' : 'success'}" 
                                    onclick="toggleNode('\${node.name}')">
                                \${node.enabled ? '禁用' : '启用'}
                            </button>
                            <button class="button danger" onclick="deleteNode('\${node.name}')">删除</button>
                        </div>
                    </div>
                \`;
            }).join('');
            
            // 更新统计信息
            if (stats.total !== undefined) {
                const statsInfo = \`总节点: \${stats.total} | 在线: \${stats.online} | 离线: \${stats.offline} | 启用: \${stats.enabled} | 禁用: \${stats.disabled}\`;
                const statsElement = document.getElementById('nodes-stats');
                if (statsElement) {
                    statsElement.textContent = statsInfo;
                } else {
                    // 如果没有统计元素，在容器顶部添加
                    container.insertAdjacentHTML('afterbegin', \`
                        <div class="log-entry log-info" id="nodes-stats">\${statsInfo}</div>
                    \`);
                }
            }
        }

        function showAddNodeForm() {
            document.getElementById('add-node-form').style.display = 'block';
        }

        function hideAddNodeForm() {
            document.getElementById('add-node-form').style.display = 'none';
            // 清空表单
            document.getElementById('node-name').value = '';
            document.getElementById('node-host').value = '';
            document.getElementById('node-port').value = '9527';
            document.getElementById('node-description').value = '';
        }

        async function addNode() {
            const name = document.getElementById('node-name').value.trim();
            const host = document.getElementById('node-host').value.trim();
            const port = parseInt(document.getElementById('node-port').value);
            const description = document.getElementById('node-description').value.trim();
            
            if (!name || !host || !port) {
                alert('请填写完整的节点信息');
                return;
            }
            
            try {
                const response = await fetch('/api/nodes', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name, host, port, description })
                });
                
                if (response.ok) {
                    hideAddNodeForm();
                    refreshNodes();
                } else {
                    const error = await response.json();
                    throw new Error(error.message || '添加节点失败');
                }
            } catch (error) {
                console.error('添加节点失败:', error);
                alert('添加节点失败: ' + error.message);
            }
        }

        async function toggleNode(nodeName) {
            try {
                const response = await fetch(\`/api/nodes/\${nodeName}\`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ enabled: !nodesData.find(n => n.name === nodeName).enabled })
                });
                
                if (response.ok) {
                    refreshNodes();
                } else {
                    const error = await response.json();
                    throw new Error(error.message || '切换节点状态失败');
                }
            } catch (error) {
                console.error('切换节点状态失败:', error);
                alert('切换节点状态失败: ' + error.message);
            }
        }

        async function deleteNode(nodeName) {
            if (confirm(\`确定要删除节点 "\${nodeName}" 吗？\`)) {
                try {
                    const response = await fetch(\`/api/nodes/\${nodeName}\`, {
                        method: 'DELETE'
                    });
                    
                    if (response.ok) {
                        refreshNodes();
                    } else {
                        const error = await response.json();
                        throw new Error(error.message || '删除节点失败');
                    }
                } catch (error) {
                    console.error('删除节点失败:', error);
                    alert('删除节点失败: ' + error.message);
                }
            }
        }

        // IP池同步相关函数
        async function refreshIPPoolData() {
            try {
                const response = await fetch('/api/ip-pool/data');
                const data = await response.json();
                updateIPPoolDisplay(data);
            } catch (error) {
                console.error('获取IP池数据失败:', error);
            }
        }

        function updateIPPoolDisplay(data) {
            ipPoolData = data;
            
            // 更新健康检查统计
            const statsContainer = document.getElementById('health-check-stats');
            if (statsContainer && data.domains) {
                let totalIPs = 0;
                let activeIPs = 0;
                let blacklistedIPs = 0;
                let testingIPs = 0;
                
                Object.values(data.domains).forEach(domain => {
                    if (domain.ipv4) totalIPs += domain.ipv4.length;
                    if (domain.ipv6) totalIPs += domain.ipv6.length;
                    if (domain.blacklist) blacklistedIPs += domain.blacklist.length;
                    
                    // 统计健康状态
                    if (domain.health) {
                        Object.values(domain.health).forEach(health => {
                            if (health.totalRequests > 0) {
                                if (health.successCount > 0) {
                                    activeIPs++;
                                } else {
                                    testingIPs++;
                                }
                            }
                        });
                    }
                });
                
                statsContainer.innerHTML = \`
                    <div class="log-entry log-info">
                        <strong>总IP数:</strong> \${totalIPs} | 
                        <strong>活跃IP:</strong> \${activeIPs} | 
                        <strong>黑名单IP:</strong> \${blacklistedIPs} | 
                        <strong>测试中IP:</strong> \${testingIPs}
                    </div>
                \`;
            }
            
            // 更新健康状态表格
            updateHealthStatusTable(data);
        }
        
        function updateHealthStatusTable(data) {
            const tbody = document.getElementById('health-status-tbody');
            if (!tbody) return;
            
            // 处理数组格式的数据
            const healthData = Array.isArray(data) ? data : [];
            
            if (healthData.length === 0) {
                tbody.innerHTML = '<tr><td colspan="10" style="text-align: center;">暂无健康检查数据</td></tr>';
                return;
            }
            
            // 格式化时间戳
            const formatTimestamp = (timestamp) => {
                if (!timestamp) return '--';
                try {
                    const date = new Date(timestamp);
                    return date.toLocaleString('zh-CN', {
                        year: 'numeric',
                        month: '2-digit',
                        day: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit'
                    });
                } catch (e) {
                    return '--';
                }
            };
            
            // 格式化 IP 地址显示
            const formatIP = (ip) => {
                if (ip.length > 20) {
                    return \`<span title="\${ip}">\${ip.substring(0, 17)}...</span>\`;
                }
                return ip;
            };
            
            // 格式化响应时间
            const formatResponseTime = (time) => {
                if (!time || time === 0) return '--';
                return \`\${time.toFixed(1)}ms\`;
            };
            
            const rows = healthData.map(health => {
                const successRate = health.totalTests > 0 ? 
                    ((health.totalTests - health.consecutiveFailures) / health.totalTests * 100).toFixed(1) : 0;
                
                // 根据状态和成功次数判断显示状态
                const displayStatus = health.status === 'active' && health.consecutiveSuccesses > 0 ? 'active' : 'blacklisted';
                
                return \`
                    <tr>
                        <td>\${formatIP(health.ip)}</td>
                        <td><span class="status-\${displayStatus}">\${displayStatus}</span></td>
                        <td>\${health.totalTests}</td>
                        <td>\${health.consecutiveSuccesses}</td>
                        <td>\${health.consecutiveFailures}</td>
                        <td>\${successRate}%</td>
                        <td>\${formatResponseTime(health.avgResponseTime)}</td>
                        <td>\${formatTimestamp(health.lastSuccess)}</td>
                        <td>\${formatTimestamp(health.lastFailure)}</td>
                        <td>
                            <button class="button small" onclick="testIP('\${health.ip}')">测试</button>
                            <button class="button small success" onclick="whitelistIP('\${health.ip}')">白名单</button>
                            <button class="button small warning" onclick="blacklistIP('\${health.ip}')">黑名单</button>
                            <button class="button small danger" onclick="clearIPStats('\${health.ip}')">清空</button>
                        </td>
                    </tr>
                \`;
            });
            
            tbody.innerHTML = rows.join('');
        }

        async function triggerSync() {
            try {
                const response = await fetch('/api/ip-pool/trigger', { method: 'POST' });
                if (response.ok) {
                    alert('同步已触发');
                    refreshIPPoolData();
                } else {
                    throw new Error('触发同步失败');
                }
            } catch (error) {
                console.error('触发同步失败:', error);
                alert('触发同步失败: ' + error.message);
            }
        }

        async function exportIPPoolData() {
            try {
                const response = await fetch('/api/ip-pool/export');
                const data = await response.json();
                
                const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = \`ip-pool-\${new Date().toISOString().split('T')[0]}.json\`;
                a.click();
                URL.revokeObjectURL(url);
            } catch (error) {
                console.error('导出IP池数据失败:', error);
                alert('导出IP池数据失败: ' + error.message);
            }
        }

        function viewIPPoolDetails() {
            if (ipPoolData) {
                const detailsElement = document.getElementById('ip-pool-details');
                const contentElement = document.getElementById('ip-pool-details-content');
                
                contentElement.textContent = JSON.stringify(ipPoolData, null, 2);
                detailsElement.style.display = 'block';
            } else {
                alert('请先刷新IP池数据');
            }
        }

        // 健康检查相关函数
        async function refreshHealthStatus() {
            try {
                const response = await fetch('/api/ip-pool/health/stats');
                const stats = await response.json();
                updateHealthCheckStats(stats);
                
                const statusResponse = await fetch('/api/ip-pool/health/status');
                const statuses = await statusResponse.json();
                updateHealthStatusTable(statuses);
            } catch (error) {
                console.error('获取健康状态失败:', error);
            }
        }

        function updateHealthCheckStats(stats) {
            healthCheckStats = stats;
            const container = document.getElementById('health-check-stats');
            if (!container) return;
            
            container.innerHTML = \`
                <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px;">
                    <div style="background: #e3f2fd; padding: 15px; border-radius: 8px;">
                        <div style="font-size: 1.5em; font-weight: bold; color: #1976d2;">\${stats.totalIPs || 0}</div>
                        <div style="color: #666;">总IP数</div>
                    </div>
                    <div style="background: #e8f5e8; padding: 15px; border-radius: 8px;">
                        <div style="font-size: 1.5em; font-weight: bold; color: #27ae60;">\${stats.activeIPs || 0}</div>
                        <div style="color: #666;">活跃IP</div>
                    </div>
                    <div style="background: #ffebee; padding: 15px; border-radius: 8px;">
                        <div style="font-size: 1.5em; font-weight: bold; color: #e74c3c;">\${stats.blacklistedIPs || 0}</div>
                        <div style="color: #666;">黑名单IP</div>
                    </div>
                    <div style="background: #fff3e0; padding: 15px; border-radius: 8px;">
                        <div style="font-size: 1.5em; font-weight: bold; color: #f39c12;">\${stats.testingIPs || 0}</div>
                        <div style="color: #666;">测试中IP</div>
                    </div>
                </div>
            \`;
        }

        function updateHealthStatusTable(statuses) {
            healthStatuses = statuses;
            const tbody = document.getElementById('health-status-tbody');
            if (!tbody) return;
            
            if (!statuses || statuses.length === 0) {
                tbody.innerHTML = '<tr><td colspan="10" style="text-align: center;">暂无健康状态数据</td></tr>';
                return;
            }
            
            tbody.innerHTML = statuses.map(status => \`
                <tr>
                    <td>\${status.ip}</td>
                    <td><span class="status-\${status.status}">\${status.status}</span></td>
                    <td>\${status.totalRequests || 0}</td>
                    <td>\${status.successCount || 0}</td>
                    <td>\${status.failureCount || 0}</td>
                    <td>\${status.totalRequests > 0 ? ((status.successCount / status.totalRequests) * 100).toFixed(1) : 0}%</td>
                    <td>\${status.avgResponseTime || 0}ms</td>
                    <td>\${status.lastSuccess || '--'}</td>
                    <td>\${status.lastFailure || '--'}</td>
                    <td>
                        <button class="health-action-btn test" onclick="testIPManually('\${status.ip}')">测试</button>
                        <button class="health-action-btn whitelist" onclick="updateIPStatus('\${status.ip}', 'active')">白名单</button>
                        <button class="health-action-btn blacklist" onclick="updateIPStatus('\${status.ip}', 'blacklisted')">黑名单</button>
                        <button class="health-action-btn clear" onclick="clearIPStats('\${status.ip}')">清空</button>
                    </td>
                </tr>
            \`).join('');
        }

        function updateHealthCheckDisplay(data) {
            if (data.type === 'stats') {
                updateHealthCheckStats(data.data);
            } else if (data.type === 'status') {
                updateHealthStatusTable(data.data);
            }
        }

        async function startHealthCheck() {
            try {
                const response = await fetch('/api/ip-pool/health/start', { method: 'POST' });
                if (response.ok) {
                    alert('健康检查已启动');
                    refreshHealthStatus();
                } else {
                    throw new Error('启动健康检查失败');
                }
            } catch (error) {
                console.error('启动健康检查失败:', error);
                alert('启动健康检查失败: ' + error.message);
            }
        }

        async function stopHealthCheck() {
            try {
                const response = await fetch('/api/ip-pool/health/stop', { method: 'POST' });
                if (response.ok) {
                    alert('健康检查已停止');
                    refreshHealthStatus();
                } else {
                    throw new Error('停止健康检查失败');
                }
            } catch (error) {
                console.error('停止健康检查失败:', error);
                alert('停止健康检查失败: ' + error.message);
            }
        }

        async function testIPManually(ip) {
            try {
                const response = await fetch(\`/api/ip-pool/health/test/\${encodeURIComponent(ip)}\`, { method: 'POST' });
                if (response.ok) {
                    alert(\`IP \${ip} 测试已触发\`);
                    refreshHealthStatus();
                } else {
                    throw new Error('手动测试失败');
                }
            } catch (error) {
                console.error('手动测试失败:', error);
                alert('手动测试失败: ' + error.message);
            }
        }
        
        async function whitelistIP(ip) {
            try {
                const response = await fetch(\`/api/ip-pool/health/update-status/\${encodeURIComponent(ip)}\`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ status: 'active' })
                });
                
                if (response.ok) {
                    alert(\`IP \${ip} 已加入白名单\`);
                    refreshHealthStatus();
                } else {
                    throw new Error('加入白名单失败');
                }
            } catch (error) {
                console.error('加入白名单失败:', error);
                alert('加入白名单失败: ' + error.message);
            }
        }
        
        async function blacklistIP(ip) {
            try {
                const response = await fetch(\`/api/ip-pool/health/update-status/\${encodeURIComponent(ip)}\`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ status: 'blacklisted' })
                });
                
                if (response.ok) {
                    alert(\`IP \${ip} 已加入黑名单\`);
                    refreshHealthStatus();
                } else {
                    throw new Error('加入黑名单失败');
                }
            } catch (error) {
                console.error('加入黑名单失败:', error);
                alert('加入黑名单失败: ' + error.message);
            }
        }
        
        async function clearIPStats(ip) {
            if (confirm(\`确定要清空IP \${ip} 的统计数据吗？\`)) {
                try {
                    const response = await fetch(\`/api/ip-pool/health/clear-stats/\${encodeURIComponent(ip)}\`, { method: 'POST' });
                    if (response.ok) {
                        alert(\`IP \${ip} 统计数据已清空\`);
                        refreshHealthStatus();
                    } else {
                        throw new Error('清空统计数据失败');
                    }
                } catch (error) {
                    console.error('清空统计数据失败:', error);
                    alert('清空统计数据失败: ' + error.message);
                }
            }
        }

        async function updateIPStatus(ip, status) {
            try {
                const response = await fetch(\`/api/ip-pool/health/update-status/\${ip}\`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ status })
                });
                
                if (response.ok) {
                    alert(\`IP \${ip} 状态已更新为 \${status}\`);
                    refreshHealthStatus();
                } else {
                    throw new Error('更新IP状态失败');
                }
            } catch (error) {
                console.error('更新IP状态失败:', error);
                alert('更新IP状态失败: ' + error.message);
            }
        }

        async function clearIPStats(ip) {
            if (confirm(\`确定要清空IP \${ip} 的统计数据吗？\`)) {
                try {
                    const response = await fetch(\`/api/ip-pool/health/clear-stats/\${ip}\`, { method: 'POST' });
                    if (response.ok) {
                        alert(\`IP \${ip} 统计数据已清空\`);
                        refreshHealthStatus();
                    } else {
                        throw new Error('清空统计数据失败');
                    }
                } catch (error) {
                    console.error('清空统计数据失败:', error);
                    alert('清空统计数据失败: ' + error.message);
                }
            }
        }

        // 页面加载完成后初始化
        document.addEventListener('DOMContentLoaded', function() {
            console.log('ZeroMaps RPC 管理面板已加载');
            connectWebSocket();
            
            // 定期刷新统计数据（作为WebSocket的备用方案）
            setInterval(() => {
                if (!ws || ws.readyState !== WebSocket.OPEN) {
                    fetchStats();
                }
            }, 10000);
        });
        `;
    }
}
