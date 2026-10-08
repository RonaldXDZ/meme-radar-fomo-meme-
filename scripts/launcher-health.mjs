import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

export const STARTUP_TIMEOUT_MS = 90_000;
const transientErrors = new Set(['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNABORTED']);
export const radarInstanceId = root => crypto.createHash('sha256').update(path.join(root, 'public')).digest('hex').slice(0, 16);
const conflict = port => Object.assign(new Error(`${port} 端口已有其他服务或另一份雷达，请关闭它或选择其他 RADAR_PORT。`), { code: 'RADAR_PORT_CONFLICT' });

function installedVersion(root) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
    return typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value) ? value : null;
  } catch { return null; }
}

export function probeRadar({ root, port, timeoutMs = 1500, get = http.get, expectedVersion = installedVersion(root) }) {
  return new Promise((resolve, reject) => {
    let done = false, request, deadlineTimer;
    const finish = (value, error) => {
      if (done) return;
      done = true;
      clearTimeout(deadlineTimer);
      if (error) reject(error); else resolve(value);
    };
    const interrupted = () => finish({ status: 'starting' });
    const timedOut = () => { if (!done) { interrupted(); request?.destroy(); } };
    // Socket timeout is idle-only: a peer can keep it alive indefinitely by
    // dripping bytes. Bound the entire probe independently of HTTP activity.
    deadlineTimer = setTimeout(timedOut, timeoutMs);
    deadlineTimer.unref?.();
    try {
      request = get(`http://127.0.0.1:${port}/health`, { timeout: timeoutMs }, response => {
        let body = '', size = 0;
        response.on('data', chunk => {
          if (done) return;
          size += Buffer.byteLength(chunk);
          if (size > 32_000) { finish(null, conflict(port)); request.destroy(); return; }
          body += chunk;
        });
        response.on('aborted', interrupted);
        response.on('error', interrupted);
        response.on('end', () => {
          if (done) return;
          let value;
          try { value = JSON.parse(body); } catch { finish(null, conflict(port)); return; }
          if (response.statusCode !== 200 || value?.service !== 'meme-radar' || value.execution !== false
            || value.instanceId !== radarInstanceId(root)) { finish(null, conflict(port)); return; }
          if (!expectedVersion || value.version !== expectedVersion) {
            finish(null, Object.assign(new Error('端口上的雷达与此安装包版本不一致。请先关闭旧版雷达，再启动新版本；不会覆盖本机配置。'),
              { code: 'RADAR_VERSION_MISMATCH' }));
            return;
          }
          finish({ status: 'ready', snapshot: value });
        });
      });
      request.on('timeout', timedOut);
      request.on('error', error => {
        if (error.code === 'ECONNREFUSED') finish({ status: 'absent' });
        else if (transientErrors.has(error.code)) interrupted();
        else finish(null, Object.assign(new Error('本地服务检查失败，请检查端口访问权限后重试。'), { code: 'RADAR_HEALTH_ERROR' }));
      });
    } catch {
      finish(null, Object.assign(new Error('无法检查本地服务端口。'), { code: 'RADAR_HEALTH_ERROR' }));
    }
  });
}

export async function waitForRadar({ root, port, timeoutMs = STARTUP_TIMEOUT_MS, intervalMs = 300,
  probe = probeRadar, now = Date.now, pause = delay, stopped = () => false }) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const result = await probe({ root, port, timeoutMs: Math.min(1500, Math.max(1, deadline - now())) });
    if (result.status === 'ready') return result.snapshot;
    if (stopped()) throw Object.assign(new Error('本地启动进程已退出，请查看 logs/radar-launch.log。'), { code: 'RADAR_PROCESS_EXIT' });
    const remaining = deadline - now();
    if (remaining > 0) await pause(Math.min(intervalMs, remaining));
  }
  throw Object.assign(new Error('等待本机服务就绪已超过 90 秒；后台可能仍在恢复，请查看 logs/radar-launch.log 后重试。'), { code: 'RADAR_START_TIMEOUT' });
}

export function openRadarBrowser(url, { platform = process.platform, spawnImpl = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const command = platform === 'darwin' ? '/usr/bin/open' : platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
    const args = platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
    const child = spawnImpl(command, args, { stdio: 'ignore', windowsHide: true });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('浏览器未能自动打开。')));
  });
}
