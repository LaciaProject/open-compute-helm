#!/usr/bin/env node
// Exercise pinned Weft code against the actual released ocd HTTP API.
// A blocked application is reported as blocked; --strict makes it fail CI.
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import {createRequire} from 'node:module';
import {mkdir, readFile, writeFile, stat} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const weft = resolve(process.env.WEFT_DIR ?? '.test-sources/weft');
const source = resolve(process.env.OPEN_COMPUTE_SOURCE ?? '.test-sources/open-compute');
const output = resolve(process.env.EVIDENCE_DIR ?? '.test-output/weft');
const origin = process.env.OPEN_COMPUTE_ORIGIN ?? 'http://127.0.0.1:8787';
const token = process.env.OPEN_COMPUTE_TOKEN ?? 'weft-ci-admin-fixture';
const lock = JSON.parse(await readFile(resolve(root, '.github/weft-compatibility.lock.json'), 'utf8'));
await mkdir(output, {recursive: true});
const report = {schemaVersion: 1, generatedAt: new Date().toISOString(), inputs: lock,
  scope: 'Pinned Weft dependency probes and Worker upload admission against released ocd; not a full Weft deployment.',
  checks: [], outcome: 'not_run'};

async function save() {
  report.outcome = report.checks.some(c => c.status === 'blocked') ? 'blocked' : 'passed';
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  const rows = report.checks.map(c => `| ${c.name} | ${c.status} | ${c.detail.replaceAll('|', '\\|').replaceAll('\n', ' ')} |`);
  const summary = `Weft compatibility: **${report.outcome}**\n\n${report.scope}\n\nWeft: \`${lock.weft.ref}\`\n\nRuntime: \`${lock.runtimeImage}\`\n\nSource review: \`${lock.openComputeSource.ref}\` (not a source-built runtime)\n\n| Check | Result | Evidence |\n| --- | --- | --- |\n${rows.join('\n')}\n`;
  await writeFile(resolve(output, 'report.md'), summary);
  if (process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY, summary, {flag: 'a'});
}
async function check(name, operation) {
  try {
    const detail = await operation();
    report.checks.push({name, status: 'passed', detail: String(detail ?? 'passed')});
  } catch (error) {
    report.checks.push({name, status: 'blocked', detail: String(error.message).slice(0, 4000)});
  }
  console.log(`${report.checks.at(-1).status}: ${name}: ${report.checks.at(-1).detail}`);
  await save();
}

// Native http honors Host routing. Node fetch can replace the Host header, which
// would test the management listener instead of the Worker under examination.
async function request(path, {method = 'GET', host = '127.0.0.1:8787', body, contentType} = {}) {
  const url = new URL(path, origin);
  return new Promise((accept, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    let receiving = false;
    const req = client.request(url, {method, agent: false, headers: {
      host, ...(path.startsWith('/client/v4/') ? {authorization: `Bearer ${token}`} : {}),
      ...(body ? {'content-length': body.length} : {}),
      ...(contentType ? {'content-type': contentType} : {}),
    }}, res => {
      receiving = true;
      const chunks = []; let size = 0;
      res.on('data', chunk => {size += chunk.length; if (size > 1024 * 1024) res.destroy(new Error('Response exceeded 1 MiB')); else chunks.push(chunk);});
      res.on('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let json; try {json = JSON.parse(text);} catch {}
        accept({status: res.statusCode, text, json});
      });
    });
    req.setTimeout(120_000, () => req.destroy(new Error('HTTP request timed out')));
    req.on('error', error => {if (!receiving) reject(error);});
    req.end(body);
  });
}

let account;
const baseMetadata = {main_module: 'index.js', compatibility_date: '2026-07-30', compatibility_flags: ['nodejs_compat']};
async function upload(name, code, extra = {}) {
  const form = new FormData();
  form.set('metadata', JSON.stringify({...baseMetadata, ...extra}));
  form.set('index.js', new Blob([code], {type: 'application/javascript+module'}), 'index.js');
  const encoded = new Request('http://fixture.invalid', {method: 'PUT', body: form});
  const response = await request(`/client/v4/accounts/${account}/workers/scripts/${name}`, {
    method: 'PUT', body: Buffer.from(await encoded.arrayBuffer()), contentType: encoded.headers.get('content-type'),
  });
  await writeFile(resolve(output, `${name}-upload.json`), JSON.stringify(response, null, 2));
  return response;
}
function success(response) {
  assert.equal(response.status, 200, `HTTP ${response.status}: ${response.text}`);
  assert.notEqual(response.json?.success, false, response.text);
  return response.json;
}
async function worker(name, path = '/', input) {
  return request(path, {host: `${name}.${account}.localhost`, ...(input === undefined ? {} : {
    method: 'POST', body: Buffer.from(typeof input === 'string' ? input : JSON.stringify(input)),
    contentType: typeof input === 'string' ? 'text/plain' : 'application/json',
  })});
}

