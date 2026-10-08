import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectRoot, withLocalLock } from './setup.mjs';
import { probeRadar } from './launcher-health.mjs';

export function watchdogDecision(result, failures, now = Date.now()) {
  const snapshot = result?.status === 'ready' ? result.snapshot : null;
  const nextFailures = snapshot ? 0 : failures + 1;
  const stuck = snapshot?.scanner?.scanInProgress && snapshot.scanner.cycleStartedAt
    && now - snapshot.scanner.cycleStartedAt > 8 * 60_000;
  return { failures: nextFailures, recycle: nextFailures >= 3 || Boolean(stuck) || snapshot?.transport?.stalled === true };
}

export async function superviseRadar({ root = projectRoot, port = Number(process.env.RADAR_PORT || 3791),
  env = process.env, spawnImpl = spawn, probe = probeRadar, lock = withLocalLock, pause = delay,
  schedule = setInterval, cancel = clearInterval, now = Date.now, processImpl = process } = {}) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('RADAR_PORT 必须为 1024 到 65535 的整数。');
  let stopping = false, child, killDeadline, fatal;
  const stopController = new AbortController();
  const terminate = monitored => {
    if (!monitored || monitored.exitCode !== null || monitored.signalCode) return;
    monitored.kill('SIGTERM');
    clearTimeout(killDeadline);
    killDeadline = setTimeout(() => {
      if (monitored.exitCode === null && !monitored.signalCode) monitored.kill('SIGKILL');
    }, 5000);
    killDeadline.unref();
  };
  const stop = () => { stopping = true; stopController.abort(); terminate(child); };
  processImpl.on('SIGINT', stop); processImpl.on('SIGTERM', stop);
  try {
    // A normal second launch must reuse the healthy instance before waiting on
    // the lifetime supervisor lock held by that already-running process.
    if ((await probe({ root, port })).status === 'ready') return;
    await lock(`supervisor-${port}`, async () => {
      let crashes = 0;
      while (!stopping) {
        const initial = await probe({ root, port });
        if (initial.status === 'ready') return; // Already running from this exact installation.
        if (initial.status !== 'absent') throw new Error('本地端口暂未就绪，未启动重复进程；请稍后重试。');
        const started = now();
        let failures = 0, recycle = false, checking = false;
        child = spawnImpl(process.execPath, ['--use-env-proxy', path.join(root, 'src/main.mjs')], {
          cwd: root, env: { ...env, RADAR_PORT: String(port), RADAR_SUPERVISED: '1' }, stdio: 'inherit'
        });
        const watchdog = schedule(async () => {
          if (checking || stopping) return;
          checking = true;
          const monitored = child;
          try {
            const result = await probe({ root, port, timeoutMs: 3000 });
            if (stopping || child !== monitored) return;
            // Provider errors still have a healthy local loop. Never restart
            // merely because AVE is offline, rate-limited or out of quota.
            const decision = watchdogDecision(result, failures, now());
            failures = decision.failures;
            if (decision.recycle) { recycle = true; terminate(monitored); }
          } catch (error) {
            // An unrelated listener is never treated as our healthy child.
            // Stop only the process we spawned; never kill a PID by its port.
            if (child === monitored) { fatal = error; stop(); }
          } finally { checking = false; }
        }, 30_000);
        const result = await new Promise(resolve => {
          child.once('error', error => resolve({ error }));
          child.once('exit', code => resolve({ code }));
        });
        cancel(watchdog); clearTimeout(killDeadline); child = null;
        if (fatal) throw fatal;
        if (result.error) throw new Error('无法启动本地雷达进程，请检查运行环境。');
        if (stopping || result.code === 0 && !recycle) break;
        crashes = now() - started > 5 * 60_000 ? 1 : crashes + 1;
        console.error(`雷达进程退出，自动恢复尝试 ${crashes}；扫描记录将从本机恢复。`);
        await pause(Math.min(60_000, 3000 * 2 ** Math.min(crashes - 1, 5)), undefined, { signal: stopController.signal })
          .catch(error => { if (!stopping) throw error; });
      }
    });
  } finally {
    processImpl.off('SIGINT', stop); processImpl.off('SIGTERM', stop);
    clearTimeout(killDeadline);
  }
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  try { await superviseRadar(); }
  catch (error) { console.error(`守护启动未完成：${error.message}`); process.exitCode = 1; }
}
