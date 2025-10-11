import { RpcClient } from './client/rpc-client'

async function test() {
  const client = new RpcClient('tile12.zeromaps.cn', 9527)
  
  try {
    await client.connect()
    console.log(`✓ clientID: ${client.getClientID()}\n`)
    
    // 测试真实的 URI
    console.log('测试 PlanetoidMetadata...')
    const r1 = await client.fetchData('PlanetoidMetadata')
    console.log(`  ${r1.statusCode}: ${r1.data.length} bytes\n`)
    
    console.log('测试 BulkMetadata tilekey=04...')
    const r2 = await client.fetchData('BulkMetadata/pb=!1m2!1s04!2u2699')
    console.log(`  ${r2.statusCode}: ${r2.data.length} bytes`)
    
    client.disconnect()
  } catch (error) {
    console.error('错误:', error)
  }
}
test()
