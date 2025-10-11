import { RpcClient } from './client/rpc-client'
import { DataType } from './proto/proto/zeromaps-rpc'

async function test() {
  const client = new RpcClient('tile12.zeromaps.cn', 9527)
  
  try {
    console.log('正在连接到 tile12...')
    await client.connect()
    console.log(`✓ 连接成功，clientID: ${client.getClientID()}`)
    
    console.log('\n测试获取 BulkMetadata (tilekey=04)...')
    const response = await client.fetchData({
      dataType: DataType.BULK_METADATA,
      tilekey: '04',
      epoch: 2699
    })
    
    console.log(`✓ 状态码: ${response.statusCode}`)
    console.log(`✓ 数据大小: ${response.data.length} bytes`)
    console.log(`✓ tilekey: ${response.tilekey}`)
    
    client.disconnect()
    console.log('\n✓ 测试完成！')
  } catch (error) {
    console.error('错误:', error)
    process.exit(1)
  }
}

test()
