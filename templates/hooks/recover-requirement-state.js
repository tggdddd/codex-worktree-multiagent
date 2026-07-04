#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const cp = require("child_process");

const reqPaths = [
  path.join(".codex", "worktree-multiagent", "requirements.md"),
  "WORKTREE_MULTIAGENT_REQUIREMENTS.md",
];
const activeMarkers = [
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REBASE_HEAD",
  "rebase-merge",
  "rebase-apply",
];
const staleSeconds = Number(process.env.WORKTREE_MULTIAGENT_STALE_SECONDS || "60");

function body(line) {
  if (line.endsWith("\r\n")) return [line.slice(0, -2), "\r\n"];
  if (line.endsWith("\n")) return [line.slice(0, -1), "\n"];
  return [line, ""];
}

function gitPath(cwd, flag) {
  try {
    const out = cp.execFileSync("git", ["rev-parse", flag], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    }).trim();
    return path.isAbsolute(out) ? out : path.join(cwd, out);
  } catch {
    return null;
  }
}

function repoRoot(cwd) {
  return gitPath(cwd, "--show-toplevel") || cwd;
}

function gitDirs(root) {
  const dirs = [];
  const gitDir = gitPath(root, "--git-dir");
  const commonDir = gitPath(root, "--git-common-dir");
  for (const dir of [gitDir, commonDir]) {
    if (dir && fs.existsSync(dir) && !dirs.includes(dir)) dirs.push(dir);
  }
  if (commonDir) {
    const worktrees = path.join(commonDir, "worktrees");
    if (fs.existsSync(worktrees)) {
      for (const name of fs.readdirSync(worktrees)) {
        const dir = path.join(worktrees, name);
        if (fs.statSync(dir).isDirectory()) dirs.push(dir);
      }
    }
  }
  return { dirs, commonDir };
}

function activeGitOps(root) {
  const { dirs, commonDir } = gitDirs(root);
  const markers = [];
  for (const dir of dirs) {
    for (const marker of activeMarkers) {
      const markerPath = path.join(dir, marker);
      if (fs.existsSync(markerPath)) markers.push(markerPath);
    }
  }
  return { markers, commonDir };
}

function sanitizeTarget(target) {
  const value = target.trim().replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^[._]+|[._]+$/g, "");
  return value || "unknown";
}

function lockPaths(commonDir, mergeTarget) {
  if (!commonDir || !mergeTarget || mergeTarget === "unknown") return [];
  return [path.join(commonDir, "codex-merge-locks", `${sanitizeTarget(mergeTarget)}.lock`)];
}

function isStale(lockPath, now) {
  try {
    return now - fs.statSync(lockPath).mtimeMs / 1000 >= staleSeconds;
  } catch {
    return true;
  }
}

function removeStaleLock(lockPath, activeOps, now) {
  if (!fs.existsSync(lockPath)) return false;
  if (activeOps.length && !isStale(lockPath, now)) return false;
  if (lockPath.endsWith(".lock") && path.basename(path.dirname(lockPath)) === "codex-merge-locks") {
    fs.rmSync(lockPath, { recursive: true, force: true });
    return true;
  }
  return false;
}

function splitLines(text) {
  return text.match(/[^\n]*\n|[^\n]+/g) || [];
}

function blocks(lines) {
  const starts = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (/^##\s+(REQ-[^\s]+)\s*$/.test(body(lines[i])[0])) starts.push(i);
  }
  if (!starts.length) return [[null, lines]];
  const result = [];
  if (starts[0] > 0) result.push([null, lines.slice(0, starts[0])]);
  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i];
    const end = starts[i + 1] || lines.length;
    const reqId = body(lines[start])[0].match(/^##\s+(REQ-[^\s]+)\s*$/)[1];
    result.push([reqId, lines.slice(start, end)]);
  }
  return result;
}

function status(block) {
  for (const line of block) {
    const match = body(line)[0].match(/^\s*status\s*:\s*(\S+)/);
    if (match) return match[1].trim();
  }
  return null;
}

