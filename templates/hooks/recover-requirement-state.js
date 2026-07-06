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
const lifecycleFields = [
  "owner_agent",
  "agent_type",
  "started_at",
  "heartbeat_at",
  "worktree_path",
  "source_branch",
  "source_commit",
  "validation",
  "lock_owner",
  "last_agent_message",
];

function body(line) {
  if (line.endsWith("\r\n")) return [line.slice(0, -2), "\r\n"];
  if (line.endsWith("\n")) return [line.slice(0, -1), "\n"];
  return [line, ""];
}

function detectedNl(block) {
  return block.some((line) => line.endsWith("\r\n")) ? "\r\n" : "\n";
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
  const value = String(target || "")
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/g, "_")
    .replace(/^[._]+|[._]+$/g, "");
  return value || "unknown";
}

function lockPaths(commonDir, mergeTarget) {
  if (!commonDir || !mergeTarget || mergeTarget === "unknown") return [];
  return [path.join(commonDir, "codex-merge-locks", `${sanitizeTarget(mergeTarget)}.lock`)];
}

function isPathStale(lockPath, now) {
  try {
    return now - fs.statSync(lockPath).mtimeMs / 1000 >= staleSeconds;
  } catch {
    return true;
  }
}

function removeStaleLock(lockPath, now) {
  if (!fs.existsSync(lockPath)) return false;
  if (!isPathStale(lockPath, now)) return false;
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
  if (!starts.length) return [{ reqId: null, lines }];
  const result = [];
  if (starts[0] > 0) result.push({ reqId: null, lines: lines.slice(0, starts[0]) });
  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i];
    const end = starts[i + 1] || lines.length;
    const reqId = body(lines[start])[0].match(/^##\s+(REQ-[^\s]+)\s*$/)[1];
    result.push({ reqId, lines: lines.slice(start, end) });
  }
  return result;
}

function parseQueue(text) {
  return blocks(splitLines(text));
}

function queueText(queue) {
  return queue.flatMap((entry) => entry.lines).join("");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getField(block, key) {
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*:\\s*(.*?)\\s*$`);
  for (const line of block) {
    const match = body(line)[0].match(pattern);
    if (match) return match[1].trim();
  }
  return "";
}

function status(block) {
  return getField(block, "status") || null;
}

function mergeTarget(block) {
  return getField(block, "merge_target") || "unknown";
}

function isTopLevelListSection(lineText) {
  return /^(acceptance|constraints|notes)\s*:\s*$/.test(lineText.trim());
}

function insertFieldIndex(block) {
  const preferred = [
    "status",
    "source",
    "summary",
    "scope",
    "paths",
    "merge_target",
    ...lifecycleFields,
  ];
  let last = 0;
  for (let i = 1; i < block.length; i += 1) {
    const text = body(block[i])[0];
    if (isTopLevelListSection(text)) break;
    const key = text.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/);
    if (key && preferred.includes(key[1])) last = i;
  }
  return last + 1;
}

function compactValue(value, max = 240) {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}

function setField(block, key, value) {
  const nl = detectedNl(block);
  const safeValue = compactValue(value, key === "last_agent_message" ? 360 : 240);
  const pattern = new RegExp(`^(\\s*${escapeRegExp(key)}\\s*:\\s*)(.*?)(\\s*)$`);
  for (let i = 0; i < block.length; i += 1) {
    const [text, lineNl] = body(block[i]);
    const match = text.match(pattern);
    if (match) {
      block[i] = `${match[1]}${safeValue}${match[3]}${lineNl}`;
      return true;
    }
  }
  block.splice(insertFieldIndex(block), 0, `${key}: ${safeValue}${nl}`);
  return true;
}

function removeField(block, key) {
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*:`);
  for (let i = block.length - 1; i >= 0; i -= 1) {
    if (pattern.test(body(block[i])[0])) block.splice(i, 1);
  }
}

function replaceStatus(block, newStatus) {
  return setField(block, "status", newStatus);
}

