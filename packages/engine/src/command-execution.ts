import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type ExecCommandOptions = ExecFileSyncOptionsWithStringEncoding & {
  windowsVerbatimArguments?: boolean;
};

function windowsCommandExtensions(commandName: string): string[] {
  if (path.extname(commandName)) return [""];
  const configured = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((extension) => extension.trim().toUpperCase())
    .filter(Boolean);
  return [...new Set([".COM", ".EXE", ...configured, ""])];
}

export function resolveCommand(commandName: string): string {
  if (path.isAbsolute(commandName) || commandName.includes("/") || commandName.includes("\\")) return commandName;
  const pathEntries = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const extensions = process.platform === "win32" ? windowsCommandExtensions(commandName) : [""];
  for (const directory of pathEntries) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${commandName}${extension}`);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return commandName;
}

function quoteCmdValue(value: string, description: string): string {
  if (value.includes("%")) throw new Error(`${description} cannot contain % when invoking a Windows batch command`);
  if (value.includes("\"")) throw new Error(`${description} cannot contain " when invoking a Windows batch command`);
  if (/[\r\n]/.test(value)) throw new Error(`${description} cannot contain a newline when invoking a Windows batch command`);
  return `"${value}"`;
}

export function buildCmdCommandLine(commandPath: string, args: readonly string[]): string {
  const quoted = [
    quoteCmdValue(commandPath, "Windows batch command path"),
    ...args.map((argument) => quoteCmdValue(argument, "Windows batch command argument")),
  ];
  return `"${quoted.join(" ")}"`;
}

type CommandExecutionPlan = {
  commandPath: string;
  args: string[];
  options: ExecCommandOptions;
};

export function prepareCommandExecution(
  commandName: string,
  args: string[],
  options: ExecCommandOptions,
): CommandExecutionPlan {
  const commandPath = resolveCommand(commandName);
  const extension = path.extname(commandPath).toLowerCase();
  if (process.platform === "win32" && (extension === ".cmd" || extension === ".bat")) {
    const cmdExePath = process.env.ComSpec || process.env.COMSPEC || "cmd.exe";
    return {
      commandPath: cmdExePath,
      args: ["/d", "/s", "/c", buildCmdCommandLine(commandPath, args)],
      options: {
        ...options,
        shell: false,
        windowsVerbatimArguments: true,
      },
    };
  }
  return { commandPath, args, options };
}

export function execCommandSync(commandName: string, args: string[], options: ExecCommandOptions): string {
  const execution = prepareCommandExecution(commandName, args, options);
  return execFileSync(execution.commandPath, execution.args, execution.options);
}
