/**
 * ZeroMaps RPC 基本使用示例
 */

import { RpcClient } from '../client/rpc-client'
import { DataType } from '../proto/proto/zeromaps-rpc'

async function main() {
  console.log('=== ZeroMaps RPC 客户端示例 ===\n')
  
  // 连接到服务器
  const client = new RpcClient('tile12.zeromaps.cn', 9527)
  
  try {
    await client.connect()
    console.log(`✓ 连接成功，clientID: ${client.getClientID()}\n`)
    
    // 示例1：获取 PlanetoidMetadata
    console.log('1. 获取 PlanetoidMetadata:')
    const planetoid = await client.fetchData('PlanetoidMetadata')
    
    console.log(`   状态码: ${planetoid.statusCode}`)
    console.log(`   数据大小: ${planetoid.data.length} bytes`)
    console.log(`   URI: ${planetoid.uri}\n`)
    
    // 示例2：获取 BulkMetadata
    console.log('2. 获取 BulkMetadata (tilekey=04):')
    const bulk = await client.fetchData('BulkMetadata/pb=!1m2!1s04!2u2699')
    
    console.log(`   状态码: ${bulk.statusCode}`)
    console.log(`   数据大小: ${bulk.data.length} bytes\n`)
    
    // 示例3：并发获取多个数据
    console.log('3. 并发获取 10 个数据:')
    const uris = [
      'BulkMetadata/pb=!1m2!1s04!2u2699',
      'BulkMetadata/pb=!1m2!1s05!2u2699',
      'BulkMetadata/pb=!1m2!1s06!2u2699',
      'BulkMetadata/pb=!1m2!1s07!2u2699',
      'BulkMetadata/pb=!1m2!1s10!2u2699'
    ]
    
    const promises = uris.map((uri) => client.fetchData(uri))
    
    const results = await Promise.all(promises)
    
    const successCount = results.filter((r) => r.statusCode === 200).length
    const totalBytes = results.reduce((sum, r) => sum + r.data.length, 0)
    
    console.log(`   成功: ${successCount}/${results.length}`)
    console.log(`   总数据: ${totalBytes} bytes\n`)
    
    // 断开连接
    client.disconnect()
    console.log('✓ 已断开连接')
    
  } catch (error) {
    console.error('错误:', error)
    client.disconnect()
    process.exit(1)
  }
}

main()