function mergeTarget(block) {
  for (const line of block) {
    const match = body(line)[0].match(/^\s*merge_target\s*:\s*(.+?)\s*$/);
    if (match) return match[1].trim();
  }
  return "unknown";
}

function replaceStatus(block, newStatus) {
  for (let i = 0; i < block.length; i += 1) {
    const [text, nl] = body(block[i]);
    const match = text.match(/^(\s*status\s*:\s*)(\S+)(.*)$/);
    if (match) {
      block[i] = `${match[1]}${newStatus}${match[3]}${nl}`;
      return;
    }
  }
}

function addNote(block, message) {
  const nl = block.some((line) => line.endsWith("\r\n")) ? "\r\n" : "\n";
  for (let i = 0; i < block.length; i += 1) {
    if (/^\s*notes\s*:\s*$/.test(body(block[i])[0])) {
      block.splice(i + 1, 0, `- ${message}${nl}`);
      return;
    }
  }
  if (block.length && block[block.length - 1].trim()) block.push(nl);
  block.push(`notes:${nl}`, `- ${message}${nl}`);
}

function recoverText(text, root, now = Date.now() / 1000) {
  const { markers, commonDir } = root ? activeGitOps(root) : { markers: [], commonDir: null };
  const output = [];
  const changes = [];
  for (const [reqId, block] of blocks(splitLines(text))) {
    const state = status(block);
    if (reqId && state === "in_progress") {
      replaceStatus(block, "ready");
      addNote(block, "auto-recovered by SessionStart hook: stale in_progress -> ready after session restart.");
      changes.push(`${reqId}: in_progress -> ready`);
    } else if (reqId && state === "merging") {
      const locks = lockPaths(commonDir, mergeTarget(block));
      const liveLock = locks.some((lock) => fs.existsSync(lock) && markers.length && !isStale(lock, now));
      if (!liveLock) {
        const removed = locks.filter((lock) => removeStaleLock(lock, markers, now));
        replaceStatus(block, "merge_pending");
        addNote(block, "auto-recovered by SessionStart hook: stale merging -> merge_pending after session restart.");
        changes.push(`${reqId}: merging -> merge_pending${removed.length ? `; removed lock ${removed.join(", ")}` : ""}`);
      }
    }
    output.push(...block);
  }
  return { text: output.join(""), changes };
}

function hookCwd() {
  if (process.stdin.isTTY) return process.cwd();
  try {
    const input = fs.readFileSync(0, "utf8").trim();
    if (input) {
      const data = JSON.parse(input);
      if (data.cwd) return data.cwd;
    }
  } catch {}
  return process.cwd();
}

function findRequirements(root) {
  for (const rel of reqPaths) {
    const file = path.join(root, rel);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

function run() {
  const root = repoRoot(hookCwd());
  const reqPath = findRequirements(root);
  if (!reqPath) return 0;
  const before = fs.readFileSync(reqPath, "utf8");
  const recovered = recoverText(before, root);
  if (!recovered.changes.length) return 0;
  fs.writeFileSync(reqPath, recovered.text, "utf8");
  const context = `Recovered worktree multiagent queue at ${reqPath}:\n- ${recovered.changes.join("\n- ")}`;
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: context,
    },
  }));
  return 0;
}

function selfTest() {
  const sample = `# queue

## REQ-1
status: in_progress
merge_target: main
notes:
- old

## REQ-2
status: merging
merge_target: main
`;
  const recovered = recoverText(sample, null, 1);
  if (!recovered.text.includes("status: ready")) throw new Error("in_progress was not recovered");
  if (!recovered.text.includes("status: merge_pending")) throw new Error("merging was not recovered");
  if (!recovered.changes.includes("REQ-1: in_progress -> ready")) throw new Error("missing ready change");
  if (!recovered.changes.includes("REQ-2: merging -> merge_pending")) throw new Error("missing merge_pending change");
  console.log("ok");
}

if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  try {
    process.exitCode = run();
  } catch (error) {
    console.error(`worktree-multiagent recovery skipped: ${error.message}`);
    process.exitCode = 0;
  }
}
