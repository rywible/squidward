import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import readline from "node:readline/promises";

interface EnvMap {
  [key: string]: string;
}

const ENV_PATH = resolve(process.cwd(), ".env");
const ENV_EXAMPLE_PATH = resolve(process.cwd(), ".env.example");

const args = new Set(Bun.argv.slice(2));
const nonInteractive = args.has("--non-interactive") || !process.stdin.isTTY;
const skipInstall = args.has("--skip-install");
const skipBuild = args.has("--skip-build");

const KEY_ORDER = [
  "AGENT_DB_PATH",
  "PRIMARY_REPO_PATH",
  "API_HOST",
  "API_PORT",
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "SLACK_SOCKET_MODE_ENABLED",
  "SLACK_SIGNING_SECRET",
  "LINEAR_API_KEY",
  "BRAVE_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_MODEL",
  "WORKER_USE_STUB_EXECUTOR",
  "WORKER_BOOTSTRAP_COMMAND",
  "CODEX_PREFLIGHT_AUTH_COMMAND",
  "PORTFOLIO_TOP_N",
  "PORTFOLIO_MIN_EV_AUTORUN",
  "TEST_GEN_MAX_CANDIDATES_PER_BUG",
  "MEMO_WEEKDAY",
  "MEMO_HOUR",
  "GRAPH_REINDEX_CRON",
  "MAX_TASKS_PER_HEARTBEAT",
  "PERF_SCIENTIST_ENABLED",
  "PERF_SCIENTIST_REPO_PATH",
  "PERF_SCIENTIST_BENCHMARK_ROOT",
  "PERF_SCIENTIST_MANIFEST_PATH",
  "PERF_SCIENTIST_NIGHTLY_HOUR",
  "PERF_SCIENTIST_SMOKE_ON_CHANGE",
  "PERF_SCIENTIST_STANDARD_RUNS",
  "PERF_SCIENTIST_SMOKE_RUNS",
  "PERF_SCIENTIST_CV_MAX_PCT",
  "PERF_SCIENTIST_MIN_EFFECT_PCT",
  "PERF_SCIENTIST_CONFIDENCE_PCT",
  "PERF_SCIENTIST_MAX_AUTO_PR_FILES",
  "PERF_SCIENTIST_MAX_AUTO_PR_LOC",
  "PERF_SCIENTIST_BASE_REF",
  "PERF_SCIENTIST_PATCH_COMMAND_TEMPLATE",
  "PERF_SCIENTIST_TEST_COMMAND",
  "PERF_SCIENTIST_SLACK_CHANNEL",
] as const;

const REMOVED_KEYS = [
  "OAUTH_REDIRECT_BASE",
  "OAUTH_SECRET_KEY",
  "SLACK_CLIENT_ID",
  "SLACK_CLIENT_SECRET",
  "LINEAR_CLIENT_ID",
  "LINEAR_CLIENT_SECRET",
] as const;

const parseEnvFile = (path: string): EnvMap => {
  if (!existsSync(path)) return {};
  const content = readFileSync(path, "utf8");
  const env: EnvMap = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    env[key] = value;
  }

  return env;
};

const serializeEnvValue = (value: string): string => {
  if (value === "") return "";
  const needsQuotes = /\s|#|"|'/g.test(value);
  if (!needsQuotes) return value;
  return JSON.stringify(value);
};

const writeEnvFile = (path: string, env: EnvMap): void => {
  const keys = [...new Set([...KEY_ORDER, ...Object.keys(env)])];
  const body = keys
    .map((key) => `${key}=${serializeEnvValue(env[key] ?? "")}`)
    .join("\n");

  writeFileSync(path, `${body}\n`, "utf8");
};

const sanitize = (value: string): string =>
  value
    .replace(/gho_[A-Za-z0-9_]+/g, "gho_***")
    .replace(/xox[baprs]-[A-Za-z0-9-]+/g, "xox***")
    .replace(/sk-[A-Za-z0-9]+/g, "sk-***");

