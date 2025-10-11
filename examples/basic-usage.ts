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
    
    // 示例1：获取 BulkMetadata
    console.log('1. 获取 BulkMetadata (tilekey=04):')
    const bulk = await client.fetchData({
      dataType: DataType.BULK_METADATA,
      tilekey: '04',
      epoch: 2699
    })
    
    console.log(`   状态码: ${bulk.statusCode}`)
    console.log(`   数据大小: ${bulk.data.length} bytes`)
    console.log(`   tilekey: ${bulk.tilekey}\n`)
    
    // 示例2：获取 NodeData
    console.log('2. 获取 NodeData (tilekey=0413):')
    const node = await client.fetchData({
      dataType: DataType.NODE_DATA,
      tilekey: '0413',
      epoch: 2699
    })
    
    console.log(`   状态码: ${node.statusCode}`)
    console.log(`   数据大小: ${node.data.length} bytes\n`)
    
    // 示例3：并发获取多个数据
    console.log('3. 并发获取 10 个数据:')
    const tilekeys = ['04', '05', '06', '07', '10', '11', '12', '13', '14', '15']
    
    const promises = tilekeys.map((tilekey) =>
      client.fetchData({
        dataType: DataType.BULK_METADATA,
        tilekey,
        epoch: 2699
      })
    )
    
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

