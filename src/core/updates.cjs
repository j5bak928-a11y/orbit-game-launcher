'use strict';
const fs = require('node:fs/promises');

const repository = 'j5bak928-a11y/orbit-game-launcher';
const releasePage = `https://github.com/${repository}/releases`;
const releaseApi = `https://api.github.com/repos/${repository}/releases/latest`;

function versionParts(value) {
  if (typeof value !== 'string') return null;
  const match = /^v?((?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8}))$/.exec(value);
  return match?.[0] === value ? match[1].split('.').map(Number) : null;
}

function createUpdateService({app, platform = process.platform, fetchRelease = fetch, openExternal, tokenPath} = {}) {
  const unsupported = platform !== 'win32' || !app?.isPackaged;
  const idle = unsupported
    ? {state:'unsupported', message:'Update checks are available in packaged Windows builds.'}
    : {state:'idle', message:'Update check not started.'};
  let status = idle;
  let pending;

  async function checkRelease() {
    const headers = {Accept:'application/vnd.github+json', 'User-Agent':'Orbit Launcher'};
    if (tokenPath) {
      const token = await fs.readFile(tokenPath, 'utf8').then(value => value.trim(), error => {
        if (error.code !== 'ENOENT') throw error;
        return '';
      });
      if (token) {
        if (!/^[A-Za-z0-9_]{1,512}$/.test(token)) return {state:'access', message:'GitHub access is required. Open Releases or configure a read-only token.'};
        headers.Authorization = `Bearer ${token}`;
      }
    }
    const response = await fetchRelease(releaseApi, {headers, redirect:'error', signal:AbortSignal.timeout(8000)});
    if ([401, 403, 404].includes(response.status) && response.headers.get('x-ratelimit-remaining') !== '0') {
      return {state:'access', message:'GitHub access is required. Open Releases or configure a read-only token.'};
    }
    if (!response.ok) throw Error('GitHub release request failed.');
    const release = await response.json();
    const next = versionParts(release?.tag_name);
    const current = versionParts(app.getVersion().split('+')[0]);
    if (!next || !current || release.draft !== false || release.prerelease !== false) throw Error('Invalid stable release.');
    const difference = next.map((value, index) => value - current[index]).find(value => value !== 0) || 0;
    return difference > 0
      ? {state:'available', message:'Orbit {version} is available.', version:next.join('.'), tag:release.tag_name}
      : {state:'current', message:'Orbit is up to date.'};
  }

  function check() {
    if (unsupported) return Promise.resolve(idle);
    pending ??= checkRelease().then(result => status = result, () => status = {
      state:'error', message:'Could not check GitHub for updates.'
    }).finally(() => {pending = null;});
    return pending;
  }

  async function openDownload(tag) {
    if (tag != null && !versionParts(tag)) throw Error('Invalid Orbit release.');
    return openExternal(tag == null ? `${releasePage}/latest` : `${releasePage}/tag/${tag}`);
  }

  function install() {
    throw Error('Automatic updates are unavailable until signed releases are configured.');
  }

  return {check, openDownload, install, getStatus:() => status};
}

module.exports = {createUpdateService};
