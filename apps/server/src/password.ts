import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { hashPassword } from "./panel-auth.js";

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
    "Contraseña del panel (mínimo 12 caracteres; no se mostrará): ",
  );
  const password = await input.question("");
  process.stdout.write("\nRepetí la contraseña: ");
  const confirmation = await input.question("");
  process.stdout.write("\n");
  if (
    password.length < 12 ||
    password.length > 256 ||
    password !== confirmation
  ) {
    console.error(
      "Las contraseñas deben coincidir y tener entre 12 y 256 caracteres.",
    );
    process.exitCode = 1;
  } else console.log(`PANEL_PASSWORD_HASH=${await hashPassword(password)}`);
} finally {
  input.close();
}