try {
  await check('Runtime and API baseline', async () => {
    const response = success(await request('/client/v4/accounts'));
    assert.equal(response.result.length, 1);
    account = response.result[0].id;
    success(await upload('weft-baseline', 'export default {fetch(){return Response.json({ok:true})}}'));
    assert.equal(success(await worker('weft-baseline')).ok, true);
    return 'Actual Worker upload and dispatch succeeded.';
  });
  if (!account) throw new Error('Runtime unavailable; application probes cannot run.');

  const require = createRequire(resolve(weft, 'package.json'));
  const esbuild = require('esbuild');
  let computerCode;
  await check('Build actual Computer and Weft authentication probe', async () => {
    const result = await esbuild.build({entryPoints: [resolve(root, '.github/fixtures/weft-computer.ts')],
      bundle: true, format: 'esm', platform: 'browser', target: 'es2024', minify: true, write: false,
      nodePaths: [resolve(weft, 'node_modules')], external: ['cloudflare:workers', 'node:*'],
      plugins: [{name: 'pinned-weft-source', setup(build) {
        build.onResolve({filter: /^weft\/access-assertion$/}, () => ({path: resolve(weft, 'packages/tenant/src/access-assertion.ts')}));
      }}]});
    computerCode = result.outputFiles[0].text;
    await writeFile(resolve(output, 'computer-probe.js'), computerCode);
    const pkg = JSON.parse(await readFile(resolve(weft, 'node_modules/@cloudflare/computer/package.json'), 'utf8'));
    return `Bundled @cloudflare/computer ${pkg.version}.`;
  });
  if (computerCode) {
    let installed = false;
    await check('Computer filesystem on real Durable Object SQLite', async () => {
      success(await upload('weft-computer', computerCode, {
        bindings: [{type: 'durable_object_namespace', name: 'FILES', class_name: 'ComputerProbe'}],
        exports: {ComputerProbe: {type: 'durable-object', storage: 'sqlite'}},
      }));
      installed = true;
      assert.equal(success(await worker('weft-computer', '/alpha', 'alpha-file')).value, 'alpha-file');
      assert.equal(success(await worker('weft-computer', '/beta')).value, null);
      assert.equal(success(await worker('weft-computer', '/alpha')).value, 'alpha-file');
      return 'Computer wrote/read real DO SQLite; another owner could not read the file.';
    });
    if (installed) await check('Weft rejects anonymous Access requests', async () => {
      assert.equal((await worker('weft-computer', '/auth')).status, 401);
      return 'Actual Weft assertion verifier rejects a request without a signed identity; positive login is not tested.';
    });
  }

  let dynamicInstalled = false;
  await check('Upload actual Weft dynamic-plugin fixture', async () => {
    success(await upload('weft-dynamic', await readFile(resolve(weft, 'dist/dynamic-worker.js')), {
      bindings: [{type: 'worker_loader', name: 'LOADER'}, {type: 'plain_text', name: 'PLATFORM_SECRET', text: 'must-not-cross-isolate'},
        {type: 'durable_object_namespace', name: 'NATIVE_PLUGINS', class_name: 'NativePluginBench'}],
      exports: {NativePluginBench: {type: 'durable-object', storage: 'sqlite'}, NativePluginHost: {type: 'worker'}, ScopedHost: {type: 'worker'}},
    }));
    dynamicInstalled = true;
    return 'Uploaded the fixture built by Weft itself, including its native plugin platform.';
  });
  if (dynamicInstalled) {
    await check('Actual Weft Cordis runner, scoped RPC and blocked egress', async () => {
      const code = `export const inject=['host']; export function apply(ctx,config){ctx.reflect.provide('pluginApi',{async run(){let blocked=false;try{await fetch('https://example.com')}catch{blocked=true}return {data:await ctx.host.read(),blocked,secret:typeof globalThis.PLATFORM_SECRET}}})}`;
      for (const tenantId of ['alpha', 'beta', 'alpha']) {
        const value = success(await worker('weft-dynamic', '/', {tenantId, revision: '1', source: code, config: {}, input: {}}));
        assert.equal(value.data.tenantId, tenantId);
        assert.equal(value.blocked, true);
        assert.equal(value.secret, 'undefined');
      }
      return 'Actual Cordis code ran with owner-scoped RPC; global outbound and platform secret were unavailable.';
    });
    await check('Actual native plugin facet lifecycle and owner isolation', async () => {
      const source = `return {apply(ctx){const fs=ctx.get('fs');harness.handle('read',async()=>{const current=await fs.resolve('current');return {owner:current.owner,runId:current.runId};})}}`;
      const call = async (owner, action, fields = {}) => {
        const response = await worker('weft-dynamic', '/native-plugin', {owner, action, ...fields});
        await writeFile(resolve(output, `native-plugin-${owner}-${action}.json`), JSON.stringify(response, null, 2));
        assert.equal(response.status, 200, `${owner}/${action}: HTTP ${response.status}: ${response.text}`);
        return response.json;
      };
      const first = await call('alpha', 'start', {source});
      const alpha = await call('alpha', 'invoke', {method: 'read'});
      assert.equal(alpha.runId, first.runId);
      await call('alpha', 'saveHandler', {method: 'read'});
      await call('alpha', 'stop');
      const second = await call('alpha', 'start', {source});
      assert.notEqual(first.runId, second.runId);
      const stale = await worker('weft-dynamic', '/native-plugin', {owner: 'alpha', action: 'invokeSaved'});
      assert.equal(stale.status, 400, stale.text);
      assert.match(stale.text, /Plugin activation has stopped/);
      await call('alpha', 'evictFacet');
      assert.equal((await call('alpha', 'invoke', {method: 'read'})).runId, second.runId);
      await call('beta', 'start', {source});
      assert.notEqual((await call('beta', 'invoke', {method: 'read'})).owner, alpha.owner);
      await call('alpha', 'stop'); await call('beta', 'stop');
      return 'Native plugin lifecycle, stale callback rejection, facet wake and owner isolation passed.';
    });
  }

  await check('Weft tracing configuration admission', async () => {
    success(await upload('weft-tracing', 'export default {fetch(){return new Response("ok")}}', {
      observability: {enabled: true, logs: {enabled: true, head_sampling_rate: 1, invocation_logs: false},
        traces: {enabled: true, head_sampling_rate: 1}},
    }));
    return 'Trace-enabled metadata admitted.';
  });
  await check('Weft FUSE requirements versus Broker policy (source review)', async () => {
    const test = await readFile(resolve(weft, 'tests/workspace-container.test.ts'), 'utf8');
    const policy = await readFile(resolve(source, 'crates/service/src/container_broker/policy.rs'), 'utf8');
    assert.ok(test.includes("'--device', '/dev/fuse'") && test.includes("'--cap-add', 'SYS_ADMIN'"), 'Pinned Weft FUSE requirements changed; review the probe.');
    assert.ok(policy.includes('["Binds", "Devices", "VolumesFrom", "DeviceRequests"]') && policy.includes('role == "application"') && policy.includes('value != &json!([])'), 'Pinned Broker policy changed; review the boundary.');
    throw new Error('Weft real FUSE tests require /dev/fuse and SYS_ADMIN; the current Broker rejects application device mounts and added capabilities. No policy bypass was enabled.');
  });
  let computerResult;
  if (process.env.WEFT_CONTAINER_IMAGE) await check('Actual computerd startup without FUSE device/capability grants', async () => {
    const command = `set -eu; /usr/local/bin/computerd > /tmp/computerd.log 2>&1 & child=$!; trap 'kill "$child" 2>/dev/null || true' EXIT; for i in $(seq 1 10); do if mountpoint -q /workspace; then echo FUSE_MOUNTED; exit 0; fi; if ! kill -0 "$child" 2>/dev/null; then cat /tmp/computerd.log; exit 70; fi; sleep 1; done; cat /tmp/computerd.log; echo FUSE_NOT_MOUNTED; exit 71`;
    computerResult = spawnSync('docker', ['run', '--rm', '--network', 'none', '--cap-drop', 'NET_RAW', '--security-opt', 'no-new-privileges:true',
      '-e', 'RPC_CLIENT_SECRET=weft-ci-computerd-fixture', '-e', 'FUSE_MOUNT=auto', '-e', 'COMPUTERD_DB=/var/lib/computerd/state.db',
      '--entrypoint', '/bin/sh', process.env.WEFT_CONTAINER_IMAGE, '-ec', command], {encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024});
    await writeFile(resolve(output, 'computerd.log'), `${computerResult.stdout ?? ''}\n${computerResult.stderr ?? ''}`);
    assert.match(computerResult.stdout ?? '', /computerd listening on/, 'computerd did not start; see computerd.log.');
    return /backend=shim/.test(computerResult.stdout) ? 'computerd started using its shim fallback. This does not establish Weft processd/PTY filesystem synchronization.' : 'computerd started; see computerd.log for selected backend.';
  });
  if (computerResult) await check('Actual POSIX FUSE workspace mount used by Weft container regressions', async () => {
    assert.equal(computerResult.status, 0, `No POSIX FUSE mount without device/capability grants; exit=${computerResult.status}. A running shim fallback is not a FUSE mount; processd/PTY integration needs separate verification. See computerd.log.`);
    assert.match(computerResult.stdout, /FUSE_MOUNTED/);
    return 'Real computerd mounted /workspace without additional container privileges.';
  });
  // An early upload rejection can close kubectl port-forward's streaming connection.
  // Keep the oversized-module probe last so that it cannot invalidate other checks.
  await check('Unmodified Weft main Worker module admission', async () => {
    const path = resolve(weft, 'dist/worker.js');
    const bytes = (await stat(path)).size;
    const response = await upload('weft-full-import', await readFile(path));
    assert.equal(response.status, 200, `${bytes} bytes; HTTP ${response.status}: ${response.text}`);
    return `${bytes} byte module admitted. This checks import admission, not the complete application bindings.`;
  });
} catch (error) {
  report.checks.push({name: 'Verification infrastructure', status: 'blocked', detail: String(error.message)});
} finally {
  await save();
}
if (report.outcome !== 'passed' && process.argv.includes('--strict')) process.exitCode = 1;
