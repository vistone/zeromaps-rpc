# 🚀 uTLS 部署指南

## 📋 部署步骤

### 第一步：安装 Go

```bash
# 下载 Go 1.21
wget https://go.dev/dl/go1.21.5.linux-amd64.tar.gz

# 解压到 /usr/local
sudo tar -C /usr/local -xzf go1.21.5.linux-amd64.tar.gz

# 添加到 PATH
export PATH=$PATH:/usr/local/go/bin
echo 'export PATH=$PATH:/usr/local/go/bin' >> ~/.bashrc

# 验证安装
go version
```

### 第二步：拉取最新代码

```bash
cd /opt/zeromaps-rpc
sudo git pull
```

### 第三步：部署 uTLS 代理

```bash
# 方式 1：使用部署脚本（推荐）
sudo bash deploy-utls.sh

# 方式 2：手动编译和运行
cd utls-proxy
bash build.sh
pm2 start ./utls-proxy --name utls-proxy
pm2 save
```

### 第四步：部署主服务

```bash
# 使用自动更新脚本
sudo bash auto-update.sh
```

## 🔍 验证部署

### 1. 检查 uTLS 代理状态

```bash
pm2 list
# 应该看到 utls-proxy 和 zeromaps 都在运行

pm2 logs utls-proxy --lines 20
# 应该看到：🚀 uTLS Proxy Server starting on :8765
```

### 2. 测试 uTLS 代理

```bash
curl "http://localhost:8765/proxy?url=https://www.google.com" -I
# 应该返回 200 OK
```

### 3. 检查主服务日志

```bash
pm2 logs zeromaps --lines 20
# 应该看到：🔧 使用 uTLS 代理请求（模拟 Chrome 120 TLS 指纹）
```

### 4. 查看监控面板

访问：`http://你的服务器IP:9528`

应该看到：
- ✅ 节点正常（不再是红色 403）
- 请求统计正常增长
- 成功率 > 95%

## 📊 性能对比

| 方案 | 内存占用 | TLS 指纹 | 成功率 |
|------|----------|----------|--------|
| curl | 5MB/进程 | ❌ 不匹配 | ~0% (403) |
| curl-impersonate | 50-100MB/进程 | ✅ 匹配 | ~99% |
| **uTLS (新方案)** | **~15MB 单进程** | **✅ 完美匹配** | **~99%** |

## 🛠️ 故障排查

### 问题：uTLS 代理无法启动

```bash
# 检查端口是否被占用
sudo lsof -i :8765

# 如果被占用，杀掉进程
sudo kill -9 <PID>

# 重新启动
pm2 restart utls-proxy
```

### 问题：主服务无法连接 uTLS 代理

```bash
# 确认 uTLS 代理在运行
pm2 list

# 测试连接
curl http://localhost:8765/proxy?url=https://www.google.com

# 检查防火墙
sudo ufw status
```

### 问题：还是返回 403

```bash
# 1. 确认使用了 uTLS
pm2 logs zeromaps | grep uTLS
# 应该看到：使用 uTLS 代理请求

# 2. 检查 uTLS 代理日志
pm2 logs utls-proxy

# 3. 可能是 IPv6 地址段被封，尝试更换
# 编辑 ecosystem.config.cjs，修改 IPV6_PREFIX

# 4. 重启服务
pm2 restart all
```

## 🔧 配置说明

### 环境变量

在 `ecosystem.config.cjs` 或 `.env` 中配置：

```javascript
env: {
  // 使用 uTLS（默认）
  FETCHER_TYPE: 'utls',
  
  // uTLS 代理端口（默认 8765）
  UTLS_PROXY_PORT: '8765',
  
  // uTLS 并发数（默认 10）
  UTLS_CONCURRENCY: '10',
  
  // IPv6 前缀
  IPV6_PREFIX: '2607:8700:5500:1e09'
}
```

### 切换回 curl（如果需要）

```bash
# 停止 uTLS 代理
pm2 delete utls-proxy

# 设置环境变量
export FETCHER_TYPE=curl

# 重启主服务
pm2 restart zeromaps
```

## 📝 维护操作

### 更新代码

```bash
cd /opt/zeromaps-rpc
sudo bash auto-update.sh
```

### 重启服务

```bash
# 重启所有
pm2 restart all

# 只重启 uTLS 代理
pm2 restart utls-proxy

# 只重启主服务
pm2 restart zeromaps
```

### 查看日志

```bash
# 查看所有日志
pm2 logs

# 只看 uTLS
pm2 logs utls-proxy

# 只看主服务
pm2 logs zeromaps

# 查看错误日志
pm2 logs --err
```

## 🎯 预期效果

部署成功后，你应该看到：

✅ **uTLS 代理运行正常**
```
🚀 uTLS Proxy Server starting on :8765
📋 模拟浏览器: Chrome 120
```

✅ **主服务识别 uTLS**
```
🔧 使用 uTLS 代理请求（模拟 Chrome 120 TLS 指纹）
```

✅ **请求成功**
```
✅ [2607:8700:5500:1e09] 200 - https://kh.google.com/... (123ms, 45678 bytes)
```

✅ **监控面板显示绿色**
- 节点状态正常
- 成功率 > 95%
- 不再有 403 错误

