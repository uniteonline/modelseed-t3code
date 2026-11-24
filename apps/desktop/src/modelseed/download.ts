// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- Read progress from the file written by the Windows curl process.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

export interface ModelseedDownload {
  readonly url: string;
  readonly size: number;
  readonly algorithm: "sha256" | "sha512";
  readonly digest: string;
  readonly encoding: "hex" | "base64";
}

const run = NodeUtil.promisify(NodeChildProcess.execFile);

export async function downloadModelseedTool(
  asset: ModelseedDownload,
  path: string,
  signal: AbortSignal,
  onProgress: (bytes: number) => void,
) {
  const sizeOnDisk = () =>
    NodeFSP.stat(path).then(
      (stat) => stat.size,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return 0;
        throw error;
      },
    );

  await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
  if ((await sizeOnDisk()) > asset.size) await NodeFSP.rm(path, { force: true });
  const timer = setInterval(() => {
    void sizeOnDisk()
      .then((size) => onProgress(Math.min(size, asset.size)))
      .catch(() => undefined);
  }, 750);
  timer.unref();
  try {
    const curl = NodePath.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "curl.exe");
    for (let attempt = 0; attempt < 3 && (await sizeOnDisk()) < asset.size; attempt++) {
      signal.throwIfAborted();
      try {
        await run(
          curl,
          [
            "--disable",
            "--silent",
            "--show-error",
            "--fail",
            "--location",
            "--proto",
            "=https",
            "--proto-redir",
            "=https",
            "--connect-timeout",
            "20",
            "--speed-limit",
            "1024",
            "--speed-time",
            "45",
            "--max-filesize",
            String(asset.size),
            "--continue-at",
            "-",
            "--output",
            path,
            asset.url,
          ],
          { windowsHide: true, signal },
        );
      } catch (error) {
        signal.throwIfAborted();
        if (attempt === 2) throw error;
        const code = String((error as NodeJS.ErrnoException).code);
        if (code === "33" || code === "36") await NodeFSP.rm(path, { force: true });
      }
    }
  } finally {
    clearInterval(timer);
  }
  if ((await sizeOnDisk()) !== asset.size) throw new Error("download_size");
  const hash = NodeCrypto.createHash(asset.algorithm);
  for await (const chunk of NodeFS.createReadStream(path, { signal })) hash.update(chunk);
  if (hash.digest(asset.encoding) !== asset.digest) {
    await NodeFSP.rm(path, { force: true });
    throw new Error("download_checksum");
  }
  onProgress(asset.size);
}