function addNote(block, message) {
  const nl = detectedNl(block);
  for (let i = 0; i < block.length; i += 1) {
    if (/^\s*notes\s*:\s*$/.test(body(block[i])[0])) {
      block.splice(i + 1, 0, `- ${message}${nl}`);
      return;
    }
  }
  if (block.length && block[block.length - 1].trim()) block.push(nl);
  block.push(`notes:${nl}`, `- ${message}${nl}`);
}

function clearOwnership(block) {
  for (const key of ["owner_agent", "agent_type", "started_at", "heartbeat_at", "lock_owner"]) {
    removeField(block, key);
  }
}

function parseTime(value) {
  const ms = Date.parse(value || "");
  return Number.isFinite(ms) ? ms / 1000 : null;
}

function hasFreshOwner(block, now) {
  const owner = getField(block, "owner_agent");
  if (!owner) return false;
  const t = parseTime(getField(block, "heartbeat_at") || getField(block, "started_at"));
  if (!t) return false;
  return now - t < staleSeconds;
}

function findEntry(queue, reqId) {
  return queue.find((entry) => entry.reqId === reqId);
}

function readInput() {
  if (process.stdin.isTTY) return { data: {}, raw: "" };
  try {
    const raw = fs.readFileSync(0, "utf8");
    const trimmed = raw.trim();
    if (!trimmed) return { data: {}, raw };
    return { data: JSON.parse(trimmed), raw };
  } catch {
    return { data: {}, raw: "" };
  }
}

function optionValue(name) {
  const eq = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const idx = process.argv.indexOf(name);
  if (idx >= 0) return process.argv[idx + 1] || "";
  return "";
}

function hookEventName(input) {
  return (
    optionValue("--event") ||
    input.hook_event_name ||
    input.hookEventName ||
    input.event_name ||
    input.event ||
    "SessionStart"
  );
}

function firstValue(obj, keys, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 3) return "";
  for (const key of keys) {
    if (typeof obj[key] === "string" && obj[key].trim()) return obj[key].trim();
  }
  for (const value of Object.values(obj)) {
    const found = firstValue(value, keys, depth + 1);
    if (found) return found;
  }
  return "";
}

function stringifyInteresting(input) {
  const values = [];
  for (const key of [
    "prompt",
    "user_prompt",
    "input",
    "message",
    "last_assistant_message",
    "lastAssistantMessage",
    "agent_context",
    "agentContext",
  ]) {
    const value = input[key];
    if (typeof value === "string") values.push(value);
    else if (value && typeof value === "object") values.push(JSON.stringify(value));
  }
  return values.join("\n");
}

function transcriptText(input) {
  const transcriptPath =
    firstValue(input, ["agent_transcript_path", "agentTranscriptPath", "transcript_path", "transcriptPath"]) ||
    "";
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return "";
  try {
    const text = fs.readFileSync(transcriptPath, "utf8");
    return text.slice(-100000);
  } catch {
    return "";
  }
}

function lastAssistantMessage(input) {
  return (
    firstValue(input, ["last_assistant_message", "lastAssistantMessage", "last_message", "lastMessage"]) ||
    stringifyInteresting(input)
  );
}

function findReqId(input, extraText = "") {
  const direct = firstValue(input, ["req_id", "reqId", "requirement_id", "requirementId"]);
  if (direct && /^REQ-[A-Za-z0-9_.:-]+$/.test(direct)) return direct;
  const haystack = `${stringifyInteresting(input)}\n${extraText}`;
  const match = haystack.match(/\bREQ-[A-Za-z0-9_.:-]+\b/);
  return match ? match[0].replace(/[.:-]+$/, "") : "";
}

function agentId(input) {
  return (
    firstValue(input, ["agent_id", "agentId", "subagent_id", "subagentId", "session_id", "sessionId"]) ||
    "unknown"
  );
}

