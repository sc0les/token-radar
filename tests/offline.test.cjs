const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const cli = path.resolve(__dirname, '../bin/radar.js');

function library() {
  const context = vm.createContext({
    require, __dirname: path.dirname(cli),
    process: { argv: ['node', cli, '--help'], stdout: { on() {}, write() {} } },
  });
  vm.runInContext(fs.readFileSync(cli, 'utf8'), context);
  return context;
}

test('help exits successfully without contacting providers', () => {
  const result = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--require-metrics/);
});

test('parser recognizes chain alias, top count, and output mode', () => {
  const lib = library();
  const args = lib.parseArgs(['node', cli, 'once', '--chain', 'base', '--top', '3', '--no-out']);
  assert.equal(args.chains, 'base');
  assert.equal(args.top, 3);
  assert.equal(args.noOut, true);
});

test('empty metrics stay unknown and Retry-After is capped', () => {
  const lib = library();
  assert.equal(lib.num(''), null);
  assert.equal(lib.num('bad'), null);
  assert.equal(lib.num('42'), 42);
  assert.equal(lib.parseRetryAfterMs('10000'), 60000);
  assert.equal(lib.isRateLimited(429, ''), true);
});
