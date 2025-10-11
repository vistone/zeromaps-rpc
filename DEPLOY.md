# ZeroMaps RPC 服务器部署指南

## 服务器端部署（tile2/tile6/tile12）

### 步骤1：安装 curl-impersonate

```bash
# 下载预编译版本
cd /usr/local/bin
wget https://github.com/lwthiker/curl-impersonate/releases/download/v0.6.1/curl-impersonate-v0.6.1.x86_64-linux-gnu.tar.gz
tar -xzf curl-impersonate-v0.6.1.x86_64-linux-gnu.tar.gz
chmod +x curl_chrome124

# 测试
./curl_chrome124 --version
```

### 步骤2：配置 IPv6 地址池

```bash
# 检查当前 IPv6 配置
ip -6 addr show dev ipv6net

# 批量添加 IPv6 地址（100个）
for i in {1001..1100}; do
  ip -6 addr add 2607:8700:5500:2043::$i/128 dev ipv6net
done

# 验证
ip -6 addr show dev ipv6net | grep "2607:8700:5500:2043" | wc -l
# 应该显示 101 (包括主地址 ::2)

# 测试
curl -6 --interface 2607:8700:5500:2043::1001 https://api64.ipify.org
```

### 步骤3：IPv6 地址持久化

```bash
# 创建启动脚本
cat > /root/setup-ipv6-pool.sh << 'EOF'
#!/bin/bash
echo "正在配置 IPv6 地址池..."
for i in {1001..1100}; do
  ip -6 addr add 2607:8700:5500:2043::$i/128 dev ipv6net 2>/dev/null
done
echo "✓ IPv6 池配置完成: 100 个地址"
EOF

chmod +x /root/setup-ipv6-pool.sh

# 添加到系统启动
cat > /etc/systemd/system/ipv6-pool.service << 'EOF'
[Unit]
Description=IPv6 Address Pool Setup
After=network.target

[Service]
Type=oneshot
ExecStart=/root/setup-ipv6-pool.sh
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF

systemctl enable ipv6-pool
systemctl start ipv6-pool
```

### 步骤4：部署 RPC 服务器

```bash
# 上传代码到服务器
cd /opt
git clone <zeromaps-rpc仓库> zeromaps-rpc
cd zeromaps-rpc

# 安装依赖
npm install

# 编译
npm run build

# 配置服务器参数（修改 server/index.ts）
# - PORT: 9527
# - IPV6_PREFIX: 根据服务器实际配置
# - CURL_PATH: /usr/local/bin/curl_chrome124
```

### 步骤5：创建 systemd 服务

```bash
cat > /etc/systemd/system/zeromaps-rpc.service << 'EOF'
[Unit]
Description=ZeroMaps RPC Server
After=network.target ipv6-pool.service

[Service]
Type=simple
User=root
WorkingDirectory=/opt/zeromaps-rpc
ExecStart=/usr/bin/npm run server
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable zeromaps-rpc
systemctl start zeromaps-rpc
```

### 步骤6：验证服务

```bash
# 查看状态
systemctl status zeromaps-rpc

# 查看日志
journalctl -u zeromaps-rpc -f

# 测试连接
telnet localhost 9527
```

---

## 客户端使用（taskcli）

### 安装 RPC 客户端

```bash
cd /home/stone/taskcli

# 方式1：NPM 包（如果发布）
npm install zeromaps-rpc

# 方式2：本地链接
cd /home/stone/zeromaps-rpc
npm link
cd /home/stone/taskcli
npm link zeromaps-rpc
```

### 修改 App.vue

```typescript
import { RpcClient, DataType } from 'zeromaps-rpc/client'

// 创建 RPC 客户端
const rpcClient = new RpcClient('tile12.zeromaps.cn', 9527)
await rpcClient.connect()

// 替换原来的 fetch
// 原来：
const response = await fetch('https://kh.google.com/rt/earth/BulkMetadata/pb=!1m2!1s04!2u123')

// 改为：
const result = await rpcClient.fetchData({
  dataType: DataType.BULK_METADATA,
  tilekey: '04',
  epoch: 123
})

if (result.statusCode === 200) {
  // 使用 result.data
  const arrayBuffer = result.data.buffer
}
```

---

## 监控和维护

### 查看 IPv6 使用情况

```bash
# 服务器端会自动打印统计信息
journalctl -u zeromaps-rpc -f | grep "IPv6 池统计"
```

### 性能调优

- 调整并发数：客户端 `concurrency = 20`
- 增加 IPv6 地址数：修改 `{1001..1200}` 
- 调整 curl 超时：`--max-time 10`

### 故障排查

```bash
# 检查 IPv6 地址
ip -6 addr show dev ipv6net | grep "2607:8700:5500:2043" | wc -l

# 测试 curl-impersonate
/usr/local/bin/curl_chrome124 -6 --interface 2607:8700:5500:2043::1001 https://kh.google.com -I

# 查看服务日志
journalctl -u zeromaps-rpc -n 100
```