function agentType(input, text = "") {
  const direct =
    firstValue(input, ["agent_type", "agentType", "agent_name", "agentName", "subagent_type", "subagentType"]) ||
    "";
  if (direct) return direct;
  if (/worktree-worker/i.test(text)) return "worktree-worker";
  if (/worktree-integrator/i.test(text)) return "worktree-integrator";
  if (/worktree-explorer/i.test(text)) return "worktree-explorer";
  return "unknown";
}

function parseBranch(text) {
  const patterns = [
    /source[_ -]?branch\s*[:=]\s*([^\s,;]+)/i,
    /task[_ -]?branch\s*[:=]\s*([^\s,;]+)/i,
    /branch\s*[:=]\s*([^\s,;]+)/i,
    /(?:源分支|任务分支)\s*[:：]\s*([^\s,;]+)/,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1].replace(/[.,;]+$/, "");
  }
  return "";
}

function parseWorktreePath(text) {
  const labels = [
    "worktree_path",
    "worktree path",
    "worktree",
    "工作树",
    "工作区",
  ];
  const pattern = new RegExp(`^\\s*(?:${labels.map(escapeRegExp).join("|")})\\s*[:：=]\\s*(.+?)\\s*$`, "im");
  const match = text.match(pattern);
  return match ? match[1].trim().replace(/^["']|["']$/g, "") : "";
}

function parseCommit(text) {
  const patterns = [
    /source[_ -]?commit\s*[:=]\s*([0-9a-f]{7,40})/i,
    /commit(?:\s+id)?\s*[:=]\s*([0-9a-f]{7,40})/i,
    /(?:源提交|提交)\s*[:：]\s*([0-9a-f]{7,40})/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1];
  }
  const loose = text.match(/\b[0-9a-f]{7,40}\b/i);
  return loose ? loose[0] : "";
}

function extractJsonObject(text, marker) {
  const markerIndex = text.indexOf(marker);
  if (markerIndex < 0) return null;
  const start = text.indexOf("{", markerIndex + marker.length);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
    } else if (char === "\"") {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function parseStructuredHandoff(text) {
  const raw = extractJsonObject(text, "WTMA_HANDOFF");
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function handoffValue(handoff, keys) {
  for (const key of keys) {
    const value = handoff[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function parseValidation(text) {
  const inline = text.match(/(?:validation|验证|验收(?:命令)?|tests?|test command|命令)\s*[:：]\s*([^\r\n]+)/i);
  if (inline) return compactValue(inline[1], 240);
  const line = text
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => /^(validation|验证|验收|tests?|test command|命令)\b/i.test(item));
  if (!line) return "";
  const labelled = line.match(/(?:validation|验证|验收(?:命令)?|tests?|test command|命令)\s*[:：]\s*(.+)$/i);
  return compactValue(labelled ? labelled[1] : line, 240);
}

function normalizeOutcome(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["merged", "blocked", "merge_waiting", "merge_pending"].includes(normalized)) return normalized;
  return "";
}

function parseOutcome(text) {
  const lower = text.toLowerCase();
  const statusMatch = lower.match(/(?:^|\n)\s*(?:status|state|合并结果|merge result)\s*[:：]\s*([a-z_]+)/i);
  const explicit = statusMatch ? statusMatch[1] : "";
  const negativeMerged = /\bnot\s+(?:yet\s+)?merged\b|\bunmerged\b/.test(lower) || /未合并/.test(text);
  if (explicit === "merged" || (!negativeMerged && (/\bmerged\b/.test(lower) || /已合并|合并完成/.test(text)))) return "merged";
  if (explicit === "blocked") return "blocked";
  if (explicit === "merge_waiting" || /\bmerge_waiting\b|waiting for .*merge lock|等待.*merge lock|等待.*合并锁/.test(lower)) {
    return "merge_waiting";
  }
  if (/\bblocked\b|\bfailed\b|\bfailure\b/.test(lower) || /阻塞|无法/.test(text)) return "blocked";
  if (explicit === "merge_pending" || /\bmerge_pending\b/.test(lower)) return "merge_pending";
  return "unknown";
}

function resolveWorktreePath(root, value) {
  if (!value) return "";
  return path.isAbsolute(value) ? value : path.resolve(root || process.cwd(), value);
}

function gitCommitExists(root, rev) {
  if (!root || !rev) return true;
  try {
    cp.execFileSync("git", ["cat-file", "-e", `${rev}^{commit}`], {
      cwd: root,
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 2000,
    });
    return true;
  } catch {
    return false;
  }
}

function gitCommitContains(root, ancestor, descendant) {
  if (!root || !ancestor || !descendant) return true;
  try {
    cp.execFileSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
      cwd: root,
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 3000,
    });
    return true;
  } catch {
    return false;
  }
}

function recoverableFields(block) {
  return {
    worktreePath: getField(block, "worktree_path"),
    sourceBranch: getField(block, "source_branch"),
    sourceCommit: getField(block, "source_commit"),
    validation: getField(block, "validation"),
  };
}

function hasRecoverableFields(fields) {
  return Boolean(fields.worktreePath && fields.sourceBranch && fields.sourceCommit && fields.validation);
}

function handoffProblems(root, fields) {
  const problems = [];
  if (!fields.worktreePath) problems.push("missing worktree_path");
  if (!fields.sourceBranch) problems.push("missing source_branch");
  if (!fields.sourceCommit) problems.push("missing source_commit");
  if (!fields.validation) problems.push("missing validation");
  if (root && fields.worktreePath) {
    const resolved = resolveWorktreePath(root, fields.worktreePath);
    if (!fs.existsSync(resolved)) problems.push(`worktree_path does not exist: ${resolved}`);
  }
  if (root && fields.sourceCommit && !gitCommitExists(root, fields.sourceCommit)) {
    problems.push(`source_commit is not reachable: ${fields.sourceCommit}`);
  }
  if (root && fields.sourceBranch && !gitCommitExists(root, fields.sourceBranch)) {
    problems.push(`source_branch is not reachable: ${fields.sourceBranch}`);
  }
  if (
    root &&
    fields.sourceBranch &&
    fields.sourceCommit &&
    gitCommitExists(root, fields.sourceBranch) &&
    gitCommitExists(root, fields.sourceCommit) &&
    !gitCommitContains(root, fields.sourceCommit, fields.sourceBranch)
  ) {
    problems.push(`source_commit ${fields.sourceCommit} is not contained in source_branch ${fields.sourceBranch}`);
  }
  return problems;
}

function hookOutput(event, context) {
  return {
    hookSpecificOutput: {
      hookEventName: event,
      additionalContext: context,
    },
  };
}

function blockOutput(event, reason) {
  return {
    decision: "block",
    reason,
    ...hookOutput(event, reason),
  };
}

function dispatchSubagentStart(queue, input, now) {
  const text = stringifyInteresting(input);
  const reqId = findReqId(input, text);
  const type = agentType(input, text);
  if (!reqId || type === "worktree-explorer") return { changes: [] };
  const entry = findEntry(queue, reqId);
  if (!entry) {
    return { block: blockOutput("SubagentStart", `SubagentStart could not find ${reqId} in the requirements ledger.`) };
  }
  const block = entry.lines;
  const owner = agentId(input);
  const currentOwner = getField(block, "owner_agent");
  if (currentOwner && currentOwner !== owner && hasFreshOwner(block, now)) {
    return {
      changes: [],
      context: `${reqId} already has fresh owner ${currentOwner}; ${owner} did not retake it.`,
    };
  }

  const changes = [];
  const currentStatus = status(block);
  if (currentStatus === "ready") {
    replaceStatus(block, "in_progress");
    changes.push(`${reqId}: ready -> in_progress`);
  }
  setField(block, "owner_agent", owner);
  setField(block, "agent_type", type);
  setField(block, "started_at", new Date(now * 1000).toISOString());
  setField(block, "heartbeat_at", new Date(now * 1000).toISOString());
  setField(block, "last_agent_message", "SubagentStart hook registered lifecycle owner.");
  addNote(block, `SubagentStart hook registered ${type} owner ${owner}.`);
  changes.push(`${reqId}: owner_agent=${owner}`);
  return { changes };
}

function dispatchSubagentStop(queue, input, root) {
  const message = lastAssistantMessage(input);
  const transcript = transcriptText(input);
  const combined = `${message}\n${transcript}`;
  const handoff = parseStructuredHandoff(combined);
  const type = agentType(input, combined);
  const reqId = handoffValue(handoff, ["req_id", "reqId", "requirement_id", "requirementId"]) || findReqId(input, combined);
  if (!reqId || type === "worktree-explorer") return { changes: [] };
  const entry = findEntry(queue, reqId);
  if (!entry) {
    return { block: blockOutput("SubagentStop", `SubagentStop could not find ${reqId} in the requirements ledger.`) };
  }

  const block = entry.lines;
  const owner = agentId(input);
  const outcome =
    normalizeOutcome(handoffValue(handoff, ["status", "state", "outcome", "merge_result", "mergeResult"])) ||
    parseOutcome(combined);
  const worktreePath = handoffValue(handoff, ["worktree_path", "worktreePath", "worktree"]) || parseWorktreePath(combined) || getField(block, "worktree_path");
  const sourceBranch = handoffValue(handoff, ["source_branch", "sourceBranch", "branch", "task_branch", "taskBranch"]) || parseBranch(combined) || getField(block, "source_branch");
  const sourceCommit = handoffValue(handoff, ["source_commit", "sourceCommit", "commit", "commit_id", "commitId"]) || parseCommit(combined) || getField(block, "source_commit");
  const validation = handoffValue(handoff, ["validation", "validation_result", "validationResult", "tests", "test_result", "testResult"]) || parseValidation(combined) || getField(block, "validation");
  const summary = compactValue(message || combined, 360);
  const changes = [];

  setField(block, "owner_agent", owner);
  setField(block, "agent_type", type);
  setField(block, "heartbeat_at", new Date().toISOString());
  if (summary) setField(block, "last_agent_message", summary);
  if (worktreePath) setField(block, "worktree_path", worktreePath);
  if (sourceBranch) setField(block, "source_branch", sourceBranch);
  if (sourceCommit) setField(block, "source_commit", sourceCommit);
  if (validation) setField(block, "validation", validation);

  const fields = { worktreePath, sourceBranch, sourceCommit, validation };
  const problems = handoffProblems(root, fields);
  if (outcome === "merged") {
    if (problems.length) {
      return {
        block: blockOutput("SubagentStop", `SubagentStop for ${reqId} reported merged but has an invalid WTMA handoff:\n- ${problems.join("\n- ")}`),
      };
    }
    replaceStatus(block, "merged");
    addNote(block, `SubagentStop hook recorded ${owner} as merged.`);
    changes.push(`${reqId}: -> merged`);
    return { changes };
  }
  if (outcome === "blocked") {
    replaceStatus(block, "blocked");
    addNote(block, `SubagentStop hook recorded ${owner} as blocked: ${summary || "no details"}`);
    changes.push(`${reqId}: -> blocked`);
    return { changes };
  }
  const hasRecoverableHandoff = hasRecoverableFields(fields);
  if (outcome === "merge_waiting") {
    const missing = handoffProblems(null, fields);
    const suffix = missing.length ? ` Missing handoff fields: ${missing.join(", ")}.` : "";
    return {
      block: blockOutput(
        "SubagentStop",
        `SubagentStop for ${reqId} reported merge_waiting. Keep the worker/integrator flow alive until it either merges or emits WTMA_HANDOFF with status merge_pending for integrator recovery.${suffix}`,
      ),
    };
  }
  if ((outcome === "merge_pending" || sourceBranch || sourceCommit || worktreePath) && problems.length) {
    return {
      block: blockOutput("SubagentStop", `SubagentStop for ${reqId} has an invalid WTMA handoff:\n- ${problems.join("\n- ")}`),
    };
  }
  if ((outcome === "merge_pending" || sourceBranch || sourceCommit) && hasRecoverableHandoff) {
    replaceStatus(block, "merge_pending");
    addNote(block, `SubagentStop hook recorded ${owner} handoff ${sourceBranch}@${sourceCommit} from ${worktreePath}.`);
    changes.push(`${reqId}: -> merge_pending`);
    return { changes };
  }

  const reason = `SubagentStop for ${reqId} did not provide a recoverable WTMA_HANDOFF; keep the subagent flow open until worktree_path, source_branch, source_commit, and validation are recorded.`;
  return { block: blockOutput("SubagentStop", reason) };
}

function dispatchStop(queue) {
  const problems = [];
  const mergingByTarget = new Map();
  for (const entry of queue) {
    if (!entry.reqId) continue;
    const block = entry.lines;
    const state = status(block);
    const target = mergeTarget(block);
    if (state === "in_progress" && (!getField(block, "owner_agent") || !getField(block, "heartbeat_at"))) {
      problems.push(`${entry.reqId} is in_progress without persisted owner_agent/heartbeat_at.`);
    }
    if (state === "merge_waiting" && !hasRecoverableFields(recoverableFields(block))) {
      problems.push(`${entry.reqId} is merge_waiting without worktree_path/source_branch/source_commit/validation.`);
    }
    if (state === "merging") {
      if (!getField(block, "lock_owner") && !getField(block, "owner_agent")) {
        problems.push(`${entry.reqId} is merging without lock_owner or owner_agent.`);
      }
      const existing = mergingByTarget.get(target);
      if (existing) problems.push(`${entry.reqId} and ${existing} are both merging into ${target}.`);
      else mergingByTarget.set(target, entry.reqId);
    }
  }
  if (problems.length) {
    return { block: blockOutput("Stop", `Worktree multiagent ledger is not end-safe:\n- ${problems.join("\n- ")}`) };
  }
  return { changes: [] };
}

function dispatchSessionStart(queue, root, now) {
  const { markers, commonDir } = root ? activeGitOps(root) : { markers: [], commonDir: null };
  const changes = [];
  for (const entry of queue) {
    if (!entry.reqId) continue;
    const block = entry.lines;
    const state = status(block);
    const stale = !hasFreshOwner(block, now);
    if (state === "in_progress" && stale) {
      const fields = recoverableFields(block);
      if (hasRecoverableFields(fields)) {
        replaceStatus(block, "merge_pending");
        clearOwnership(block);
        addNote(block, "auto-recovered by SessionStart hook: stale in_progress with complete handoff -> merge_pending.");
        changes.push(`${entry.reqId}: in_progress -> merge_pending`);
      } else if (fields.sourceCommit || fields.sourceBranch || fields.worktreePath || fields.validation) {
        replaceStatus(block, "blocked");
        clearOwnership(block);
        addNote(block, "auto-recovered by SessionStart hook: stale in_progress has partial handoff and cannot be safely recovered automatically.");
        changes.push(`${entry.reqId}: in_progress -> blocked`);
      } else {
        replaceStatus(block, "ready");
        clearOwnership(block);
        addNote(block, "auto-recovered by SessionStart hook: stale in_progress without source_commit -> ready.");
        changes.push(`${entry.reqId}: in_progress -> ready`);
      }
    } else if (state === "merge_waiting" && stale) {
      const fields = recoverableFields(block);
      replaceStatus(block, hasRecoverableFields(fields) ? "merge_pending" : "blocked");
      clearOwnership(block);
      if (hasRecoverableFields(fields)) {
        addNote(block, "auto-recovered by SessionStart hook: stale merge_waiting with complete handoff -> merge_pending.");
        changes.push(`${entry.reqId}: merge_waiting -> merge_pending`);
      } else {
        addNote(block, "auto-recovered by SessionStart hook: stale merge_waiting has partial handoff and cannot be safely recovered automatically.");
        changes.push(`${entry.reqId}: merge_waiting -> blocked`);
      }
    } else if (state === "merging") {
      const locks = lockPaths(commonDir, mergeTarget(block));
      const lockStateAllowsRecovery =
        !locks.length ||
        locks.every((lock) => !fs.existsSync(lock) || isPathStale(lock, now));
      if (!markers.length && lockStateAllowsRecovery) {
        const removed = locks.filter((lock) => removeStaleLock(lock, now));
        replaceStatus(block, "merge_pending");
        clearOwnership(block);
        addNote(block, "auto-recovered by SessionStart hook: stale merging without active Git marker -> merge_pending.");
        changes.push(`${entry.reqId}: merging -> merge_pending${removed.length ? `; removed lock ${removed.join(", ")}` : ""}`);
      }
    }
  }
  return { changes };
}

function findRequirements(root) {
  for (const rel of reqPaths) {
    const file = path.join(root, rel);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

function runWithText(text, input, eventName, root, now = Date.now() / 1000) {
  const queue = parseQueue(text);
  let result = { changes: [] };
  if (eventName === "SubagentStart") result = dispatchSubagentStart(queue, input, now);
  else if (eventName === "SubagentStop") result = dispatchSubagentStop(queue, input, root);
  else if (eventName === "Stop") result = dispatchStop(queue);
  else if (eventName === "SessionStart") result = dispatchSessionStart(queue, root, now);
  else result = { changes: [] };

  return {
    text: queueText(queue),
    changes: result.changes || [],
    block: result.block || null,
    context: result.context || "",
  };
}

function hookCwd(input) {
  return input.cwd || process.cwd();
}

function run() {
  const { data } = readInput();
  const eventName = hookEventName(data);
  const root = repoRoot(hookCwd(data));
  const reqPath = findRequirements(root);
  if (!reqPath) return 0;

  const before = fs.readFileSync(reqPath, "utf8");
  const result = runWithText(before, data, eventName, root);
  if (result.block) {
    console.log(JSON.stringify(result.block));
    return 0;
  }
  if (result.text !== before) fs.writeFileSync(reqPath, result.text, "utf8");
  if (result.changes.length || result.context) {
    const context = result.context || `Worktree multiagent hook ${eventName} updated ${reqPath}:\n- ${result.changes.join("\n- ")}`;
    console.log(JSON.stringify(hookOutput(eventName, context)));
  }
  return 0;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function selfTest() {
  const now = Date.now() / 1000;

  const startSample = `# queue

## REQ-start
status: ready
merge_target: main
notes:
- old
`;
  const started = runWithText(startSample, {
    hook_event_name: "SubagentStart",
    agent_id: "agent-1",
    agent_type: "worktree-worker",
    prompt: "take REQ-start",
  }, "SubagentStart", null, now);
  assert(started.text.includes("status: in_progress"), "SubagentStart did not set in_progress");
  assert(started.text.includes("owner_agent: agent-1"), "SubagentStart did not record owner");

  const stopSample = `# queue

## REQ-stop
status: in_progress
owner_agent: agent-2
heartbeat_at: 2000-01-01T00:00:00.000Z
merge_target: main
notes:
- old
`;
  const stopped = runWithText(stopSample, {
    hook_event_name: "SubagentStop",
    agent_id: "agent-2",
    agent_type: "worktree-worker",
    last_assistant_message: 'WTMA_HANDOFF {"req_id":"REQ-stop","status":"merge_pending","worktree_path":"../worktrees/req-stop","source_branch":"feature/req-stop","source_commit":"abc1234","validation":"npm test passed"}',
  }, "SubagentStop", null, now);
  assert(stopped.text.includes("status: merge_pending"), "SubagentStop did not set merge_pending");
  assert(stopped.text.includes("worktree_path: ../worktrees/req-stop"), "SubagentStop did not record worktree path");
  assert(stopped.text.includes("source_branch: feature/req-stop"), "SubagentStop did not record branch");
  assert(stopped.text.includes("source_commit: abc1234"), "SubagentStop did not record commit");
  assert(stopped.text.includes("validation: npm test passed"), "SubagentStop did not record validation");

  const waiting = runWithText(stopSample, {
    hook_event_name: "SubagentStop",
    agent_id: "agent-3",
    agent_type: "worktree-worker",
    last_assistant_message: 'WTMA_HANDOFF {"req_id":"REQ-stop","status":"merge_waiting","worktree_path":"../worktrees/req-stop","source_branch":"feature/req-stop","source_commit":"def5678","validation":"npm test passed"}',
  }, "SubagentStop", null, now);
  assert(waiting.block && waiting.block.decision === "block", "SubagentStop merge_waiting did not block");

  const incomplete = runWithText(stopSample, {
    hook_event_name: "SubagentStop",
    agent_id: "agent-4",
    agent_type: "worktree-worker",
    last_assistant_message: "REQ-stop implementation still running",
  }, "SubagentStop", null, now);
  assert(incomplete.block && incomplete.block.decision === "block", "SubagentStop incomplete result did not block");

  const badMerged = runWithText(stopSample, {
    hook_event_name: "SubagentStop",
    agent_id: "agent-5",
    agent_type: "worktree-worker",
    last_assistant_message: 'WTMA_HANDOFF {"req_id":"REQ-stop","status":"merged"}',
  }, "SubagentStop", null, now);
  assert(badMerged.block && badMerged.block.decision === "block", "SubagentStop merged without evidence did not block");

  const unsafeStop = runWithText(stopSample.replace("owner_agent: agent-2\nheartbeat_at: 2000-01-01T00:00:00.000Z\n", ""), {}, "Stop", null, now);
  assert(unsafeStop.block && unsafeStop.block.decision === "block", "Stop did not block unpersisted active state");

  const sessionSample = `# queue

## REQ-ready
status: in_progress
owner_agent: old
heartbeat_at: 2000-01-01T00:00:00.000Z
merge_target: main

## REQ-pending
status: in_progress
owner_agent: old
heartbeat_at: 2000-01-01T00:00:00.000Z
worktree_path: ../worktrees/req-pending
source_branch: feature/req-pending
source_commit: abc1234
validation: npm test passed
merge_target: main

## REQ-partial
status: in_progress
owner_agent: old
heartbeat_at: 2000-01-01T00:00:00.000Z
source_commit: abc1234
merge_target: main

## REQ-wait
status: merge_waiting
owner_agent: old
heartbeat_at: 2000-01-01T00:00:00.000Z
worktree_path: ../worktrees/req-wait
source_branch: feature/req-wait
source_commit: def5678
validation: npm test passed
merge_target: main

## REQ-merge
status: merging
merge_target: main
lock_owner: old
`;
  const recovered = runWithText(sessionSample, {}, "SessionStart", null, now);
  assert(recovered.changes.includes("REQ-ready: in_progress -> ready"), "SessionStart did not recover in_progress without commit");
  assert(recovered.changes.includes("REQ-pending: in_progress -> merge_pending"), "SessionStart did not recover in_progress with commit");
  assert(recovered.changes.includes("REQ-partial: in_progress -> blocked"), "SessionStart did not block partial handoff");
  assert(recovered.changes.includes("REQ-wait: merge_waiting -> merge_pending"), "SessionStart did not recover merge_waiting");
  assert(recovered.changes.includes("REQ-merge: merging -> merge_pending"), "SessionStart did not recover stale merging");
  console.log("ok");
}

if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  try {
    process.exitCode = run();
  } catch (error) {
    console.error(`worktree-multiagent hook skipped: ${error.message}`);
    process.exitCode = 0;
  }
}
