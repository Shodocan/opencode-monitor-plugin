// Explicit native acceptance gate; run after npm run build. No provider inference.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
const args = Object.fromEntries(process.argv.slice(2).reduce((out, value, i, all) => i % 2 ? out : [...out, [value.replace(/^--/, ''), all[i + 1]]], []));
assert(args.binary && args.package, '--binary and --package required');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-native-server-'));
const project = path.join(root, 'project'); fs.mkdirSync(project);
const manifest = JSON.parse(fs.readFileSync(path.join(args.package, 'package.json'), 'utf8'));
const entry = path.resolve(args.package, manifest.exports['./server']); assert(fs.existsSync(entry), 'build existing public server entry before acceptance');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const binaryHash = hash(args.binary); assert.equal(binaryHash, 'cc0d5814f4f6b6ce1bca088c1fc94d79233c63a208653d142a8784c1bcbd7900');
const configRoot = path.join(root, 'config', 'opencode'); fs.mkdirSync(configRoot, { recursive: true });
fs.writeFileSync(path.join(configRoot, 'package.json'), JSON.stringify({ dependencies: { '@opencode-ai/plugin': '1.17.11' } }));
fs.writeFileSync(path.join(configRoot, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: { '@opencode-ai/plugin': '1.17.11' } } } }));
fs.symlinkSync(path.join(args.package, 'node_modules'), path.join(configRoot, 'node_modules'));
const env = { PATH: process.env.PATH, LANG: 'C.UTF-8', PWD: project, OPENCODE_TEST_HOME: root,
 XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'), XDG_STATE_HOME: path.join(root, 'state'), XDG_CACHE_HOME: path.join(root, 'cache'), XDG_RUNTIME_DIR: path.join(root, 'runtime'),
 OPENCODE_CONFIG_CONTENT: JSON.stringify({ autoupdate: false, plugin: [entry] }), OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_EXTERNAL_SKILLS: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_MONITOR_DEBUG_LOG: path.join(root, 'monitor-debug.log') };
const log = fs.openSync(path.join(root, 'native.log'), 'w');
const child = spawn(args.binary, ['--print-logs', '--log-level', 'DEBUG', 'serve', '--hostname', '127.0.0.1', '--port', '0'], { cwd: project, env, stdio: ['ignore', log, log] });
let receipt = { root, entry, entrySha256: hash(entry), binary: args.binary, binarySha256: binaryHash, passed: false };
try {
 let url;
 for (let i = 0; i < 200; i++) {
  const content = fs.readFileSync(path.join(root, 'native.log'), 'utf8'); url = content.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
  if (url) break; assert.equal(child.exitCode, null, 'native startup must remain alive'); await new Promise(r => setTimeout(r, 100));
 }
 assert(url, 'native public URL');
 const response = await fetch(url + '/experimental/tool/ids?directory=' + encodeURIComponent(project), { signal: AbortSignal.timeout(15000) });
 assert.equal(response.status, 200); const ids = await response.json(); const monitor = ids.filter(x => x.startsWith('opencode_monitor_'));
 await new Promise(r => setTimeout(r, 150));
 const debug = fs.readFileSync(path.join(root, 'monitor-debug.log'), 'utf8').trim().split('\n').map(x => JSON.parse(x));
 const starts = debug.filter(x => x.event === 'server.start');
 receipt = { ...receipt, allToolIDs: ids, monitorToolIDs: monitor, monitorFactoryStarts: starts.length };
 assert.equal(starts.length, 1, 'one public server entry must initialize exactly one factory');
 assert.deepEqual(monitor.slice().sort(), ['background', 'cancel', 'jobs', 'loop', 'monitor', 'schedule'].map(x => 'opencode_monitor_' + x).sort());
 assert.equal(new Set(monitor).size, 6);
 assert(!/failed to load plugin|Failed to install plugin|level=ERROR/.test(fs.readFileSync(path.join(root, 'native.log'), 'utf8')));
 receipt.passed = true;
} catch(error) { receipt.error = String(error); process.exitCode = 1; }
finally { child.kill('SIGTERM'); await Promise.race([new Promise(r => child.once('exit', r)), new Promise(r => setTimeout(r, 3000))]); if(child.exitCode === null) child.kill('SIGKILL'); fs.closeSync(log); fs.writeFileSync(path.join(root, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n'); console.log(JSON.stringify(receipt)); }
