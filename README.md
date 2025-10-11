# ZeroMaps RPC Protocol

基于 IPv6 池和 curl-impersonate 的高性能 Google Earth 数据获取系统。

## 架构设计

```
客户端 (taskcli)
    ↓ RPC 请求: DataRequest { dataType, tilekey, epoch }
    ↓ ZeroMaps 协议传输（多节点自动分流）
    ↓
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
服务器端 (tile2/tile6/tile12)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    ↓ 接收 RPC 请求
    ↓ 组合完整 URL
    ↓ 随机选择 IPv6 地址 (100个IP池)
    ↓ curl-impersonate --interface <ipv6>
    ↓ Chrome 124 TLS 指纹 + 不同 IPv6
    ↓
kh.google.com (看到 100 个不同的真实 Chrome)
```

## 核心优势

- ✅ **真实浏览器指纹** - curl-impersonate 完美模拟 Chrome 124
- ✅ **IPv6 地址池** - 每个服务器 100 个不同 IPv6，避免封禁
- ✅ **多节点分流** - 请求自动分散到 tile2/tile6/tile12
- ✅ **极简协议** - 请求只需 7-10 字节，节省 95% 带宽
- ✅ **已验证** - 基于成功获取 30 万条数据的实践经验

## 目录结构

```
zeromaps-rpc/
├── proto/              # Protocol Buffers 定义
│   └── zeromaps-rpc.proto
├── client/             # 客户端 SDK
│   ├── rpc-client.ts
│   └── index.ts
├── server/             # 服务器端实现
│   ├── rpc-server.ts
│   ├── ipv6-pool.ts
│   ├── curl-fetcher.ts
│   └── index.ts
├── examples/           # 使用示例
│   └── basic-usage.ts
├── package.json
├── tsconfig.json
└── README.md
```

## 协议定义

### 数据类型
```
1 = BulkMetadata
2 = NodeData
3 = ImageryData
```

### 请求格式
```protobuf
DataRequest {
  clientID: 1              // 服务器分配的客户端序号
  dataType: 1              // 1,2,3
  tilekey: "04"
  epoch: 123
  imageryEpoch: 456        // 可选
}
```

### 响应格式
```protobuf
DataResponse {
  clientID: 1              // 回传客户端ID
  dataType: 1              // 回传数据类型
  tilekey: "04"            // 回传 tilekey
  epoch: 123               // 回传 epoch
  imageryEpoch: 456        // 回传 imageryEpoch
  data: <binary>           // 二进制数据
  statusCode: 200          // HTTP 状态码
}
```

## 开发计划

1. ✅ Proto 协议定义
2. ⏳ 服务器端实现
   - IPv6 池管理
   - curl-impersonate 集成
   - RPC 请求处理
3. ⏳ 客户端 SDK
   - RPC 调用封装
   - 自动重连
   - 请求队列
4. ⏳ 集成到 taskcli

## 使用示例

```typescript
import { RpcClient } from 'zeromaps-rpc/client'

const client = new RpcClient('tile2.zeromaps.cn', 9527)
await client.connect()

const response = await client.fetchData({
  dataType: 1,              // BulkMetadata
  tilekey: "04",
  epoch: 123
})

if (response.statusCode === 200) {
  // 保存数据
  saveToLocal(response.data)
}
```

