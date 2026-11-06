"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const { codegraphProjectSnapshot, codegraphAffectedTests } = require("./codegraph-adapter.js");
const { semgrepProjectSnapshot, semgrepScan } = require("./semgrep-adapter.js");
const { readChangeSet, workingTreeRevision } = require("./code-context-revision.js");
const { loadBuildGraph } = require("./build-graph.js");
const { resolveBuildConfig } = require("./build-runner.js");
const { focusedTestMappingsForPaths, isTestPath: centralizedTestPath, testCommandsForPaths } = require("./test-paths.js");
const { listBuiltInRoleTopologies } = require("./role-topologies.js");
const { normalizeRequiredProviders, providerReadiness } = require("./provider-readiness.js");

// .worktrees holds linked checkouts of the same repository on other branches.
const DEFAULT_IGNORE = new Set([".git", ".claude", ".worktrees", "node_modules", ".pi", "dist", "build", "coverage", ".next", "target", "vendor", "__pycache__", ".venv", "venv", ".pytest_cache", ".mypy_cache", ".ruff_cache"]);
const LANGUAGE_BY_EXT = {
  ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".jsx": "javascript",
  ".ts": "typescript", ".tsx": "typescript", ".mts": "typescript", ".cts": "typescript",
  ".py": "python", ".rs": "rust", ".go": "go", ".java": "java", ".kt": "kotlin", ".kts": "kotlin",
  ".rb": "ruby", ".php": "php", ".cs": "csharp", ".cpp": "cpp", ".cc": "cpp", ".c": "c", ".h": "c/cpp",
  ".sh": "shell", ".bash": "shell", ".zsh": "shell", ".md": "markdown", ".json": "json", ".yml": "yaml", ".yaml": "yaml",
};

