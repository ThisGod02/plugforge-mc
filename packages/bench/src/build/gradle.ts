import { spawn, spawnSync } from "node:child_process";
import type { GradleInstall, JavaRuntime } from "@plugforge/runtime";

export interface GradleRunOptions {
  gradle: GradleInstall;
  java: JavaRuntime;
  projectDir: string;
  tasks: string[];
  timeoutMs?: number;
  onLine?: (line: string) => void;
}

export interface GradleRunResult {
  exitCode: number;
  /** stdout and stderr interleaved, as the user would see it. */
  output: string;
  durationMs: number;
  timedOut: boolean;
  /** e.g. ":compileJava" when Gradle reports "> Task :compileJava FAILED". */
  failedTask?: string;
  /** The "* What went wrong:" block of a failed build. */
  failure?: string;
}

function killTree(pid: number) {
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
  else process.kill(-pid, "SIGKILL");
}

export function extractGradleFailure(output: string): { failedTask?: string; failure?: string } {
  const failedTask = /> Task (\S+) FAILED/.exec(output)?.[1];
  const block = /\* What went wrong:\r?\n([\s\S]*?)(?:\r?\n\* Try:|\r?\n\* Exception is:|\r?\nBUILD FAILED|$)/.exec(output)?.[1];
  return { failedTask, failure: block?.trim() };
}

export function runGradle(opts: GradleRunOptions): Promise<GradleRunResult> {
  const args = [...opts.tasks, "--console=plain", "--project-dir", opts.projectDir];
  const env = { ...process.env, JAVA_HOME: opts.java.home, GRADLE_USER_HOME: opts.gradle.userHome };
  const started = Date.now();

  // Node refuses to spawn .bat files directly; go through cmd with every argument quoted.
  const child =
    process.platform === "win32"
      ? spawn("cmd.exe", ["/d", "/s", "/c", `"${[opts.gradle.executable, ...args].map((a) => `"${a}"`).join(" ")}"`], {
          env,
          windowsHide: true,
          windowsVerbatimArguments: true,
        })
      : spawn(opts.gradle.executable, args, { env, detached: true });

  return new Promise((resolve, reject) => {
    let output = "";
    let pending = "";
    let timedOut = false;
    const onData = (data: Buffer) => {
      const text = data.toString();
      output += text;
      if (!opts.onLine) return;
      pending += text;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const l of lines) opts.onLine(l);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) killTree(child.pid);
    }, opts.timeoutMs ?? 10 * 60_000);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code ?? -1,
        output,
        durationMs: Date.now() - started,
        timedOut,
        ...(code === 0 ? {} : extractGradleFailure(output)),
      });
    });
  });
}
