#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const rootDir = __dirname;
process.chdir(rootDir);

const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify.'));

// Output contract for tools and humans:
// - each step: STEP <name> <expanded command> duration_ms=<ms> status=<exit code> log=<step log path>
// - command stdout/stderr is streamed directly to log files, not printed or buffered in memory
// - output is deterministic: sequential order for normal steps, config order for parallel groups
// - on failure: print only the failed step log path

function nowMs() {
  return Date.now();
}

function shellQuote(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:=@%+,-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function parseDuration(value) {
  const match = String(value).trim().match(/^(\d+)(ms|s|m|h)?$/);
  if (!match) return 5 * 60 * 1000;
  const n = Number(match[1]);
  const unit = match[2] || 'ms';
  if (unit === 'h') return n * 60 * 60 * 1000;
  if (unit === 'm') return n * 60 * 1000;
  if (unit === 's') return n * 1000;
  return n;
}

function commandExists(name) {
  const result = spawnSync('sh', ['-c', `command -v ${shellQuote(name)} >/dev/null 2>&1`], {
    cwd: rootDir,
    stdio: 'ignore',
  });
  return result.status === 0;
}

function fileExists(name) {
  return fs.existsSync(path.join(rootDir, name));
}

function readJson(name) {
  return JSON.parse(fs.readFileSync(path.join(rootDir, name), 'utf8'));
}

function findFiles(dir, predicate, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'vendor' || entry.name.startsWith('.cache')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) findFiles(full, predicate, out);
    else if (predicate(full)) out.push(full);
  }
  return out;
}

function stepLogPath(name) {
  const safe = name.replace(/[^A-Za-z0-9_.-]/g, '_');
  return path.join(logDir, `verify.${safe}.${process.pid}.log`);
}

function expandCmd(cmd) {
  return cmd.replace(/\$([A-Z_][A-Z0-9_]*)/g, (m, name) => (process.env[name] !== undefined ? process.env[name] : m));
}

function printStepSummary(name, cmd, duration, status, log) {
  const logPart = log ? ` log=${log}` : '';
  console.log(`STEP ${name} ${expandCmd(cmd)} duration_ms=${duration} status=${status}${logPart}`);
}

function emitHint(name, log, pattern, fallbackRegex) {
  const text = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  if (!pattern) {
    if (!fallbackRegex) return;
    const regex = new RegExp(fallbackRegex, 'gi');
    const seen = new Set();
    const lines = [];
    let match;
    while ((match = regex.exec(text)) && lines.length < 40) {
      const line = (match[1] || match[0] || '').trim();
      if (line && !seen.has(line)) {
        seen.add(line);
        lines.push(line);
      }
    }
    if (lines.length > 0) console.log(lines.join('\n'));
    return;
  }
  const regex = new RegExp(pattern, 'i');
  const seen = new Set();
  const lines = [];
  for (const line of text.split('\n')) {
    if (regex.test(line)) {
      const trimmed = line.trim();
      if (trimmed && !seen.has(trimmed)) {
        seen.add(trimmed);
        lines.push(trimmed);
      }
    }
    if (lines.length >= 40) break;
  }
  if (lines.length > 0) console.log(lines.join('\n'));
}

function fail(result) {
  console.log(`failed step log: ${result.log}`);
  process.exit(result.status);
}

function runStep(step) {
  return new Promise((resolve) => {
    const name = step.name;
    const cmd = step.command;
    const log = stepLogPath(name);
    const start = nowMs();
    const child = spawn(cmd, {
      cwd: rootDir,
      shell: true,
      env: { ...process.env },
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const logStream = fs.createWriteStream(log, { flags: 'w' });
    child.stdout.pipe(logStream, { end: false });
    child.stderr.pipe(logStream, { end: false });

    let timedOut = false;
    let timer = null;
    if (step.timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        if (process.platform === 'win32') child.kill('SIGKILL');
        else {
          try { process.kill(-child.pid, 'SIGTERM'); } catch (_) {}
          setTimeout(() => {
            try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
          }, 1000).unref();
        }
      }, step.timeoutMs);
    }

    child.on('error', (err) => logStream.write(`\nverify spawn error: ${err.message}\n`));
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      if (timedOut) logStream.write(`\nverify timeout after ${step.timeoutMs}ms\n`);
      if (signal && !timedOut) logStream.write(`\nverify terminated by ${signal}\n`);
      logStream.end(() => {
        const status = timedOut ? 124 : (code === null ? 1 : code);
        resolve({ name, cmd, log, status, duration: nowMs() - start, hint: step.hint });
      });
    });
  });
}

function evalWhen(cond) {
  if (!cond) return true;
  if (cond.file) return cond.file.every((f) => fileExists(f));
  if (cond.command) return cond.command.every((c) => commandExists(c));
  if (cond.content) {
    if (cond.content.file) {
      const p = path.join(rootDir, cond.content.file);
      if (!fs.existsSync(p)) return false;
      return fs.readFileSync(p, 'utf8').includes(cond.content.contains);
    }
    if (cond.content.ext) {
      return findFiles(rootDir, (p) => p.endsWith(cond.content.ext)).some(
        (p) => fs.readFileSync(p, 'utf8').includes(cond.content.contains)
      );
    }
    return false;
  }
  if (cond.env) {
    for (const [key, val] of Object.entries(cond.env)) {
      if (process.env[key] !== val) return false;
    }
    return true;
  }
  if (cond.not) return !evalWhen(cond.not);
  if (cond.all) return cond.all.every((c) => evalWhen(c));
  if (cond.any) return cond.any.some((c) => evalWhen(c));
  return true;
}

