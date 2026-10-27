import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { plugforgeHome } from "@plugforge/runtime";

// On Windows keys are encrypted with DPAPI (bound to the Windows user), via PowerShell's
// ConvertFrom-SecureString. The secret travels over stdin, never the command line.
const ENCRYPT = "$s=[Console]::In.ReadToEnd(); ConvertTo-SecureString $s -AsPlainText -Force | ConvertFrom-SecureString";
const DECRYPT =
  "$b=[Console]::In.ReadToEnd().Trim(); $ss=ConvertTo-SecureString $b; " +
  "[Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($ss))";

const REF = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const secretsDir = () => path.join(plugforgeHome(), "secrets");
const keyFile = (ref: string) => path.join(secretsDir(), process.platform === "win32" ? `${ref}.dpapi` : `${ref}.key`);

function powershell(script: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`powershell exited ${code}: ${err.trim()}`))));
    child.stdin.end(input);
  });
}

function checkRef(ref: string) {
  if (!REF.test(ref)) throw new Error(`invalid key name '${ref}': use lowercase letters, digits, - and _`);
}

export async function storeApiKey(ref: string, key: string): Promise<string> {
  checkRef(ref);
  await mkdir(secretsDir(), { recursive: true });
  const file = keyFile(ref);
  if (process.platform === "win32") {
    await writeFile(file, await powershell(ENCRYPT, key));
  } else {
    // TODO(M7): use the OS keychain through Electron safeStorage; until then a user-only file.
    await writeFile(file, key, { mode: 0o600 });
    await chmod(file, 0o600);
  }
  return file;
}

/** Environment first (PLUGFORGE_KEY_DEEPSEEK, then DEEPSEEK_API_KEY), then the stored key. */
export async function resolveApiKey(ref: string): Promise<string | undefined> {
  checkRef(ref);
  const env = ref.toUpperCase().replaceAll("-", "_");
  const fromEnv = process.env[`PLUGFORGE_KEY_${env}`] ?? process.env[`${env}_API_KEY`];
  if (fromEnv) return fromEnv.trim();
  let stored: string;
  try {
    stored = await readFile(keyFile(ref), "utf8");
  } catch {
    return undefined;
  }
  return process.platform === "win32" ? powershell(DECRYPT, stored) : stored.trim();
}
