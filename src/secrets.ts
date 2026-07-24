import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { SecretSchema, type SkySecrets, skyHome } from "./config.js";
import { SkyError } from "./errors.js";
import { atomicWriteText } from "./util/atomic-file.js";

const ENTROPY = "Sky.Roleplay.v1";

export interface SecretStore {
  load(): Promise<SkySecrets>;
  save(secrets: SkySecrets): Promise<void>;
  check(): Promise<void>;
}

async function powershell(script: string, stdin: string): Promise<Buffer> {
  return await new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script
      ],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true }
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (value: Buffer) => stdout.push(value));
    child.stderr.on("data", (value: Buffer) => stderr.push(value));
    child.on("error", reject);
    child.stdin.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(stdout));
      else
        reject(
          new SkyError(
            `Windows DPAPI operation failed (${code ?? "unknown"}): ${Buffer.concat(stderr).toString("utf8").trim()}`,
            "DPAPI_FAILED"
          )
        );
    });
    child.stdin.end(stdin, "utf8");
  });
}

export async function restrictWindowsAcl(
  target: string,
  directory = false
): Promise<void> {
  if (process.platform !== "win32") {
    throw new SkyError(
      "Windows ACL protection is available only on Windows",
      "WINDOWS_REQUIRED"
    );
  }
  const escaped = target.replaceAll("'", "''");
  const inheritance = directory
    ? "[System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'"
    : "[System.Security.AccessControl.InheritanceFlags]::None";
  const script = [
    "$ErrorActionPreference='Stop'",
    `$target='${escaped}'`,
    "$acl=Get-Acl -LiteralPath $target",
    "$acl.SetAccessRuleProtection($true,$false)",
    "$acl.Access | ForEach-Object { [void]$acl.RemoveAccessRule($_) }",
    "$rights=[System.Security.AccessControl.FileSystemRights]::FullControl",
    `$inherit=${inheritance}`,
    "$prop=[System.Security.AccessControl.PropagationFlags]::None",
    "$allow=[System.Security.AccessControl.AccessControlType]::Allow",
    "$ids=@([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18','S-1-5-32-544')",
    "foreach($id in $ids){$sid=New-Object System.Security.Principal.SecurityIdentifier($id);$rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,$rights,$inherit,$prop,$allow);$acl.AddAccessRule($rule)}",
    "Set-Acl -LiteralPath $target -AclObject $acl"
  ].join(";");
  await powershell(script, "");
}

export async function unexpectedWindowsAclPrincipals(
  target: string
): Promise<string[]> {
  if (process.platform !== "win32") {
    throw new SkyError(
      "Windows ACL inspection is available only on Windows",
      "WINDOWS_REQUIRED"
    );
  }
  const escaped = target.replaceAll("'", "''");
  const script = [
    "$ErrorActionPreference='Stop'",
    `$target='${escaped}'`,
    "$allowed=[System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)",
    "[void]$allowed.Add([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value)",
    "[void]$allowed.Add('S-1-5-18')",
    "[void]$allowed.Add('S-1-5-32-544')",
    "$unexpected=@()",
    "foreach($rule in (Get-Acl -LiteralPath $target).Access){if($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow){continue};try{$sid=$rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value}catch{$sid=$rule.IdentityReference.Value};if(!$allowed.Contains($sid)){$unexpected+=$sid}}",
    "$unexpected | Sort-Object -Unique"
  ].join(";");
  return (await powershell(script, ""))
    .toString("utf8")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
}

export class DpapiSecretStore implements SecretStore {
  private readonly file: string;

  public constructor(private readonly home = skyHome()) {
    this.file = path.join(home, "secrets.dpapi");
  }

  public async save(secrets: SkySecrets): Promise<void> {
    if (process.platform !== "win32") {
      throw new SkyError(
        "DPAPI secret storage is available only on Windows",
        "WINDOWS_REQUIRED"
      );
    }
    const clean = SecretSchema.parse(secrets);
    const script = [
      "$ErrorActionPreference='Stop'",
      "Add-Type -AssemblyName System.Security",
      "$plain=[Console]::In.ReadToEnd()",
      `$entropy=[System.Text.Encoding]::UTF8.GetBytes('${ENTROPY}')`,
      "$bytes=[System.Text.Encoding]::UTF8.GetBytes($plain)",
      "$protected=[System.Security.Cryptography.ProtectedData]::Protect($bytes,$entropy,[System.Security.Cryptography.DataProtectionScope]::LocalMachine)",
      "[Console]::Out.Write([Convert]::ToBase64String($protected))"
    ].join(";");
    const encrypted = await powershell(script, JSON.stringify(clean));
    await mkdir(this.home, { recursive: true });
    await restrictWindowsAcl(this.home, true);
    await atomicWriteText(this.file, encrypted.toString("utf8"));
    await restrictWindowsAcl(this.file);
  }

  public async load(): Promise<SkySecrets> {
    if (process.platform !== "win32") {
      throw new SkyError(
        "DPAPI secret storage is available only on Windows",
        "WINDOWS_REQUIRED"
      );
    }
    const encrypted = (await readFile(this.file, "utf8")).trim();
    const script = [
      "$ErrorActionPreference='Stop'",
      "Add-Type -AssemblyName System.Security",
      "$cipher=[Console]::In.ReadToEnd()",
      `$entropy=[System.Text.Encoding]::UTF8.GetBytes('${ENTROPY}')`,
      "$bytes=[Convert]::FromBase64String($cipher)",
      "$plain=[System.Security.Cryptography.ProtectedData]::Unprotect($bytes,$entropy,[System.Security.Cryptography.DataProtectionScope]::LocalMachine)",
      "[Console]::Out.Write([System.Text.Encoding]::UTF8.GetString($plain))"
    ].join(";");
    const clear = await powershell(script, encrypted);
    return SecretSchema.parse(JSON.parse(clear.toString("utf8")));
  }

  public async check(): Promise<void> {
    await this.load();
  }
}

export class MemorySecretStore implements SecretStore {
  public constructor(private secrets: SkySecrets) {}
  public async load(): Promise<SkySecrets> {
    return structuredClone(this.secrets);
  }
  public async save(secrets: SkySecrets): Promise<void> {
    this.secrets = structuredClone(SecretSchema.parse(secrets));
  }
  public async check(): Promise<void> {
    SecretSchema.parse(this.secrets);
  }
}
