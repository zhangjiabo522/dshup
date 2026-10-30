'use strict';

const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const root = process.env.DSH_TEST_STATE;
const prefix = args[args.indexOf('--prefix') + 1];
const relative = prefix && path.relative(root, prefix);
if (!prefix || path.isAbsolute(relative) || relative.startsWith('..')) process.exit(19);
const spec = args.find((arg) => arg.startsWith('@deepseek-ai/dsh@'));
fs.writeFileSync(path.join(root, 'npm-install.json'), JSON.stringify({ prefix, spec, command: args[0] }));
if (process.env.DSH_TEST_SCENARIO === 'upgrade-fails') {
  process.stderr.write('模拟安装失败\n');
  process.exit(3);
}
if (process.env.DSH_TEST_SCENARIO === 'upgrade-stale') process.exit(0);
const file = path.join(prefix, 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify({ name: '@deepseek-ai/dsh', version: spec.slice(spec.lastIndexOf('@') + 1) }));