function sha256(value) { return crypto.createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex"); }
function readText(file) { try { return fs.readFileSync(file, "utf8"); } catch { return ""; } }
function readJson(file, fallback = {}) { try { return JSON.parse(readText(file)); } catch { return fallback; } }
function exists(cwd, rel) { return fs.existsSync(path.join(cwd, rel)); }
function rel(cwd, file) { return path.relative(cwd, file).replace(/\\/g, "/"); }
function stat(file) { try { return fs.statSync(file); } catch { return null; } }
function isRunnableFile(cwd, file) {
  const full = path.isAbsolute(file) ? file : path.resolve(cwd, file);
  const info = stat(full);
  return Boolean(info?.isFile() && (process.platform === "win32" || (info.mode & 0o111) !== 0));
}
function run(cwd, cmd, args, timeout = 5000) { try { return execFileSync(cmd, args, { cwd, encoding: "utf8", timeout, stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return ""; } }

function walkFiles(cwd, options = {}) {
  const maxFiles = options.maxFiles || 2500;
  const maxBytes = options.maxBytes || 2_000_000;
  const ignore = new Set([...(options.ignore || []), ...DEFAULT_IGNORE]);
  const out = [];
  function walk(dir) {
    if (out.length >= maxFiles) return;
    let rows = [];
    try { rows = fs.readdirSync(path.join(cwd, dir)); } catch { return; }
    for (const name of rows) {
      if (ignore.has(name)) continue;
      const r = dir ? `${dir}/${name}` : name;
      const full = path.join(cwd, r);
      const s = stat(full);
      if (!s) continue;
      if (s.isDirectory()) walk(r);
      else if (s.isFile() && s.size <= maxBytes) out.push({ path: r, bytes: s.size, ext: path.extname(name).toLowerCase(), mtimeMs: s.mtimeMs });
      if (out.length >= maxFiles) break;
    }
  }
  walk("");
  return out;
}

function packageScripts(cwd) { return readJson(path.join(cwd, "package.json"), {}).scripts || {}; }
function dependencyManifests(cwd) {
  const manifests = [];
  const pkg = readJson(path.join(cwd, "package.json"), null);
  if (pkg) manifests.push({ file: "package.json", kind: "npm", dependencies: { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }, scripts: pkg.scripts || {} });
  for (const file of ["pyproject.toml", "requirements.txt", "Cargo.toml", "go.mod", "pom.xml", "build.gradle", "build.gradle.kts", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"]) if (exists(cwd, file)) manifests.push({ file, kind: inferManifestKind(file), bytes: stat(path.join(cwd, file))?.size || 0 });
  return manifests;
}
function inferManifestKind(file) { if (/package|pnpm|yarn/.test(file)) return "npm"; if (/pyproject|requirements/.test(file)) return "python"; if (/Cargo/.test(file)) return "rust"; if (/go\.mod/.test(file)) return "go"; if (/pom|gradle/.test(file)) return "jvm"; return "dependency"; }

function detectLanguages(files, cwd) {
  const counts = {};
  for (const file of files) {
    const language = LANGUAGE_BY_EXT[file.ext];
    if (language && !["json", "yaml", "markdown"].includes(language)) counts[language] = (counts[language] || 0) + 1;
  }
  if (exists(cwd, "package.json") && !counts.javascript && !counts.typescript) counts.javascript = 1;
  if (exists(cwd, "pyproject.toml") || exists(cwd, "requirements.txt")) counts.python ||= 1;
  if (exists(cwd, "Cargo.toml")) counts.rust ||= 1;
  if (exists(cwd, "go.mod")) counts.go ||= 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([language, count]) => ({ language, files: count }));
}

function ciWorkflows(cwd) {
  const out = [];
  const gh = path.join(cwd, ".github", "workflows");
  try { for (const name of fs.readdirSync(gh)) if (/\.ya?ml$/.test(name)) out.push({ file: `.github/workflows/${name}`, kind: "github-actions", bytes: stat(path.join(gh, name))?.size || 0 }); } catch {}
  for (const file of [".gitlab-ci.yml", "Jenkinsfile", "azure-pipelines.yml", ".circleci/config.yml"]) if (exists(cwd, file)) out.push({ file, kind: "ci", bytes: stat(path.join(cwd, file))?.size || 0 });
  return out;
}

function isTestPath(p) { return centralizedTestPath(p); }
function isSourcePath(p) { return /(^|\/)(src|lib|extensions|app|packages)\//.test(p) || /\.(js|ts|jsx|tsx|py|rs|go|java|kt)$/.test(p); }

function extractSymbols(cwd, files, options = {}) {
  const maxFiles = options.maxSymbolFiles || 500;
  const candidates = files.filter((f) => /\.(mjs|cjs|js|jsx|ts|tsx|py|go|rs)$/.test(f.path)).slice(0, maxFiles);
  const symbols = [];
  for (const file of candidates) {
    const text = readText(path.join(cwd, file.path));
    const patterns = [
      { kind: "export", re: /\bexport\s+(?:async\s+)?(?:function|class|const|let|var|type|interface)\s+([A-Za-z_$][\w$]*)/g },
      { kind: "function", re: /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g },
      { kind: "class", re: /\bclass\s+([A-Za-z_$][\w$]*)\b/g },
      { kind: "commonjs", re: /\b(?:module\.exports|exports)\.([A-Za-z_$][\w$]*)\s*=/g },
      { kind: "python", re: /^\s*(?:def|class)\s+([A-Za-z_][\w]*)\b/gm },
    ];
    for (const { kind, re } of patterns) {
      let match;
      while ((match = re.exec(text)) && symbols.length < 5000) symbols.push({ file: file.path, name: match[1], kind });
    }
  }
  return symbols;
}

function candidateTestsFor(file, allFiles) {
  const stem = path.basename(file).replace(/\.[^.]+$/, "").replace(/^index$/, path.basename(path.dirname(file)));
  const normalized = stem.toLowerCase();
  return allFiles.filter((f) => isTestPath(f.path) && (f.path.toLowerCase().includes(normalized) || readText(path.join(f.cwd || "", f.path)).toLowerCase().includes(normalized))).map((f) => f.path).slice(0, 12);
}

function changedFiles(cwd) {
  return readChangeSet(cwd).changedPaths;
}

function shellQuote(arg) {
  const text = String(arg);
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`;
}
function commandLine(command, args = []) { return [command, ...(args || [])].map(shellQuote).join(" "); }
function verifierCommandText(verifier) { return verifier.commandLine || (verifier.args?.length ? commandLine(verifier.command, verifier.args) : verifier.command); }
function pythonCompileTargets(index, limit = Number(process.env.PI_PROJECT_INTEL_PY_COMPILE_LIMIT || 80)) {
  const isPython = (file) => /\.py$/.test(file || "") && !String(file).startsWith("-") && !/[\r\n]/.test(String(file));
  const changed = (index.changedFiles || []).filter(isPython);
  const sources = (index.sources || []).map((f) => f.path).filter(isPython);
  const tests = (index.tests || []).map((f) => f.path).filter(isPython);
  const candidates = changed.length ? [...changed, ...sources, ...tests] : [...sources, ...tests];
  return dedupeBy(candidates, (file) => file).slice(0, Math.max(1, limit));
}

function riskForFile(file) {
  let score = 1;
  const reasons = [];
  if (isSourcePath(file)) { score += 2; reasons.push("runtime/source path"); }
  if (/security|auth|token|secret|privacy|policy|permission/i.test(file)) { score += 3; reasons.push("security/privacy-sensitive name"); }
  if (/package-lock|pnpm-lock|yarn.lock|Cargo.lock|go.sum/.test(file)) { score += 2; reasons.push("dependency lockfile"); }
  if (/\.pi\/extensions|extensions\//.test(file)) { score += 2; reasons.push("extension behavior"); }
  return { score, reasons };
}

function recommendVerifiers(cwd, index) {
  const scripts = index.scripts || packageScripts(cwd);
  const verifiers = [];
  const add = (profile, command, reason, kind = "unit", options = {}) => {
    const opts = Array.isArray(options) ? { artifacts: options } : options;
    const args = Array.isArray(opts.args) ? opts.args.map(String) : [];
    const spec = { profile, command, reason, kind, artifacts: opts.artifacts || [] };
    if (args.length) { spec.args = args; spec.commandLine = commandLine(command, args); }
    if (opts.files?.length) spec.files = opts.files;
    if (opts.automatic != null) spec.automatic = Boolean(opts.automatic);
    verifiers.push(spec);
  };
  const pyTargets = pythonCompileTargets(index);
  if (pyTargets.length) {
    add("changed", "python3", "python syntax compile for discovered Python files", "compile", { args: ["-m", "py_compile", ...pyTargets], artifacts: pyTargets, files: ["**/*.py"], automatic: true });
  }
  const focusedMappings = focusedTestMappingsForPaths(index.changedFiles || [], { availableTests: (index.tests || []).map((test) => test.path) });
  for (const mapping of focusedMappings) {
    for (const command of testCommandsForPaths([mapping.test])) {
      add("changed", command.command, `focused verifier for ${mapping.source}`, command.kind, { args: command.args, artifacts: [mapping.test], files: [mapping.source], automatic: true });
    }
  }
  if (scripts.test) add("quick", "npm test", "package.json test script", "unit");
  if (scripts.lint) add("changed", "npm run lint", "package.json lint script", "lint");
  if (scripts.typecheck) add("changed", "npm run typecheck", "package.json typecheck script", "compile");
  const buildConfig = resolveBuildConfig(cwd);
  if (buildConfig.test?.command && !(buildConfig.test.command === "npm" && scripts.test))
    add("quick", buildConfig.test.command, `${buildConfig.source} project test command`, "unit", { args: buildConfig.test.args || [], automatic: true });
  for (const binary of buildConfig.test?.binaries || []) {
    if (isRunnableFile(cwd, binary)) add("quick", binary, `${buildConfig.source} native test binary`, "unit", { automatic: true });
  }
  if (exists(cwd, "scripts/check-integration-boundary.sh")) add("quick", "bash scripts/check-integration-boundary.sh", "integration boundary script", "integration");
  if (exists(cwd, "scripts/check-all.sh")) add("full", "bash scripts/check-all.sh", "repo full-check script", "integration");
  if (exists(cwd, "pyproject.toml") || exists(cwd, "pytest.ini")) add("quick", "pytest -q", "python test config", "unit");
  const nodeTests = (index.tests || []).filter((t) => /\.test\.js$/.test(t.path)).slice(0, 3);
  for (const test of nodeTests) add("quick", `node ${test.path}`, "discovered node test", "unit");
  return dedupeBy(verifiers, (v) => `${v.profile}:${verifierCommandText(v)}`);
}

function recommendTopologies(index) {
  const langs = new Set((index.languages || []).map((x) => x.language));
  const installed = new Set(listBuiltInRoleTopologies().map((topology) => topology.topologyId));
  const topologies = ["planner-coder-verifier", "reviewer-verifier-gate", "research-advisory", "planning-advisory"];
  if (index.docs?.length) topologies.push("docs-update");
  if (index.ci?.length) topologies.push("failing-ci-triage");
  if (langs.has("javascript") || langs.has("typescript") || langs.has("python") || langs.has("go") || langs.has("rust")) topologies.push("refactor-with-safety-net");
  if (index.dependencies?.length) topologies.push("dependency-upgrade");
  if (index.codegraph?.initialized) topologies.push("research-advisory");
  if (index.semgrep?.ready) topologies.push("security-review");
  return Array.from(new Set(topologies)).filter((topologyId) => installed.has(topologyId));
}

function safeCommands(cwd, index) {
  const commands = ["git status --short", "git diff --stat", "git diff --name-only", "rg <query>"];
  for (const v of recommendVerifiers(cwd, index)) if (v.profile !== "full") commands.push(verifierCommandText(v));
  if (exists(cwd, "scripts/check-all.sh")) commands.push("bash scripts/check-all.sh");
  return Array.from(new Set(commands));
}

function dedupeBy(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of items) { const key = keyFn(item); if (!seen.has(key)) { seen.add(key); out.push(item); } }
  return out;
}

function createProjectIndex(cwd = process.cwd(), options = {}) {
  const files = walkFiles(cwd, options).map((f) => ({ ...f, cwd }));
  const tests = files.filter((f) => isTestPath(f.path));
  const sources = files.filter((f) => isSourcePath(f.path) && !isTestPath(f.path));
  const index = {
    generatedAt: new Date().toISOString(),
    cwd,
    fingerprint: sha256(files.map((f) => `${f.path}:${f.bytes}:${Math.round(f.mtimeMs)}`).join("\n")).slice(0, 16),
    files: files.map(({ cwd: _cwd, ...f }) => f),
    languages: detectLanguages(files, cwd),
    scripts: packageScripts(cwd),
    dependencies: dependencyManifests(cwd),
    ci: ciWorkflows(cwd),
    docs: files.filter((f) => /(^|\/)docs\/|README\.md$|\.md$/.test(f.path)).map((f) => ({ path: f.path, bytes: f.bytes })).slice(0, 200),
    tests: tests.map((f) => ({ path: f.path, bytes: f.bytes })).slice(0, 500),
    sources: sources.map((f) => ({ path: f.path, bytes: f.bytes })).slice(0, 1000),
    symbols: extractSymbols(cwd, files, options),
    changedFiles: changedFiles(cwd),
    revision: workingTreeRevision(cwd, { configuration: options.configuration }),
  };
  index.codegraph = options.codegraph === false ? { enabled: false, skipped: true } : codegraphProjectSnapshot(cwd, { timeoutMs: options.codegraphTimeoutMs });
  index.semgrep = options.semgrep === false ? { enabled: false, skipped: true } : semgrepProjectSnapshot(cwd, { timeoutMs: options.semgrepTimeoutMs });
  const requiredProviders = normalizeRequiredProviders(options.requiredProviders);
  index.providerPolicy = {
    requiredProviders,
    states: [
      providerReadiness("codegraph", { required: requiredProviders.includes("codegraph"), applicable: options.codegraph !== false, ready: Boolean(index.codegraph.initialized), reason: index.codegraph.errorCode || (index.codegraph.initialized ? "initialized" : options.codegraph === false ? "disabled" : "not-initialized"), errorCode: index.codegraph.errorCode || null }),
      providerReadiness("semgrep", { required: requiredProviders.includes("semgrep"), applicable: options.semgrep !== false, ready: Boolean(index.semgrep.ready), reason: index.semgrep.errorCode || (index.semgrep.ready ? "scan-ready" : options.semgrep === false ? "disabled" : "not-ready"), errorCode: index.semgrep.errorCode || null }),
    ],
  };
  if (options.buildGraph === false) index.buildGraph = { enabled: false, skipped: true };
  else {
    const build = loadBuildGraph(cwd, { configuration: options.configuration, buildDirs: options.buildDirs });
    index.buildGraph = { enabled: true, fingerprint: build.fingerprint, facts: build.graph.facts.size, providers: build.graph.providerStatuses() };
  }
  index.verifierProfiles = recommendVerifiers(cwd, index);
  index.recommendedTopologies = recommendTopologies(index);
  index.safeCommands = safeCommands(cwd, index);
  return index;
}

function testImpact(cwd = process.cwd(), inputFiles = null, options = {}) {
  const index = createProjectIndex(cwd, options);
  const files = inputFiles?.length ? inputFiles : index.changedFiles;
  const fileObjs = index.files.map((f) => ({ ...f, cwd }));
  const semgrep = options.semgrep === false || !files.length ? { ok: false, skipped: true, reason: files.length ? "disabled" : "no-files", findings: [], summary: { findings: 0, files: 0, severityCounts: {} } } : semgrepScan(cwd, files, { timeoutMs: options.semgrepTimeoutMs });
  const semgrepFindings = semgrep.findings || [];
  const graphByFile = new Map();
  for (const file of files) graphByFile.set(file, options.codegraph === false ? { ok: false, skipped: true, tests: [] } : codegraphAffectedTests(cwd, [file], { timeoutMs: options.codegraphTimeoutMs }));
  const graphTests = Array.from(new Set(Array.from(graphByFile.values()).flatMap((result) => result.tests || []).filter(Boolean)));
  const graphCommands = testCommandsForPaths(graphTests).slice(0, 10).map((command) => command.commandLine);
  const gaps = files.filter((file) => !isTestPath(file)).map((file) => {
    const lexicalTests = candidateTestsFor(file, fileObjs);
    const fileGraphTests = Array.from(new Set((graphByFile.get(file)?.tests || []).filter(Boolean)));
    const existingTests = Array.from(new Set([...lexicalTests, ...fileGraphTests]));
    const risk = riskForFile(file);
    const fileFindings = semgrepFindings.filter((finding) => finding.path === file);
    if (fileFindings.length) {
      risk.score += Math.min(4, 1 + fileFindings.filter((f) => /ERROR|WARNING/i.test(f.severity || "")).length);
      risk.reasons.push(`Semgrep findings: ${fileFindings.length}`);
    }
    return { file, existingTests, lexicalTests, graphTests: fileGraphTests, semgrepFindings: fileFindings, risk, gap: existingTests.length === 0 || risk.score >= 4, recommendation: existingTests.length ? `Run/update ${existingTests.slice(0, 3).join(", ")}` : `Add focused test near tests/ for ${file}` };
  });
  const requiredProviders = normalizeRequiredProviders(options.requiredProviders);
  const codegraphReady = Array.from(graphByFile.values()).some((result) => result.ok);
  const codegraph = { ok: codegraphReady, skipped: Array.from(graphByFile.values()).every((result) => result.skipped), tests: graphTests, bySource: Object.fromEntries(Array.from(graphByFile, ([file, result]) => [file, { ok: result.ok, skipped: result.skipped, reason: result.reason, tests: result.tests || [], errorCode: result.run?.code }])), readiness: providerReadiness("codegraph", { required: requiredProviders.includes("codegraph"), applicable: Boolean(files.length) && options.codegraph !== false, ready: codegraphReady, reason: codegraphReady ? "affected-tests-ready" : options.codegraph === false ? "disabled" : "unavailable" }) };
  const semgrepResult = { ok: semgrep.ok, skipped: semgrep.skipped, reason: semgrep.reason, summary: semgrep.summary, findings: semgrepFindings, readiness: providerReadiness("semgrep", { required: requiredProviders.includes("semgrep"), applicable: Boolean(files.length) && options.semgrep !== false, ready: semgrep.ok === true, reason: semgrep.errorCode || semgrep.reason || (semgrep.ok ? "scan-ready" : "unavailable"), errorCode: semgrep.errorCode || null }) };
  return { generatedAt: new Date().toISOString(), changedFiles: files, existingTests: index.tests, codegraph, semgrep: semgrepResult, providerPolicy: { requiredProviders, states: [codegraph.readiness, semgrepResult.readiness] }, gaps, recommendedCommands: Array.from(new Set([...index.verifierProfiles.map(verifierCommandText), ...graphCommands])), summary: { files: files.length, gaps: gaps.filter((g) => g.gap).length, highRisk: gaps.filter((g) => g.risk.score >= 4).length } };
}

function compactArchitectureCards(cwd = process.cwd(), options = {}) {
  const index = options.index || createProjectIndex(cwd, { ...options, codegraph: options.codegraph ?? false, semgrep: options.semgrep ?? false });
  const cards = [{ provider: "project-intelligence", id: "architecture:root", symbolId: "architecture:root", kind: "file", path: "README.md", signature: `${path.basename(cwd)}: ${(index.languages || []).map((item) => item.language).join(", ") || "unknown languages"}; ${(index.sources || []).length} sources; ${(index.tests || []).length} tests`, freshness: "fresh", gatingSafe: true, graphScore: 0.5 }];
  for (const language of index.languages || []) cards.push({ provider: "project-intelligence", id: `architecture:language:${language.language}`, symbolId: `language:${language.language}`, kind: "symbol", path: (index.sources || []).find((file) => LANGUAGE_BY_EXT[path.extname(file.path).toLowerCase()] === language.language)?.path || "README.md", signature: `${language.language}: ${language.files} files`, freshness: "fresh", gatingSafe: true, graphScore: Math.min(1, language.files / Math.max(1, index.files.length)) });
  for (const manifest of index.dependencies || []) cards.push({ provider: "project-intelligence", id: `architecture:manifest:${manifest.file}`, symbolId: `manifest:${manifest.kind}`, kind: "file", path: manifest.file, signature: `${manifest.kind} dependency/build manifest`, freshness: "fresh", gatingSafe: true, buildRelevance: 0.7 });
  return cards.sort((a, b) => a.id.localeCompare(b.id));
}

function profile(cwd = process.cwd(), options = {}) {
  const index = createProjectIndex(cwd, options);
  return {
    cwd,
    generatedAt: index.generatedAt,
    detected: { languages: index.languages.map((x) => x.language), languageCounts: index.languages, scripts: index.scripts, ci: index.ci.map((x) => x.file), docs: index.docs.map((x) => x.path), tests: index.tests.map((x) => x.path), files: index.files.map((x) => x.path).slice(0, 300) },
    verifierProfiles: index.verifierProfiles,
    topologies: index.recommendedTopologies,
    safeCommands: index.safeCommands,
    privacy: { tracePayloads: "prefer PI_TRACE_CAPTURE_PAYLOADS=0 for shareable traces", storeFullTranscripts: false },
    symbols: index.symbols.slice(0, 200),
    dependencies: index.dependencies,
    codegraph: index.codegraph,
    semgrep: index.semgrep,
    buildGraph: index.buildGraph,
    fingerprint: index.fingerprint,
    revision: index.revision,
  };
}

module.exports = {
  walkFiles,
  createProjectIndex,
  profile,
  testImpact,
  changedFiles,
  candidateTestsFor,
  riskForFile,
  isTestPath,
  recommendVerifiers,
  recommendTopologies,
  compactArchitectureCards,
};