const exec = (command: string, argsList: string[] = [], cwd = process.cwd()) => {
  const result = Bun.spawnSync([command, ...argsList], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });

  return {
    ok: (result.exitCode ?? 1) === 0,
    code: result.exitCode ?? 1,
    stdout: Buffer.from(result.stdout).toString("utf8").trim(),
    stderr: Buffer.from(result.stderr).toString("utf8").trim(),
  };
};

const boolPrompt = async (rl: readline.Interface, label: string, defaultYes = true): Promise<boolean> => {
  if (nonInteractive) return defaultYes;
  const hint = defaultYes ? "Y/n" : "y/N";
  const response = (await rl.question(`${label} [${hint}]: `)).trim().toLowerCase();
  if (!response) return defaultYes;
  if (["y", "yes"].includes(response)) return true;
  if (["n", "no"].includes(response)) return false;
  return defaultYes;
};

const prompt = async (
  rl: readline.Interface,
  label: string,
  currentValue: string,
  fallbackValue = ""
): Promise<string> => {
  const resolvedFallback = currentValue || fallbackValue;

  if (nonInteractive) {
    return resolvedFallback;
  }

  const suffix = resolvedFallback ? ` [${resolvedFallback}]` : "";
  const response = await rl.question(`${label}${suffix}: `);
  const value = response.trim();
  return value || resolvedFallback;
};

const ensureAbsolute = (value: string): string => {
  if (value.startsWith("~/")) {
    return resolve(homedir(), value.slice(2));
  }
  return resolve(value);
};

const printSection = (title: string): void => {
  console.log(`\n== ${title} ==`);
};

