# uTLS Proxy - Chrome TLS 指纹代理

## 📖 简介

uTLS Proxy 是一个轻量级的 Go HTTP 代理服务器，使用 [refraction-networking/utls](https://github.com/refraction-networking/utls) 库完美模拟 **Chrome 120 浏览器的 TLS 指纹**。

### 为什么需要 uTLS？

- ❌ **Node.js HTTP/2**：TLS 指纹不匹配 → Google 拒绝 (403)
- ❌ **系统 curl**：TLS 指纹不匹配 → Google 拒绝 (403)
- ✅ **uTLS Proxy**：完美模拟 Chrome → Google 通过 (200)

## 🚀 快速开始

### 1. 编译

```bash
cd utls-proxy
bash build.sh
```

### 2. 运行

```bash
# 默认端口 8765
./utls-proxy

# 自定义端口
UTLS_PROXY_PORT=9000 ./utls-proxy
```

### 3. 测试

```bash
# 测试 Google
curl "http://localhost:8765/proxy?url=https://www.google.com"

# 使用 IPv6
curl "http://localhost:8765/proxy?url=https://kh.google.com/rt/earth/...&ipv6=2607:8700:5500:1e09::1001"
```

## 📊 性能指标

| 指标 | 数值 |
|------|------|
| **内存占用** | ~15MB |
| **单次请求延迟** | +5-10ms |
| **并发支持** | 1000+ |
| **编译文件大小** | ~8MB |

## 🔧 API

### HTTP 端点

```
GET /proxy?url=<URL>&ipv6=<IPv6>
```

**参数：**
- `url` (必需): 目标 URL
- `ipv6` (可选): 强制使用的 IPv6 地址

**响应头：**
- `X-Status-Code`: 原始响应状态码
- `X-Duration-Ms`: 请求耗时（毫秒）
- `X-Origin-*`: 原始响应头

## 🌐 在 ZeroMaps RPC 中使用

### 环境变量

```bash
# 启用 uTLS
export FETCHER_TYPE=utls

# uTLS 代理端口（默认 8765）
export UTLS_PROXY_PORT=8765

# 并发数（默认 10）
export UTLS_CONCURRENCY=10

# DNS IP 池使用率（0-1，默认 0.95，值越大越多使用 IP 池）
export DNS_IP_POOL_USAGE_RATE=0.95
```

### PM2 配置

```javascript
{
  apps: [
    {
      name: 'utls-proxy',
      script: './utls-proxy/utls-proxy',
      env: {
        UTLS_PROXY_PORT: '8765'
      }
    },
    {
      name: 'zeromaps',
      script: './dist/server/index.js',
      env: {
        FETCHER_TYPE: 'utls',
        UTLS_PROXY_PORT: '8765'
      }
    }
  ]
}
```

## 🔍 技术细节

### TLS 指纹模拟

uTLS 精确复制 Chrome 120 的：
- Cipher Suites 顺序
- TLS 扩展（Extensions）
- ALPN 协议 (h2, http/1.1)
- Supported Groups
- Signature Algorithms

### Chrome 120 Headers

```
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ...
Sec-Ch-Ua: "Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"
Sec-Ch-Ua-Mobile: ?0
Sec-Ch-Ua-Platform: "Windows"
Sec-Fetch-Dest: empty
Sec-Fetch-Mode: cors
Sec-Fetch-Site: same-site
Referer: https://earth.google.com/
Origin: https://earth.google.com
```

## 📝 日志示例

```
🚀 uTLS Proxy Server starting on :8765
📋 模拟浏览器: Chrome 120
🌐 使用方法: http://localhost:8765/proxy?url=<URL>&ipv6=<IPv6>
✅ [2607:8700:5500:1e09] 200 - https://kh.google.com/rt/earth/... (123ms, 45678 bytes)
```

## 🛠️ 故障排查

### 代理无法启动

```bash
# 检查端口是否被占用
lsof -i :8765

# 查看错误日志
pm2 logs utls-proxy --err
```

### 请求失败

```bash
# 手动测试代理
curl -v "http://localhost:8765/proxy?url=https://www.google.com"

# 检查 IPv6 连通性
ping6 2607:8700:5500:1e09::1001
```

## 📚 参考资料

- [uTLS GitHub](https://github.com/refraction-networking/utls)
- [TLS 指纹检测原理](https://ja3er.com/)
- [Chrome TLS 特征](https://tlsfingerprint.io/)

