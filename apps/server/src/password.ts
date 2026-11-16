import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { hashPassword } from "./panel-auth.js";

if (process.argv.includes("--stdin")) {
  try {
    let password = "";
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) {
      password += chunk;
      if (password.length > 256) throw new Error("Password is too long.");
    }
    if (password.length < 12) throw new Error("Password is too short.");
    console.log(await hashPassword(password));
  } catch {
    console.error("Password must be between 12 and 256 characters long.");
    process.exit(1);
  }
  process.exit(0);
}

if (!process.stdin.isTTY)
  throw new Error("Run pnpm panel:password in an interactive terminal.");
const silent = new Writable({
  write(_chunk, _encoding, done) {
    done();
  },
});
const input = createInterface({
  input: process.stdin,
  output: silent,
  terminal: true,
});
input.on("SIGINT", () => {
  input.close();
  process.exit(1);
});
try {
  process.stdout.write(
    "Panel password (at least 12 characters; it will not be shown): ",
  );
  const password = await input.question("");
  process.stdout.write("\nRepeat the password: ");
  const confirmation = await input.question("");
  process.stdout.write("\n");
  if (
    password.length < 12 ||
    password.length > 256 ||
    password !== confirmation
  ) {
    console.error(
      "Passwords must match and be between 12 and 256 characters long.",
    );
    process.exitCode = 1;
  } else console.log(`PANEL_PASSWORD_HASH=${await hashPassword(password)}`);
} finally {
  input.close();
}
