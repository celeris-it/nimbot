import { spawn } from "node:child_process";
import { Transform } from "node:stream";

const [launcher, ...args] = process.argv.slice(2);
if (launcher !== "npx" && launcher !== "uvx")
  throw new Error("Invalid MCP launcher");
const env = JSON.parse(process.env.NIMBOT_MCP_ENV ?? "{}") as NodeJS.ProcessEnv;
const child = spawn(launcher, args, {
  detached: true,
  shell: false,
  env,
  stdio: ["pipe", "pipe", "ignore"],
});

let stopping = false;
function signalGroup(signal: NodeJS.Signals) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.stdin.unpipe(child.stdin);
  process.stdin.pause();
  signalGroup("SIGTERM");
  setTimeout(() => {
    signalGroup("SIGKILL");
    process.exit(code);
  }, 250);
}

let remaining = 256 * 1024;
const bounded = new Transform({
  transform(chunk: Buffer, _encoding, done) {
    remaining -= chunk.length;
    if (remaining < 0) {
      process.stderr.write("response_too_large\n");
      stop(2);
      done();
      return;
    }
    done(null, chunk);
  },
});
process.stdin.pipe(child.stdin);
child.stdout.pipe(bounded).pipe(process.stdout, { end: false });
process.stdin.on("end", () => stop());
process.stdin.on("error", () => stop(1));
process.stdout.on("error", () => stop(1));
child.stdin.on("error", () => stop(1));
child.on("error", () => stop(1));
child.on("close", (code) => stop(code ?? 1));
process.once("SIGTERM", () => stop());
process.once("SIGINT", () => stop());