const main = async (): Promise<void> => {
  console.log("Squidward setup wizard");
  console.log("This configures local env vars, validates toolchain, and prints startup commands.");

  const existing = parseEnvFile(ENV_PATH);
  const env: EnvMap = { ...existing };
  for (const removedKey of REMOVED_KEYS) {
    delete env[removedKey];
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    printSection("Core Paths");

    env.AGENT_DB_PATH = await prompt(rl, "SQLite DB path", env.AGENT_DB_PATH, ".data/agent.db");
    env.PRIMARY_REPO_PATH = await prompt(
      rl,
      "Primary managed repo path",
      env.PRIMARY_REPO_PATH,
      "~/projects/wrela"
    );
    env.PRIMARY_REPO_PATH = ensureAbsolute(env.PRIMARY_REPO_PATH);

    printSection("API");
    env.API_HOST = await prompt(rl, "API host", env.API_HOST, "0.0.0.0");
    env.API_PORT = await prompt(rl, "API port", env.API_PORT, "3000");

    printSection("Slack Integration");
    env.SLACK_BOT_TOKEN = await prompt(rl, "Slack bot token", env.SLACK_BOT_TOKEN, "");
    env.SLACK_APP_TOKEN = await prompt(
      rl,
      "Slack app token (xapp-..., required for Socket Mode)",
      env.SLACK_APP_TOKEN,
      ""
    );
    env.SLACK_SOCKET_MODE_ENABLED = await prompt(
      rl,
      "Enable Slack Socket Mode (1=yes, 0=no)",
      env.SLACK_SOCKET_MODE_ENABLED,
      "1"
    );
    env.SLACK_SIGNING_SECRET = await prompt(rl, "Slack signing secret", env.SLACK_SIGNING_SECRET, "");

    printSection("Linear Integration");
    env.LINEAR_API_KEY = await prompt(rl, "Linear personal API key (preferred)", env.LINEAR_API_KEY, "");

    printSection("Model + Research");
    env.OPENAI_API_KEY = await prompt(rl, "OpenAI API key", env.OPENAI_API_KEY, "");
    env.OPENAI_MODEL = await prompt(rl, "OpenAI model", env.OPENAI_MODEL, "gpt-4.1-mini");
    env.BRAVE_API_KEY = await prompt(rl, "Brave Search API key", env.BRAVE_API_KEY, "");

    printSection("Worker Behavior");
    env.WORKER_USE_STUB_EXECUTOR = await prompt(
      rl,
      "Use stub executor (1=yes, 0=no)",
      env.WORKER_USE_STUB_EXECUTOR,
      "0"
    );
    env.WORKER_BOOTSTRAP_COMMAND = await prompt(
      rl,
      "Worker bootstrap command",
      env.WORKER_BOOTSTRAP_COMMAND,
      "codex --help || true"
    );
    env.CODEX_PREFLIGHT_AUTH_COMMAND = await prompt(
      rl,
      "Optional Codex auth preflight command",
      env.CODEX_PREFLIGHT_AUTH_COMMAND,
      ""
    );
    env.PORTFOLIO_TOP_N = await prompt(rl, "Portfolio top-N candidates", env.PORTFOLIO_TOP_N, "5");
    env.PORTFOLIO_MIN_EV_AUTORUN = await prompt(
      rl,
      "Portfolio minimum EV for auto queue",
      env.PORTFOLIO_MIN_EV_AUTORUN,
      "1.25"
    );
    env.TEST_GEN_MAX_CANDIDATES_PER_BUG = await prompt(
      rl,
      "Max generated test candidates per bug",
      env.TEST_GEN_MAX_CANDIDATES_PER_BUG,
      "3"
    );
    env.MEMO_WEEKDAY = await prompt(rl, "Weekly memo weekday (0-6)", env.MEMO_WEEKDAY, "1");
    env.MEMO_HOUR = await prompt(rl, "Weekly memo hour (0-23)", env.MEMO_HOUR, "9");
    env.GRAPH_REINDEX_CRON = await prompt(
      rl,
      "Graph reindex interval minutes",
      env.GRAPH_REINDEX_CRON,
      "60"
    );
    env.RETRIEVAL_BUDGET_TOKENS = await prompt(
      rl,
      "Retrieval context token budget",
      env.RETRIEVAL_BUDGET_TOKENS,
      "4000"
    );
    env.MAX_TASKS_PER_HEARTBEAT = await prompt(
      rl,
      "Max tasks processed per heartbeat",
      env.MAX_TASKS_PER_HEARTBEAT,
      "8"
    );

    printSection("Perf Scientist");
    env.PERF_SCIENTIST_ENABLED = await prompt(
      rl,
      "Enable Autonomous Perf Scientist (1=yes, 0=no)",
      env.PERF_SCIENTIST_ENABLED,
      "1"
    );
    env.PERF_SCIENTIST_REPO_PATH = await prompt(
      rl,
      "Perf scientist repo path",
      env.PERF_SCIENTIST_REPO_PATH,
      env.PRIMARY_REPO_PATH
    );
    env.PERF_SCIENTIST_BENCHMARK_ROOT = await prompt(
      rl,
      "Perf benchmark root",
      env.PERF_SCIENTIST_BENCHMARK_ROOT,
      `${env.PERF_SCIENTIST_REPO_PATH}/benchmarks/macro`
    );
    env.PERF_SCIENTIST_MANIFEST_PATH = await prompt(
      rl,
      "Perf benchmark manifest path",
      env.PERF_SCIENTIST_MANIFEST_PATH,
      `${env.PERF_SCIENTIST_BENCHMARK_ROOT}/macro/bench.toml`
    );
    env.PERF_SCIENTIST_NIGHTLY_HOUR = await prompt(
      rl,
      "Perf nightly hour (0-23)",
      env.PERF_SCIENTIST_NIGHTLY_HOUR,
      "2"
    );
    env.PERF_SCIENTIST_SMOKE_ON_CHANGE = await prompt(
      rl,
      "Run smoke profile on qualifying HEAD changes (1=yes,0=no)",
      env.PERF_SCIENTIST_SMOKE_ON_CHANGE,
      "1"
    );
    env.PERF_SCIENTIST_STANDARD_RUNS = await prompt(
      rl,
      "Perf standard profile runs",
      env.PERF_SCIENTIST_STANDARD_RUNS,
      "5"
    );
    env.PERF_SCIENTIST_SMOKE_RUNS = await prompt(
      rl,
      "Perf smoke profile runs",
      env.PERF_SCIENTIST_SMOKE_RUNS,
      "2"
    );
    env.PERF_SCIENTIST_CV_MAX_PCT = await prompt(
      rl,
      "Perf CV max percent",
      env.PERF_SCIENTIST_CV_MAX_PCT,
      "5"
    );
    env.PERF_SCIENTIST_MIN_EFFECT_PCT = await prompt(
      rl,
      "Perf minimum effect percent",
      env.PERF_SCIENTIST_MIN_EFFECT_PCT,
      "2"
    );
    env.PERF_SCIENTIST_CONFIDENCE_PCT = await prompt(
      rl,
      "Perf confidence percent",
      env.PERF_SCIENTIST_CONFIDENCE_PCT,
      "95"
    );
    env.PERF_SCIENTIST_MAX_AUTO_PR_FILES = await prompt(
      rl,
      "Perf auto-PR max files",
      env.PERF_SCIENTIST_MAX_AUTO_PR_FILES,
      "8"
    );
    env.PERF_SCIENTIST_MAX_AUTO_PR_LOC = await prompt(
      rl,
      "Perf auto-PR max LOC",
      env.PERF_SCIENTIST_MAX_AUTO_PR_LOC,
      "250"
    );
    env.PERF_SCIENTIST_BASE_REF = await prompt(
      rl,
      "Perf compare base ref",
      env.PERF_SCIENTIST_BASE_REF,
      "main"
    );
    env.PERF_SCIENTIST_PATCH_COMMAND_TEMPLATE = await prompt(
      rl,
      "Optional patch command template",
      env.PERF_SCIENTIST_PATCH_COMMAND_TEMPLATE,
      ""
    );
    env.PERF_SCIENTIST_TEST_COMMAND = await prompt(
      rl,
      "Perf scientist targeted test command",
      env.PERF_SCIENTIST_TEST_COMMAND,
      "cargo test -q -p compiler --lib"
    );
    env.PERF_SCIENTIST_SLACK_CHANNEL = await prompt(
      rl,
      "Optional perf scientist Slack channel",
      env.PERF_SCIENTIST_SLACK_CHANNEL,
      ""
    );

    printSection("Writing Config");
    writeEnvFile(ENV_PATH, env);
    writeEnvFile(
      ENV_EXAMPLE_PATH,
      Object.fromEntries(KEY_ORDER.map((key) => [key, env[key] ? "" : ""]))
    );

    const dbDir = dirname(resolve(process.cwd(), env.AGENT_DB_PATH));
    mkdirSync(dbDir, { recursive: true });

    console.log(`Wrote ${ENV_PATH}`);
    console.log(`Wrote ${ENV_EXAMPLE_PATH}`);

    printSection("System Checks");
    const checks = [
      { name: "bun", run: () => exec("bun", ["--version"]) },
      { name: "gh", run: () => exec("gh", ["auth", "status"]) },
      { name: "codex", run: () => exec("codex", ["--version"]) },
    ];

    for (const check of checks) {
      const result = check.run();
      const detail = sanitize(result.ok ? result.stdout : result.stderr || result.stdout);
      console.log(`- ${check.name}: ${result.ok ? "ok" : `failed (code ${result.code})`}`);
      if (detail) {
        console.log(`  ${detail.split("\n")[0]}`);
      }
    }

    if (!skipInstall) {
      const doInstall = await boolPrompt(rl, "Run bun install now?", true);
      if (doInstall) {
        const result = exec("bun", ["install"]);
        console.log(result.ok ? "bun install complete." : `bun install failed (${result.code})`);
      }
    }

    if (!skipBuild) {
      const doBuild = await boolPrompt(rl, "Run bun run build now?", true);
      if (doBuild) {
        const result = exec("bun", ["run", "build"]);
        console.log(result.ok ? "build complete." : `build failed (${result.code})`);
      }
    }

    printSection("Next Steps");
    console.log("1) Start worker:");
    console.log("   bun run --filter @squidward/worker start");
    console.log("2) Start api:");
    console.log("   bun run --filter @squidward/api dev");
    console.log("3) Open dashboard:");
    console.log(`   http://localhost:${env.API_PORT}`);
    console.log("4) Verify integrations:");
    console.log(`   http://localhost:${env.API_PORT}/api/integrations/status`);
  } finally {
    rl.close();
  }
};

await main();
