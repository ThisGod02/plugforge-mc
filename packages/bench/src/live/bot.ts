import mineflayer, { type Bot } from "mineflayer";

export interface ConnectBotOptions {
  port: number;
  username: string;
  version: string;
  host?: string;
  timeoutMs?: number;
}

/** Connects an offline-mode bot and resolves once it has spawned in the world. */
export function connectBot(opts: ConnectBotOptions): Promise<Bot> {
  const bot = mineflayer.createBot({
    host: opts.host ?? "127.0.0.1",
    port: opts.port,
    username: opts.username,
    version: opts.version,
    auth: "offline",
    hideErrors: true,
  });

  return new Promise((resolve, reject) => {
    const fail = (reason: string) => {
      clearTimeout(timer);
      bot.end();
      reject(new Error(`bot ${opts.username} failed to join: ${reason}`));
    };
    const timer = setTimeout(() => fail(`no spawn within ${opts.timeoutMs ?? 30_000} ms`), opts.timeoutMs ?? 30_000);
    bot.once("spawn", () => {
      clearTimeout(timer);
      resolve(bot);
    });
    bot.once("kicked", (reason) => fail(`kicked: ${typeof reason === "string" ? reason : JSON.stringify(reason)}`));
    bot.once("error", (err) => fail(err.message));
  });
}
