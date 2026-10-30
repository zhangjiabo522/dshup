'use strict';

const os = require('os');
const path = require('path');
const { fileURLToPath } = require('url');

const RELEASES_URL = 'https://github.com/zhangjiabo522/dshup/releases/latest';

function isTrustedPageUrl(value, appUrl, rendererDir = path.join(__dirname, 'renderer')) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'file:') return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === new URL(appUrl).origin;
    const file = path.resolve(fileURLToPath(url));
    return ['index.html', 'settings.html'].some(name => file === path.resolve(rendererDir, name));
  } catch {
    return false;
  }
}

function desktopString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
}

function quoteDesktopExecArg(value) {
  const argument = String(value);
  if (argument.includes('\0')) throw new Error('启动路径不能包含空字符');
  const quoted = argument.replace(/["`$\\]/g, '\\$&').replace(/%/g, '%%');
  return `"${desktopString(quoted)}"`;
}

function linuxAutostartPath(env = process.env, home = os.homedir()) {
  const config = env.XDG_CONFIG_HOME;
  return path.posix.join(config && path.posix.isAbsolute(config) ? config : path.posix.join(home, '.config'), 'autostart', 'dshup.desktop');
}

function createLinuxAutostart({ executable, appPath, icon }) {
  if (!executable || executable.includes('=')) throw new Error('不支持此开机启动程序路径');
  const args = [...(executable.includes('%') ? ['/usr/bin/env', '--'] : []), executable, ...(appPath ? [appPath] : []), '--autostart'];
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    'Name=DeepSeek Harness',
    'Comment=DeepSeek Harness 客户端',
    `Exec=${args.map(quoteDesktopExecArg).join(' ')}`,
    `Icon=${desktopString(icon)}`,
    'Terminal=false',
    'Categories=Development;',
    'Hidden=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n');
}

function linuxAutostartEnabled(contents) {
  let active = false;
  const entries = {};
  for (const raw of String(contents).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      active = line === '[Desktop Entry]';
      continue;
    }
    if (!active) continue;
    const separator = line.indexOf('=');
    if (separator > 0) entries[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return entries.Type === 'Application' && Boolean(entries.Exec) &&
    String(entries.Hidden).toLowerCase() !== 'true' &&
    String(entries['X-GNOME-Autostart-enabled']).toLowerCase() !== 'false';
}

function parseVersion(value) {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([\da-zA-Z.-]+))?(?:\+[\da-zA-Z.-]+)?$/.exec(String(value).trim());
  if (!match) return null;
  return { core: match.slice(1, 4).map(part => BigInt(part || '0')), pre: match[4] ? match[4].split('.') : [] };
}

function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return 0;
  for (let i = 0; i < 3; i += 1) {
    if (left.core[i] !== right.core[i]) return left.core[i] > right.core[i] ? 1 : -1;
  }
  if (!left.pre.length || !right.pre.length) return Number(!left.pre.length) - Number(!right.pre.length);
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i += 1) {
    const x = left.pre[i];
    const y = right.pre[i];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const numericX = /^\d+$/.test(x);
    const numericY = /^\d+$/.test(y);
    if (numericX && numericY) {
      if (BigInt(x) === BigInt(y)) continue;
      return BigInt(x) > BigInt(y) ? 1 : -1;
    }
    if (numericX !== numericY) return numericX ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

function releaseUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'github.com' &&
      url.pathname.startsWith('/zhangjiabo522/dshup/releases/') ? url.href : '';
  } catch {
    return '';
  }
}

function selectReleaseAsset(assets, platform, arch) {
  const extensions = { linux: ['deb'], win32: ['exe'], darwin: ['dmg', 'zip'] }[platform];
  const architecture = {
    x64: /(?:^|[-_. ])(?:x64|amd64|x86_64)(?=$|[-_. ])/i,
    arm64: /(?:^|[-_. ])(?:arm64|aarch64)(?=$|[-_. ])/i,
    ia32: /(?:^|[-_. ])(?:ia32|i386|i686|x86(?![_-]64))(?=$|[-_. ])/i,
  }[arch];
  if (!extensions || !architecture) return null;
  const matches = [];
  for (const asset of Array.isArray(assets) ? assets : []) {
    if (!asset || !releaseUrl(asset.browser_download_url)) continue;
    const name = String(asset.name || '');
    const extension = name.split('.').pop().toLowerCase();
    const rank = extensions.indexOf(extension);
    if (rank === -1) continue;
    const universal = platform === 'darwin' && /(?:^|[-_. ])universal2?(?=$|[-_. ])/i.test(name);
    const legacyWindows = platform === 'win32' && arch === 'x64' && /^dshup-Setup-\d+\.\d+\.\d+(?:-[\da-z]+(?:[.-][\da-z]+)*)?(?:\+[\da-z]+(?:[.-][\da-z]+)*)?\.exe$/i.test(name);
    if (!architecture.test(name) && !universal && !legacyWindows) continue;
    if (platform === 'darwin' && extension === 'zip' && !/(?:^|[-_. ])(?:mac|macos|darwin|osx)(?=$|[-_. ])/i.test(name)) continue;
    matches.push({ asset, score: rank * 3 + Number(universal) + Number(legacyWindows) * 2 });
  }
  matches.sort((a, b) => a.score - b.score || String(a.asset.name).localeCompare(String(b.asset.name)));
  return matches[0]?.asset || null;
}

function releaseUpdateInfo(data, current, platform = process.platform, arch = process.arch) {
  const latest = String(data?.tag_name || '').replace(/^v/, '');
  const page = releaseUrl(data?.html_url) || RELEASES_URL;
  const asset = selectReleaseAsset(data?.assets, platform, arch);
  return {
    current,
    latest: parseVersion(latest) ? latest : '',
    url: asset ? releaseUrl(asset.browser_download_url) : page,
    releaseUrl: page,
    assetName: asset ? asset.name : '',
    hasUpdate: compareVersions(latest, current) > 0,
  };
}

module.exports = {
  RELEASES_URL,
  isTrustedPageUrl,
  quoteDesktopExecArg,
  linuxAutostartPath,
  createLinuxAutostart,
  linuxAutostartEnabled,
  compareVersions,
  selectReleaseAsset,
  releaseUpdateInfo,
};
