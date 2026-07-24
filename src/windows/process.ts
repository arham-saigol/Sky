import { spawn } from "node:child_process";

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function runProcess(
  executable: string,
  args: string[],
  options: { inherit?: boolean; cwd?: string } = {}
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      windowsHide: !options.inherit,
      stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    if (child.stdout)
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    if (child.stderr)
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      })
    );
  });
}
