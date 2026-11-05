import { lstat, unlink, chmod } from "node:fs/promises";
import { connect, type Server } from "node:net";
import { NodeConfigError } from "./config.ts";

function accepts(path: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const probe = connect(path);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolve(false);
      else reject(error);
    });
  });
}

async function clearStaleSocket(path: string): Promise<void> {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!stats.isSocket()) throw new NodeConfigError(`STATS_LISTEN ${path} exists and is not a socket`);
  if (await accepts(path)) throw new NodeConfigError(`STATS_LISTEN ${path} is in use by another server`);
  await unlink(path);
}

export async function listenOnSocket(server: Server, path: string): Promise<void> {
  await clearStaleSocket(path);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
  await chmod(path, 0o600);
}
