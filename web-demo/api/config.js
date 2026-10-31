export default function handler(_req, res) {
  res.setHeader('content-type', 'application/json')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify({
    chain: 'sepolia', contract: '0xfff9976782d46cc05630d1f6ebab18b2324d6b14',
    network: 'Rabdi', chainId: 7794095,
    writesEnabled: process.env.ENABLE_DEMO_WRITES === '1' && Boolean(process.env.ARKIV_WRITE_ACCESS_KEY && process.env.PRIVATE_KEY),
  }))
}
