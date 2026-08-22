import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const nextCli = fileURLToPath(new URL("./node_modules/next/dist/bin/next", import.meta.url));
const shared = { cwd: process.cwd(), stdio: "inherit" };

const realtime = spawn(
  process.execPath,
  ["server.mjs", "--realtime-only"],
  { ...shared, env: { ...process.env, PORT: "3001" } },
);
const web = spawn(
  process.execPath,
  [nextCli, "dev", "--hostname", "0.0.0.0", "--port", "3000"],
  { ...shared, env: process.env },
);

let stopping = false;
function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  realtime.kill();
  web.kill();
  process.exit(exitCode);
}

realtime.on("exit", (code) => {
  if (!stopping) stop(code ?? 1);
});
web.on("exit", (code) => {
  if (!stopping) stop(code ?? 1);
});
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
