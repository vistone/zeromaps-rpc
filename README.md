# ZeroMaps RPC Protocol

基于 IPv6 池和 curl-impersonate 的高性能 Google Earth 数据获取系统。

## 📋 目录

- [架构设计](#架构设计)
- [核心优势](#核心优势)
- [快速开始](#快速开始)
- [IPv6流量监控](#ipv6流量监控)
- [协议定义](#协议定义)
- [部署指南](#部署指南)

## 架构设计

```
客户端 (taskcli)
    ↓ RPC 请求: DataRequest { clientID, uri }
    ↓ ZeroMaps 协议传输（多节点自动分流）
    ↓
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
服务器端 (tile2/tile6/tile12)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    ↓ 接收 RPC 请求
    ↓ 组合完整 URL: https://kh.google.com/rt/earth/{uri}
    ↓ 轮询选择 IPv6 地址 (1000个IP池)
    ↓ curl-impersonate --interface <ipv6>
    ↓ Chrome 116 TLS 指纹 + 不同 IPv6
    ↓
kh.google.com (看到 1000 个不同的真实 Chrome)
```

## 核心优势

- ✅ **真实浏览器指纹** - curl-impersonate 完美模拟 Chrome 116
- ✅ **IPv6 地址池** - 每个服务器 1000 个不同 IPv6，避免封禁
- ✅ **负载均衡** - 轮询算法确保流量均匀分布
- ✅ **多节点分流** - 请求自动分散到多个服务器
- ✅ **极简协议** - 客户端只发送URI，服务器组装完整URL
- ✅ **完整监控** - 实时统计每个IPv6的使用情况和性能指标
- ✅ **已验证** - 基于成功获取 30 万条数据的实践经验

## 快速开始

### 安装依赖

```bash
npm install
```

### 启动服务器

```bash
# 开发模式
npm run server

# 生产模式（pm2）
pm2 start server/index.ts --name zeromaps-rpc --interpreter tsx

# 环境变量
IPV6_PREFIX=2607:8700:5500:2043 npm run server
```

### 客户端使用

```typescript
import { RpcClient } from 'zeromaps-rpc/client'

// 连接到服务器
const client = new RpcClient('tile2.zeromaps.cn', 9527)
await client.connect()

// 发起请求（只需传入URI）
const response = await client.fetchData('BulkMetadata/pb=!1m2!1s04!2u2699')

if (response.statusCode === 200) {
  console.log(`✓ 获取成功，数据大小: ${response.data.length} bytes`)
  // 保存数据
  saveToLocal(response.data)
}
```

## IPv6流量监控

### 🌐 Web监控界面（推荐）

服务器启动后会自动开启Web监控服务，直接在浏览器访问：

```
http://服务器IP:9528
```

**功能特性**：
- ✅ 实时数据自动刷新（每3秒）
- ✅ 8个可视化统计卡片
- ✅ Top 20 IPv6使用排行榜
- ✅ 成功率、QPS、响应时间等关键指标
- ✅ 美观的现代化界面
- ✅ 响应式设计，支持手机查看

**访问示例**：
```
http://tile12.zeromaps.cn:9528
```

**显示内容**：
- 在线客户端数
- 总请求数、当前并发、历史最大并发
- 请求速率（QPS）
- 成功率、成功/失败次数
- 平均响应时间
- IPv6地址池大小、平均每IP请求数
- 负载平衡度
- Top 20 IPv6地址详细统计

### 📊 命令行监控

服务器每60秒自动输出详细统计到日志：

```bash
# 查看实时日志
journalctl -u zeromaps-rpc -f

# 或使用 pm2
pm2 logs zeromaps-rpc
```

**输出示例：**
```
==================================================
📊 服务器统计
==================================================
👥 在线客户端: 10
📦 总请求数: 142318

🌐 IPv6 池统计:
  ├─ 总地址数: 100
  ├─ 总请求数: 142318
  ├─ 成功请求: 142100 (99.85%)
  ├─ 失败请求: 218
  ├─ 平均每IP: 1423 次
  ├─ 平衡度: 1 (差值)
  ├─ 平均响应时间: 245ms
  ├─ 运行时间: 2小时15分钟30秒
  └─ 请求速率: 17.52 req/s
==================================================
```

### 📊 API接口

Web监控服务器提供以下API：

#### 1. 获取总体统计
```bash
curl http://localhost:9528/api/stats
```

返回JSON格式的统计数据，包括：
- 在线客户端数
- 总请求数、当前并发、最大并发
- IPv6池统计（成功率、QPS、响应时间等）

#### 2. 获取IPv6详细统计
```bash
curl http://localhost:9528/api/ipv6
```

返回每个IPv6地址的详细使用情况（前100个）

### 📤 手动导出统计

#### 方法1：使用信号触发

```bash
# 获取进程ID
PID=$(pgrep -f "node.*server/index")

# 导出统计数据（生成JSON和CSV文件）
kill -SIGUSR1 $PID

# 显示所有1000个IPv6的详细统计
kill -SIGUSR2 $PID
```

导出文件：
- `ipv6-stats-<timestamp>.json` - JSON格式完整统计
- `ipv6-stats-<timestamp>.csv` - CSV格式（可用Excel分析）

#### 方法2：读取临时文件

服务器每10秒自动更新：

```bash
# 查看统计数据
cat /tmp/zeromaps-rpc-stats.json | jq .

# 查看摘要
cat /tmp/zeromaps-rpc-stats.json | jq .summary

# 查看特定IPv6
cat /tmp/zeromaps-rpc-stats.json | jq '.perIP[] | select(.address | contains("::1023"))'

# 实时监控QPS
watch -n 2 'cat /tmp/zeromaps-rpc-stats.json | jq -r ".summary | \"QPS: \(.requestsPerSecond) | 成功率: \(.successRate)%\""'
```

### 📈 统计指标说明

#### 总体指标

| 指标 | 说明 |
|-----|------|
| 总地址数 | IPv6池中的地址数量（默认100） |
| 总请求数 | 累计处理的请求总数 |
| 成功率 | 成功请求占比（目标>95%） |
| 平衡度 | 最大最小使用次数差值（越小越均衡） |
| 平均响应时间 | 所有请求的平均耗时(ms) |
| 请求速率 | 每秒处理的请求数(req/s) |

#### 单IP指标

每个IPv6地址的详细统计：
- 总请求数、成功次数、失败次数、成功率
- 平均/最小/最大响应时间
- 最后使用时间

### 🔍 监控场景示例

#### 检查负载均衡

```bash
# 查看平衡度（应该<5）
journalctl -u zeromaps-rpc --lines=50 | grep "平衡度"
```

#### 查找失败率高的IP

```bash
# 导出统计
kill -SIGUSR1 $(pgrep -f "node.*server/index")

# 分析失败IP
cat /tmp/zeromaps-rpc-stats.json | jq -r '.perIP[] | select(.failureCount > 0) | "\(.address) - 失败:\(.failureCount) 成功率:\(.successRate)%"'
```

#### 监控响应时间

```bash
# 查找慢请求IP
cat /tmp/zeromaps-rpc-stats.json | jq -r '.perIP[] | select(.avgResponseTime > 500) | "\(.address) - \(.avgResponseTime)ms"'
```

## 协议定义

### 请求格式

客户端只需发送URI字符串，服务器负责组装完整URL：

```protobuf
DataRequest {
  clientID: 1                    // 服务器分配的客户端ID
  uri: "BulkMetadata/pb=!1m2!1s04!2u2699"  // URI路径
}
```

**URI示例**：
- `PlanetoidMetadata` - 获取星球元数据
- `BulkMetadata/pb=!1m2!1s04!2u2699` - 获取BulkMetadata
- `NodeData/pb=!1m2!1s04!2u123` - 获取NodeData

服务器会自动拼接为完整URL：
```
https://kh.google.com/rt/earth/{uri}
```

### 响应格式

```protobuf
DataResponse {
  clientID: 1                              // 客户端ID
  uri: "BulkMetadata/pb=!1m2!1s04!2u2699" // 请求的URI
  data: <binary>                           // 二进制数据
  statusCode: 200                          // HTTP状态码
}
```

**状态码说明**：
- `200` - 成功
- `404` - 资源不存在
- `403` - 被拒绝（可能被封禁）
- `500` - 服务器错误
- `0` - 网络错误/超时

## 部署指南

### 服务器要求

- **操作系统**: Ubuntu 20.04+
- **IPv6支持**: 需要/64网段的IPv6地址（通过6in4隧道或原生IPv6）
- **IPv6地址池**: 1000个IPv6地址（::1001 到 ::2000）
- **curl-impersonate**: Chrome 116版本
- **Node.js**: 18+
- **端口**: 9527 (RPC) + 9528 (Web监控)

### IPv6配置说明

#### 你的IPv6配置解析

你使用的是 **6in4隧道**（SIT tunnel）来获得IPv6连接：

```bash
# 创建IPv6隧道
ip tunnel add ipv6net mode sit local 107.182.186.123 remote 45.32.66.87 ttl 255
ip link set ipv6net up

# 分配IPv6地址（你的主地址）
ip addr add 2607:8700:5500:2043::2/64 dev ipv6net

# 设置IPv6路由
ip route add ::/0 dev ipv6net
```

**配置说明：**
- `ipv6net` - 隧道接口名称
- `107.182.186.123` - 你VPS的IPv4地址
- `45.32.66.87` - 隧道服务商的IPv4地址
- `2607:8700:5500:2043::2/64` - 你的IPv6主地址
- **可用IPv6段**: `2607:8700:5500:2043::/64` （约18亿亿个地址）

#### 为RPC服务配置IPv6地址池

你需要在 `ipv6net` 接口上添加1000个额外的IPv6地址供RPC使用：

```bash
# 批量添加1000个IPv6地址（::1001 到 ::2000）
for i in {1001..2000}; do
  ip -6 addr add 2607:8700:5500:2043::$i/128 dev ipv6net
done

# 验证地址已添加
ip -6 addr show dev ipv6net | grep "2607:8700:5500:2043" | wc -l
# 应该显示 1001 (你的主地址::2 + 1000个新地址)
```

**测试IPv6连接：**

```bash
# 测试主地址
curl -6 https://api64.ipify.org
# 应该返回: 2607:8700:5500:2043::2

# 测试池中的地址
curl -6 --interface 2607:8700:5500:2043::1001 https://api64.ipify.org
# 应该返回: 2607:8700:5500:2043::1001
```

#### IPv6地址持久化

为了让IPv6池在重启后保持，创建启动脚本：

```bash
# 创建配置脚本
cat > /root/setup-ipv6-pool.sh << 'EOF'
#!/bin/bash
# 配置IPv6隧道（如果还没配置）
if ! ip link show ipv6net &>/dev/null; then
  ip tunnel add ipv6net mode sit local 107.182.186.123 remote 45.32.66.87 ttl 255
  ip link set ipv6net up
  ip addr add 2607:8700:5500:2043::2/64 dev ipv6net
  ip route add ::/0 dev ipv6net
fi

# 添加IPv6地址池
echo "配置IPv6地址池..."
for i in {1001..2000}; do
  ip -6 addr add 2607:8700:5500:2043::$i/128 dev ipv6net 2>/dev/null
done
echo "✓ IPv6池配置完成: 1000个地址"
EOF

chmod +x /root/setup-ipv6-pool.sh

# 创建systemd服务
cat > /etc/systemd/system/ipv6-pool.service << 'EOF'
[Unit]
Description=IPv6 Tunnel and Address Pool Setup
After=network.target

[Service]
Type=oneshot
ExecStart=/root/setup-ipv6-pool.sh
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF

# 启用服务
systemctl enable ipv6-pool
systemctl start ipv6-pool
systemctl status ipv6-pool
```

### 一键部署

```bash
# 使用你的IPv6前缀部署
./install.sh 2607:8700:5500:2043

# 或快速部署（需要手动配置IPv6）
./quick-deploy.sh
```

### 手动部署步骤

```bash
# 1. 配置IPv6隧道和地址池（见上面的配置说明）
/root/setup-ipv6-pool.sh

# 2. 安装curl-impersonate
wget https://github.com/lwthiker/curl-impersonate/releases/download/v0.6.1/curl-impersonate-v0.6.1.x86_64-linux-gnu.tar.gz
tar -xzf curl-impersonate-v0.6.1.x86_64-linux-gnu.tar.gz
cp curl_chrome116 /usr/local/bin/curl-impersonate-chrome
chmod +x /usr/local/bin/curl-impersonate-chrome

# 3. 安装项目依赖
cd /opt/zeromaps-rpc
npm install

# 4. 配置环境变量
export IPV6_PREFIX=2607:8700:5500:2043

# 5. 启动服务
pm2 start server/index.ts --name zeromaps-rpc --interpreter tsx

# 6. 设置开机启动
pm2 save
pm2 startup
```

### 环境变量

```bash
IPV6_PREFIX=2607:8700:5500:2043    # 你的IPv6前缀
RPC_PORT=9527                       # RPC端口（默认）
```

## 目录结构

```
zeromaps-rpc/
├── proto/                 # Protocol Buffers 定义
│   └── zeromaps-rpc.proto
├── client/                # 客户端 SDK
│   ├── rpc-client.ts
│   └── index.ts
├── server/                # 服务器端实现
│   ├── index.ts          # 启动入口（含监控）
│   ├── rpc-server.ts     # RPC服务器核心
│   ├── ipv6-pool.ts      # IPv6池管理（核心统计）
│   ├── curl-fetcher.ts   # Curl请求执行器
│   └── stats-exporter.ts # 统计导出工具
├── examples/              # 使用示例
│   └── basic-usage.ts
├── install.sh             # 完整安装脚本
├── quick-deploy.sh        # 快速部署脚本
└── README.md
```

## 故障排查

### 统计文件不存在

```bash
# 检查服务状态
systemctl status zeromaps-rpc

# 手动触发导出
kill -SIGUSR1 $(pgrep -f "node.*server/index")
```

### 平衡度很高（>10）

可能原因：某些IPv6不可用或网络问题

```bash
# 查看详细统计
kill -SIGUSR2 $(pgrep -f "node.*server/index")

# 测试IPv6连接
curl -6 --interface "2607:8700:5500:2043::1001" https://kh.google.com/
```

### 成功率低（<95%）

```bash
# 查看错误日志
journalctl -u zeromaps-rpc | grep "Error"

# 检查curl-impersonate
/usr/local/bin/curl-impersonate-chrome --version
```

## 性能优化指南

### 性能指标（基于实际运行数据）

- **QPS**: 15-20 req/s (单服务器，100个IPv6)
- **成功率**: >99.5%
- **平均响应时间**: 200-300ms
- **负载平衡度**: <5 (1000个IPv6时 <2)
- **已验证**: 16万+ 请求无问题

### 关键性能要素

#### 1. IPv6地址池大小

| IPv6数量 | 单IP压力 | 封禁风险 | 推荐场景 |
|---------|---------|---------|---------|
| 100个 | 中等 | 较低 | 测试/小规模 |
| 1000个 | 很低 | 极低 | ✅ **生产推荐** |
| 500个 | 低 | 低 | 中等规模 |

**当前配置**：默认1000个IPv6（`::1001` ~ `::2000`）

#### 2. 客户端并发策略

```typescript
// ❌ 错误：串行请求（慢）
for (const uri of uris) {
  const result = await client.fetchData(uri)  // 一个接一个
}
// QPS: 2-3 req/s

// ✅ 正确：并发请求（快）
const promises = uris.map(uri => client.fetchData(uri))
const results = await Promise.all(promises)  // 同时发送
// QPS: 50+ req/s（10个客户端）
```

#### 3. 监控并发情况

更新后的统计会显示：

```
📊 服务器统计
👥 在线客户端: 10
📦 总请求数: 162696
⚡ 当前并发: 8        ← 新增：当前并发数
📈 最大并发: 10       ← 新增：历史最大并发
```

**健康指标**：
- 当前并发 < 50：正常
- 当前并发 > 100：可能需要优化
- 最大并发越高越好（说明客户端在并发请求）

#### 4. 性能瓶颈排查

如果QPS很低（<10 req/s），检查：

1. **客户端是否串行请求**
   ```bash
   # 查看并发数，如果一直是1-2，说明客户端串行
   journalctl -u zeromaps-rpc -f | grep "当前并发"
   ```

2. **是否只有100个IPv6**
   ```bash
   # 应该显示1001个（主地址+1000个池）
   ip -6 addr show dev ipv6net | grep "2607:8700:5500:2043" | wc -l
   ```

3. **网络延迟**
   ```bash
   # 测试响应时间
   curl -6 --interface 2607:8700:5500:2043::1001 -w "@curl-format.txt" -o /dev/null -s https://kh.google.com/
   ```

### 优化建议

#### 立即优化（无需改代码）

1. **部署1000个IPv6**（如果还没部署）
   ```bash
   for i in {1001..2000}; do
     ip -6 addr add 2607:8700:5500:2043::$i/128 dev ipv6net
   done
   pm2 restart zeromaps-rpc
   ```

2. **客户端改为并发请求**
   - 使用 `Promise.all()` 批量发送
   - 建议并发数：10-50个

3. **增加客户端数量**
   - 10个客户端 → 20个客户端
   - 每个客户端并发10个请求
   - 理论QPS：200+

#### 长期优化（需要改代码）

1. **curl进程池** - 复用curl进程减少启动开销
2. **HTTP/2连接复用** - 减少连接建立时间
3. **本地缓存** - 对相同请求返回缓存结果

## 开发状态

- ✅ Proto 协议定义
- ✅ IPv6 池管理
- ✅ curl-impersonate 集成
- ✅ RPC 请求处理
- ✅ 完整监控系统
- ✅ 统计数据导出
- ⏳ 客户端 SDK
- ⏳ 自动重连
- ⏳ 集成到 taskcli

## License

MIT
