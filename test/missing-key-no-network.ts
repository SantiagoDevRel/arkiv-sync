/** Configuration admission runs in isolated children; no parent credentials or RPC. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

const childEnv: NodeJS.ProcessEnv = {}
for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'PATHEXT']) {
  if (process.env[name] !== undefined) childEnv[name] = process.env[name]
}
const cases = [
  'create-missing-key',
  'quick-check-missing-key',
  'config-custom-sink-validates-source',
  'override-custom-sink-validates-source',
  'quick-check-refuses-custom-sink',
  'caller-owned-source-and-sink',
] as const
const results: Array<{ id: string; status: string; fetchAttempts: number; dependencyCalls: number }> = []

for (const id of cases) {
  const child = spawnSync(process.execPath, [
    '--import', import.meta.resolve('tsx'), '--input-type=module', '--eval', `
      import assert from 'node:assert/strict';
      let fetchAttempts = 0, dependencyCalls = 0;
      globalThis.fetch = async () => { fetchAttempts++; throw new Error('NETWORK_DENIED'); };
      const { createIndexer, quickCheck } = await import(${JSON.stringify(new URL('../src/config.ts', import.meta.url).href)});
      const { silentLogger } = await import(${JSON.stringify(new URL('../src/log.ts', import.meta.url).href)});
      const { MemoryCursorStore } = await import(${JSON.stringify(new URL('../src/core/cursor.ts', import.meta.url).href)});
      const config = {
        source: { chain: 'sepolia', contract: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14',
          events: ['Transfer(address indexed from, address indexed to, uint256 value)'] },
        logger: silentLogger,
      };
      const forbidden = async () => { dependencyCalls++; throw new Error('DEPENDENCY_NOT_ADMITTED'); };
      const sink = { name: 'caller-owned', init: forbidden, write: forbidden, delete: forbidden };
      const source = { chainId: 11155111, name: 'caller-owned', preflight: forbidden,
        getHeadBlock: forbidden, getBlockHeader: forbidden, getEvents: forbidden };
      const id = ${JSON.stringify(id)};
      let expectedError, observedError, succeeded = false;
      if (id.endsWith('missing-key')) expectedError = /PRIVATE_KEY is not set/;
      else if (id.endsWith('validates-source')) expectedError = /not a valid contract address/;
      else if (id === 'quick-check-refuses-custom-sink') expectedError = /quickCheck requires the default Arkiv sink/;
      try {
        assert.equal(process.env.PRIVATE_KEY, undefined);
        if (id === 'create-missing-key') createIndexer(config);
        else if (id === 'quick-check-missing-key') await quickCheck(config);
        else if (id === 'config-custom-sink-validates-source') createIndexer({ ...config, sink, source: { ...config.source, contract: 'invalid' } });
        else if (id === 'override-custom-sink-validates-source') createIndexer({ ...config, source: { ...config.source, contract: 'invalid' } }, { sink });
        else if (id === 'quick-check-refuses-custom-sink') await quickCheck({ ...config, sink });
        else { const indexer = createIndexer(config, { source, sink, cursorStore: new MemoryCursorStore() }); assert(indexer.cursorId); }
        succeeded = true;
      } catch (error) { observedError = error.message; }
      // Drain immediate fallback-ranking samples before asserting zero attempted requests.
      await new Promise(resolve => setTimeout(resolve, 25));
      let status = 'PASS';
      try {
        if (expectedError) { assert.equal(succeeded, false); assert.match(observedError ?? '', expectedError); }
        else assert.equal(succeeded, true);
        assert.equal(fetchAttempts, 0); assert.equal(dependencyCalls, 0);
      } catch { status = 'FAIL'; }
      console.log(JSON.stringify({ id, status, fetchAttempts, dependencyCalls }));
      // Only the owned child exits; no fallback timer can outlive a failing admission test.
      process.exit(status === 'PASS' ? 0 : 1);
    `,
  ], { env: childEnv, encoding: 'utf8', timeout: 15_000, windowsHide: true })
  assert(!child.error, `Isolated child failed to start: ${id}`)
  const result = JSON.parse(child.stdout.trim()) as typeof results[number]
  results.push(result)
  if (child.status !== 0) result.status = 'FAIL'
}

console.log(JSON.stringify({
  status: results.every(result => result.status === 'PASS') ? 'PASS' : 'FAIL',
  tests: results.length, results, actualNetworkRequests: 0, signingCalls: 0,
  parentEnvironmentModified: false, scope: 'Isolated configuration admission; workers never started.',
}))
assert(results.every(result => result.status === 'PASS'), 'Configuration admission attempted network or changed caller-owned adapter behavior')
