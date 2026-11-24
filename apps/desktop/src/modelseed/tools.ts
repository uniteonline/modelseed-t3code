// @effect-diagnostics nodeBuiltinImport:off -- Native installers extract their verified archives into a temporary directory.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { downloadModelseedTool, type ModelseedDownload } from "./download.ts";

const run = NodeUtil.promisify(NodeChildProcess.execFile);

const { access, mkdir, mkdtemp, rename, rm, writeFile } = NodeFSP;
const { delimiter, join, resolve, sep } = NodePath;

const codex = {
  name: "codex-0.169.1",
  url: "https://registry.npmjs.org/@openai/codex/-/codex-0.169.1-win32-x64.tgz",
  size: 187_066_459,
  algorithm: "sha512",
  encoding: "base64",
  digest:
    "fImXWqxwxqHh9+FhJWsRRFiBzgBrSeN1bYTvtGZtUKGTPzHefYAL1agmlf5XScfwY5i5pHsExfdhFekzRBbqIw==",
  binary: ["vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe"],
} satisfies ModelseedDownload & { name: string; binary: string[] };
const claude = {
  name: "claude-code-2.1.331",
  url: "https://registry.npmjs.org/@anthropic-ai/claude-code-win32-x64/-/claude-code-win32-x64-2.1.331.tgz",
  size: 187_688_181,
  algorithm: "sha512",
  encoding: "base64",
  digest:
    "bCT94qVLXKzQTofnw8UuAYU95C7rt6oS38Nr1cZfNc/eX+iZhG1oEvAwgmc9nsPf2QhP2Z93uT6bu3cY5Cw7Bw==",
  binary: ["claude.exe"],
} satisfies ModelseedDownload & { name: string; binary: string[] };
const portableGit = {
  name: "git-2.53.0",
  url: "https://github.com/git-for-windows/git/releases/download/v2.53.0.windows.1/PortableGit-2.53.0-64-bit.7z.exe",
  size: 58_256_920,
  algorithm: "sha256",
  encoding: "hex",
  digest: "08713a710ec91ac90de1c09f861289a3b103175f098676e5e664c04dd6c6bf23",
} satisfies ModelseedDownload & { name: string };

export interface ModelseedTools {
  readonly codexBinary: string;
  readonly claudeBinary: string;
  readonly codexHome: string;
  readonly claudeHome: string;
  readonly gitPath: string;
  readonly gitBash: string;
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

async function stage<T>(root: string, runStage: (dir: string) => Promise<T>): Promise<T> {
  await mkdir(root, { recursive: true });
  const temp = await mkdtemp(join(root, ".download-"));
  try {
    return await runStage(temp);
  } finally {
    if (resolve(temp).startsWith(resolve(root) + sep + ".download-")) {
      await rm(temp, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
    }
  }
}

async function installRuntime(
  root: string,
  runtime: typeof codex,
  signal: AbortSignal,
  onProgress: (bytes: number) => void,
): Promise<string> {
  const destination = join(root, runtime.name);
  const binary = join(destination, ...runtime.binary);
  if (await exists(binary)) {
    onProgress(runtime.size);
    return binary;
  }
  const archive = join(root, "downloads", runtime.name, "package.tgz");
  await downloadModelseedTool(runtime, archive, signal, onProgress);
  await stage(root, async (temp) => {
    await run("tar.exe", ["-xzf", archive, "-C", temp], {
      windowsHide: true,
      signal,
      timeout: 60_000,
    });
    const extracted = join(temp, "package");
    await access(join(extracted, ...runtime.binary));
    await rename(extracted, destination);
  });
  await rm(archive, { force: true }).catch(() => undefined);
  return binary;
}

async function findGit(
  root: string,
  signal: AbortSignal,
  onProgress: (bytes: number) => void,
): Promise<{ bin: string; bash: string }> {
  const installation = join(root, portableGit.name);
  const candidates = [
    installation,
    join(process.env.ProgramFiles ?? "C:\\Program Files", "Git"),
    join(process.env.LOCALAPPDATA ?? root, "Programs", "Git"),
  ];
  for (const candidate of candidates) {
    const bin = join(candidate, "cmd");
    const bash = join(candidate, "bin", "bash.exe");
    if ((await exists(bash)) && (await exists(join(bin, "git.exe")))) {
      onProgress(portableGit.size);
      return { bin, bash };
    }
  }
  const archive = join(root, "downloads", portableGit.name, "PortableGit.7z.exe");
  await downloadModelseedTool(portableGit, archive, signal, onProgress);
  await stage(root, async (temp) => {
    const extracted = join(temp, "git");
    await mkdir(extracted);
    await run(archive, ["-y", "-o" + extracted, "-nr"], {
      windowsHide: true,
      signal,
      timeout: 120_000,
      cwd: temp,
    });
    await access(join(extracted, "cmd", "git.exe"));
    await access(join(extracted, "bin", "bash.exe"));
    await rename(extracted, installation);
  });
  await rm(archive, { force: true }).catch(() => undefined);
  return { bin: join(installation, "cmd"), bash: join(installation, "bin", "bash.exe") };
}

export async function prepareModelseedTools(
  dataDir: string,
  gatewayOrigin: string,
  signal: AbortSignal,
  onProgress: (percent: number) => void = () => undefined,
): Promise<ModelseedTools> {
  const root = join(dataDir, "tools");
  const codexHome = join(dataDir, "providers", "codex");
  const claudeHome = join(dataDir, "providers", "claude");
  const cancel = new AbortController();
  const installSignal = AbortSignal.any([signal, cancel.signal]);
  const counts = new Map<string, number>();
  const total = codex.size + claude.size + portableGit.size;
  const progress = (name: string) => (bytes: number) => {
    counts.set(name, bytes);
    const received = Array.from(counts.values()).reduce((sum, value) => sum + value, 0);
    onProgress(Math.floor((received / total) * 100));
  };
  const installations = [
    installRuntime(root, codex, installSignal, progress(codex.name)),
    installRuntime(root, claude, installSignal, progress(claude.name)),
    findGit(root, installSignal, progress(portableGit.name)),
  ] as const;
  let installed;
  try {
    installed = await Promise.all(installations);
  } catch (error) {
    cancel.abort();
    await Promise.allSettled(installations);
    throw error;
  }
  const [codexBinary, claudeBinary, git] = installed;
  await Promise.all([
    mkdir(codexHome, { recursive: true }),
    mkdir(claudeHome, { recursive: true }),
  ]);
  await writeFile(
    join(codexHome, "config.toml"),
    [
      'model_provider = "modelseed"',
      'cli_auth_credentials_store = "file"',
      "",
      "[shell_environment_policy]",
      'exclude = ["MODELSEED_API_KEY"]',
      "",
      "[model_providers.modelseed]",
      'name = "Modelseed"',
      'base_url = "' + gatewayOrigin + '/v1"',
      'env_key = "MODELSEED_API_KEY"',
      'wire_api = "responses"',
      "requires_openai_auth = false",
      "supports_websockets = false",
      'http_headers = { "Accept-Language" = "ru" }',
      "",
    ].join("\n"),
  );
  return {
    codexBinary,
    claudeBinary,
    codexHome,
    claudeHome,
    gitPath: git.bin + delimiter + (process.env.PATH ?? ""),
    gitBash: git.bash,
  };
}
