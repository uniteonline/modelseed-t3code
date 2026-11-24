// @effect-diagnostics nodeBuiltinImport:off globalFetch:off -- Downloads are verified as they stream to a temporary installation directory.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as NodeStreamPromises from "node:stream/promises";
import * as NodeUtil from "node:util";

const run = NodeUtil.promisify(NodeChildProcess.execFile);

const { access, mkdir, mkdtemp, rename, rm, writeFile } = NodeFSP;
const { delimiter, join, resolve, sep } = NodePath;

const codex = {
  name: "codex-0.169.1",
  url: "https://registry.npmjs.org/@openai/codex/-/codex-0.169.1-win32-x64.tgz",
  sha512:
    "fImXWqxwxqHh9+FhJWsRRFiBzgBrSeN1bYTvtGZtUKGTPzHefYAL1agmlf5XScfwY5i5pHsExfdhFekzRBbqIw==",
  binary: ["vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe"],
};
const claude = {
  name: "claude-code-2.1.331",
  url: "https://registry.npmjs.org/@anthropic-ai/claude-code-win32-x64/-/claude-code-win32-x64-2.1.331.tgz",
  sha512:
    "bCT94qVLXKzQTofnw8UuAYU95C7rt6oS38Nr1cZfNc/eX+iZhG1oEvAwgmc9nsPf2QhP2Z93uT6bu3cY5Cw7Bw==",
  binary: ["claude.exe"],
};
const portableGit = {
  url: "https://github.com/git-for-windows/git/releases/download/v2.53.0.windows.1/PortableGit-2.53.0-64-bit.7z.exe",
  sha256: "08713a710ec91ac90de1c09f861289a3b103175f098676e5e664c04dd6c6bf23",
};

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

async function downloadVerified(
  url: string,
  path: string,
  hash: { algorithm: "sha256" | "sha512"; digest: string; encoding: "hex" | "base64" },
  signal: AbortSignal,
) {
  const response = await fetch(url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(360_000)]),
  });
  if (!response.ok || !response.body || !response.url.startsWith("https://")) {
    throw new Error("download_unavailable");
  }
  const digest = NodeCrypto.createHash(hash.algorithm);
  await NodeStreamPromises.pipeline(
    NodeStream.Readable.fromWeb(
      response.body as unknown as Parameters<typeof NodeStream.Readable.fromWeb>[0],
    ),
    async function* (stream: AsyncIterable<Uint8Array>) {
      for await (const chunk of stream) {
        digest.update(chunk);
        yield chunk;
      }
    },
    NodeFS.createWriteStream(path, { flags: "wx" }),
    { signal },
  );
  if (digest.digest(hash.encoding) !== hash.digest) throw new Error("download_checksum");
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
): Promise<string> {
  const destination = join(root, runtime.name);
  const binary = join(destination, ...runtime.binary);
  if (await exists(binary)) return binary;
  await stage(root, async (temp) => {
    const archive = join(temp, "package.tgz");
    await downloadVerified(
      runtime.url,
      archive,
      {
        algorithm: "sha512",
        digest: runtime.sha512,
        encoding: "base64",
      },
      signal,
    );
    await run("tar.exe", ["-xzf", archive, "-C", temp], {
      windowsHide: true,
      signal,
      timeout: 60_000,
    });
    const extracted = join(temp, "package");
    await access(join(extracted, ...runtime.binary));
    await rename(extracted, destination);
  });
  return binary;
}

async function findGit(root: string, signal: AbortSignal): Promise<{ bin: string; bash: string }> {
  const installation = join(root, "git-2.53.0");
  const candidates = [
    installation,
    join(process.env.ProgramFiles ?? "C:\\Program Files", "Git"),
    join(process.env.LOCALAPPDATA ?? root, "Programs", "Git"),
  ];
  for (const candidate of candidates) {
    const bin = join(candidate, "cmd");
    const bash = join(candidate, "bin", "bash.exe");
    if ((await exists(bash)) && (await exists(join(bin, "git.exe")))) return { bin, bash };
  }
  await stage(root, async (temp) => {
    const archive = join(temp, "PortableGit.7z.exe");
    const extracted = join(temp, "git");
    await downloadVerified(
      portableGit.url,
      archive,
      {
        algorithm: "sha256",
        digest: portableGit.sha256,
        encoding: "hex",
      },
      signal,
    );
    await mkdir(extracted);
    await run(archive, ["-y", "-gm2", "-o" + extracted], {
      windowsHide: true,
      signal,
      timeout: 120_000,
      cwd: temp,
    });
    await access(join(extracted, "cmd", "git.exe"));
    await access(join(extracted, "bin", "bash.exe"));
    await rename(extracted, installation);
  });
  return { bin: join(installation, "cmd"), bash: join(installation, "bin", "bash.exe") };
}

export async function prepareModelseedTools(
  dataDir: string,
  gatewayOrigin: string,
  signal: AbortSignal,
): Promise<ModelseedTools> {
  const root = join(dataDir, "tools");
  const codexHome = join(dataDir, "providers", "codex");
  const claudeHome = join(dataDir, "providers", "claude");
  const cancel = new AbortController();
  const installSignal = AbortSignal.any([signal, cancel.signal]);
  const installations = [
    installRuntime(root, codex, installSignal),
    installRuntime(root, claude, installSignal),
    findGit(root, installSignal),
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