function loadConfig() {
  for (const name of ['verify.config.json', '.verify.json']) {
    if (fileExists(name)) return readJson(name);
  }
  throw new Error('No verify.config.json or .verify.json found in project root');
}

function resolveSteps(config) {
  const steps = new Map();
  for (const [name, def] of Object.entries(config.steps || {})) {
    if (!evalWhen(def.when)) continue;
    steps.set(name, {
      name,
      command: def.command,
      timeoutMs: def.timeout ? parseDuration(def.timeout) : null,
      hint: def.hint || null,
    });
  }
  return steps;
}

function normalizeStepRef(ref) {
  if (typeof ref === 'string') return ref;
  if (ref && typeof ref.name === 'string') return ref.name;
  throw new Error('order entries must be step names, step objects, or arrays of those entries');
}

function buildPlan(order, registry) {
  const seen = new Set();
  const materialize = (item) => {
    if (Array.isArray(item)) {
      const group = item.map(materialize).filter(Boolean);
      return group.length > 0 ? group : null;
    }
    const name = normalizeStepRef(item);
    if (seen.has(name) || !registry.has(name)) return null;
    seen.add(name);
    return registry.get(name);
  };
  return order.map(materialize).filter(Boolean);
}

function filterPlan(plan, only) {
  if (only.length === 0) return plan;
  const wanted = new Set(only);
  const filterItem = (item) => {
    if (Array.isArray(item)) {
      const group = item.filter((step) => wanted.has(step.name));
      return group.length > 0 ? group : null;
    }
    return wanted.has(item.name) ? item : null;
  };
  return plan.map(filterItem).filter(Boolean);
}

function cliOrder() {
  const arg = process.argv.slice(2).find((value) => value.startsWith('[') || value.startsWith('--order='));
  if (!arg) {
    if (process.env.VERIFY_ORDER) return JSON.parse(process.env.VERIFY_ORDER);
    return null;
  }
  const raw = arg.startsWith('--order=') ? arg.slice('--order='.length) : arg;
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('order must be a JSON array');
  return parsed;
}

function setEnvDefaults(config) {
  for (const [key, val] of Object.entries(config.env || {})) {
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

function parallelGroupName(steps) {
  const names = steps.map((step) => step.name).join('_');
  if (names === 'vet_build_test_race') return 'parallel';
  if (names === 'vet_nox11_build_nox11_test_race_nox11') return 'parallel_nox11';
  return `parallel_${names}`;
}

function killProcessGroup(child, signal) {
  if (process.platform === 'win32') {
    child.kill(signal);
    return;
  }
  try { process.kill(-child.pid, signal); } catch (_) {}
}

async function runParallelGroup(steps) {
  const groupStart = nowMs();
  let failureSeen = false;
  const records = [];

  function stopUnfinished() {
    for (const record of records) {
      if (record.result) continue;
      record.cancelledByFailure = true;
      killProcessGroup(record.child, 'SIGTERM');
    }
    setTimeout(() => {
      for (const record of records) {
        if (!record.result) killProcessGroup(record.child, 'SIGKILL');
      }
    }, 1000).unref();
  }

  for (const step of steps) {
    const log = stepLogPath(step.name);
    const start = nowMs();
    const logStream = fs.createWriteStream(log, { flags: 'w' });
    const child = spawn(step.command, {
      cwd: rootDir,
      shell: true,
      env: { ...process.env },
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const record = { step, child, result: null, cancelledByFailure: false, done: null };
    records.push(record);

    child.stdout.pipe(logStream, { end: false });
    child.stderr.pipe(logStream, { end: false });
    child.on('error', (err) => logStream.write(`\nverify spawn error: ${err.message}\n`));
    record.done = new Promise((resolve) => {
      child.on('close', (code, signal) => {
        if (signal) logStream.write(`\nverify terminated by ${signal}\n`);
        logStream.end(() => {
          const result = {
            name: step.name,
            cmd: step.command,
            log,
            status: code === null ? 1 : code,
            duration: nowMs() - start,
            hint: step.hint,
            cancelledByFailure: record.cancelledByFailure,
          };
          record.result = result;
          if (result.status !== 0 && !failureSeen && !result.cancelledByFailure) {
            failureSeen = true;
            stopUnfinished();
          }
          resolve(result);
        });
      });
    });
  }

  await Promise.all(records.map((record) => record.done));
  const ordered = records.map((record) => record.result);
  const failed = ordered.find((result) => result.status !== 0 && !result.cancelledByFailure) || ordered.find((result) => result.status !== 0);
  if (failed) fail(failed);

  for (const result of ordered) {
    printStepSummary(result.name, result.cmd, result.duration, result.status, result.log);
  }
  printStepSummary(parallelGroupName(steps), steps.map((step) => step.name).join(' '), nowMs() - groupStart, 0, '');
}

async function runPlan(plan, config) {
  for (const item of plan) {
    if (Array.isArray(item)) {
      await runParallelGroup(item);
      continue;
    }

    const result = await runStep(item);
    if (result.status !== 0) fail(result);
    printStepSummary(result.name, result.cmd, result.duration, result.status, result.log);
  }
}

async function main() {
  const config = loadConfig();
  setEnvDefaults(config);

  const registry = resolveSteps(config);

  const cli = cliOrder();
  const order = cli || config.order || [];
  let plan = buildPlan(order, registry);

  const only = (process.env.VERIFY_STEPS || '').split(',').map((s) => s.trim()).filter(Boolean);
  plan = filterPlan(plan, only);

  if (plan.length === 0) {
    printStepSummary('detect', 'no steps matched conditions', 0, 2, '');
    process.exit(2);
  }

  await runPlan(plan, config);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(2);
});
