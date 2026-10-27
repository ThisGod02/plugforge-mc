import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Rcon } from "rcon-client";
import { homePaths, type JavaRuntime, type Log, type PaperInstall } from "@plugforge/runtime";
import { freePort } from "./ports.ts";

export interface StartServerOptions {
  java: JavaRuntime;
  paper: PaperInstall;
  /** The user must have accepted the Minecraft EULA; the bench never accepts it on their behalf. */
  eulaAccepted: true;
  /** Plugin jars copied into plugins/ before start. */
  plugins?: string[];
  memoryMb?: number;
  startTimeoutMs?: number;
  /** Keep the server folder after stop (for debugging). */
  keepDir?: boolean;
  log?: Log;
}

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const READY = /Done \([\d.,]+s\)! For help, type "help"/;

function serverProperties(port: number, rconPort: number, rconPassword: string): string {
  return [
    "online-mode=false",
    "enforce-secure-profile=false",
    "server-ip=127.0.0.1",
    `server-port=${port}`,
    "enable-rcon=true",
    `rcon.port=${rconPort}`,
    `rcon.password=${rconPassword}`,
    "broadcast-rcon-to-ops=false",
    "level-type=minecraft\\:flat",
    // Without explicit layers Paper writes generator-settings={} and logs "No key layers" errors,
    // which would drown real plugin errors in the server log.
    'generator-settings={"layers"\\:[{"block"\\:"minecraft\\:bedrock","height"\\:1},{"block"\\:"minecraft\\:dirt","height"\\:2},{"block"\\:"minecraft\\:grass_block","height"\\:1}],"biome"\\:"minecraft\\:plains"}',
    "generate-structures=false",
    "spawn-protection=0",
    "view-distance=4",
    "simulation-distance=4",
    "max-players=8",
    "difficulty=peaceful",
    "allow-flight=true",
    "sync-chunk-writes=false",
    "motd=PlugForge test bench",
    "",
  ].join("\n");
}

/** A throwaway Paper server in its own temp folder, bound to localhost only. */
export class TestServer {
  readonly lines: string[] = [];
  private readonly listeners = new Set<(line: string) => void>();
  private rcon?: Rcon;
  private exited: Promise<number | null>;
  private stopped = false;

  private constructor(
    readonly dir: string,
    readonly port: number,
    private readonly rconPort: number,
    private readonly rconPassword: string,
    private readonly proc: ChildProcessWithoutNullStreams,
    private readonly opts: StartServerOptions,
  ) {
    this.exited = new Promise((resolve) => proc.on("exit", (code) => resolve(code)));
    let buffer = "";
    const onData = (data: Buffer) => {
      buffer += data.toString();
      const parts = buffer.split(/\r?\n/);
      buffer = parts.pop() ?? "";
      for (const raw of parts) {
        const line = raw.replace(ANSI, "");
        if (!line.trim()) continue;
        this.lines.push(line);
        for (const l of this.listeners) l(line);
      }
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
  }

  static async start(opts: StartServerOptions): Promise<TestServer> {
    const log = opts.log ?? (() => {});
    const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
    const dir = path.join(homePaths.servers(), id);
    await mkdir(path.join(dir, "plugins"), { recursive: true });

    const [port, rconPort] = [await freePort(), await freePort()];
    const rconPassword = randomBytes(16).toString("hex");
    await writeFile(path.join(dir, "eula.txt"), "eula=true\n");
    await writeFile(path.join(dir, "server.properties"), serverProperties(port, rconPort, rconPassword));
    for (const jar of opts.plugins ?? []) await copyFile(jar, path.join(dir, "plugins", path.basename(jar)));

    // Launch the already-patched server directly (see PaperInstall). The classpath goes into a Java
    // argument file to stay clear of command-line length limits; forward slashes avoid argfile escaping.
    const classpath = opts.paper.classpath.map((p) => p.replaceAll("\\", "/")).join(path.delimiter);
    const argFile = path.join(dir, "launch.args");
    await writeFile(argFile, `-cp "${classpath}"\n`);

    const mem = opts.memoryMb ?? 1024;
    log(`starting Paper in ${dir} (port ${port})`);
    const proc = spawn(
      opts.java.executable,
      [`-Xms${mem}M`, `-Xmx${mem}M`, `@${argFile}`, opts.paper.mainClass, "--nogui"],
      { cwd: dir, windowsHide: true },
    );

    const server = new TestServer(dir, port, rconPort, rconPassword, proc, opts);
    try {
      await Promise.race([
        server.waitForLine(READY, opts.startTimeoutMs ?? 120_000),
        server.exited.then((code) => {
          throw new Error(`server exited during startup with code ${code}`);
        }),
      ]);
      server.rcon = await Rcon.connect({ host: "127.0.0.1", port: rconPort, password: rconPassword });
      // The server drops the RCON socket on shutdown; without a listener that crashes the process.
      server.rcon.on("error", () => {});
    } catch (err) {
      await server.stop();
      const tail = server.lines.slice(-30).join("\n");
      throw new Error(`${(err as Error).message}\n--- last server log lines ---\n${tail}`);
    }
    return server;
  }

  onLine(listener: (line: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Resolves with the first log line at index >= `fromIndex` matching `pattern`. */
  waitForLine(pattern: RegExp, timeoutMs: number, fromIndex = 0): Promise<string> {
    const existing = this.lines.slice(fromIndex).find((l) => pattern.test(l));
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`timed out after ${timeoutMs} ms waiting for log line ${pattern}`));
      }, timeoutMs);
      const off = this.onLine((line) => {
        if (!pattern.test(line)) return;
        clearTimeout(timer);
        off();
        resolve(line);
      });
    });
  }

  /** Runs a console command over RCON and returns its output. */
  async command(cmd: string): Promise<string> {
    if (!this.rcon) throw new Error("RCON is not connected");
    return this.rcon.send(cmd);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const alive = this.proc.exitCode === null && this.proc.signalCode === null;
    if (alive) {
      // Don't await the RCON reply: the server may close the socket before answering "stop".
      if (this.rcon) this.rcon.send("stop").catch(() => this.proc.stdin.write("stop\n"));
      else this.proc.stdin.write("stop\n");
      const timeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 30_000));
      if ((await Promise.race([this.exited, timeout])) === "timeout") {
        this.proc.kill("SIGKILL");
        await this.exited;
      }
    }
    await this.rcon?.end().catch(() => {});
    if (!this.opts.keepDir) await this.cleanup();
  }

  private async cleanup(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
}
