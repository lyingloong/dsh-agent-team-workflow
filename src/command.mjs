/** Bounded shell execution with owned process-tree cancellation. */
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
const error = (code, message) => Object.assign(new Error(message), { code });

export function executeCommand(command, { cwd, env, signal, maxBuffer = 1_000_000 }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const child = spawn(command, { cwd, env, shell: true, windowsHide: true, detached: process.platform !== 'win32' });
    const stdout = [], stderr = []; let bytes = 0, failure, closed = false, stopping;
    const collect = target => chunk => {
      bytes += chunk.length;
      if (bytes > maxBuffer) { stop(error('command_output_limit', `Command output exceeded ${maxBuffer} bytes`)); return; }
      target.push(chunk);
    };
    const stop = reason => {
      failure ??= reason;
      if (stopping || closed || !child.pid) return;
      stopping = terminateTree(child.pid).catch(cause => {
        failure = error('command_cleanup_failed', `Cannot confirm command process-tree termination: ${cause.message}`);
      });
    };
    const abort = () => stop(signal.reason ?? error('execution_aborted', 'Command cancelled'));
    child.stdout.on('data', collect(stdout)); child.stderr.on('data', collect(stderr));
    child.on('error', cause => { failure ??= cause; });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.once('close', async (code, sig) => {
      closed = true; signal?.removeEventListener('abort', abort);
      // Kill completion precedes settlement; a shell exiting is not proof that
      // its command/children have stopped writing to the worktree.
      if (stopping) await stopping;
      const result = { stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), code: code ?? 1 };
      if (failure) reject(Object.assign(failure, { stdout: result.stdout, stderr: result.stderr, exitCode: result.code }));
      else if (code !== 0) reject(Object.assign(error(code ?? 1, `Command exited ${code ?? sig}`), result));
      else resolve(result);
    });
  });
}
async function terminateTree(pid) {
  if (process.platform === 'win32') {
    // Do not use shell interpolation for a PID or terminate only cmd.exe.
    await execFileAsync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
  } else {
    try { process.kill(-pid, 'SIGTERM'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
    await new Promise(resolve => setTimeout(resolve, 250));
    try { process.kill(-pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
  }
}
