/**
 * System probing.
 *
 * Every session gets a side channel that runs a small script and returns
 * `key=value` lines. Nothing is injected into the user's shell unless the
 * caller explicitly asks for that, and the script never touches the terminal
 * the user is looking at.
 */

import type { OsInfo } from '../../shared/types';

/**
 * Script for any POSIX shell (local Linux/macOS, WSL, remote SSH).
 * Deliberately plain: no awk, no GNU-only flags, quoted for the JS literal.
 */
const POSIX_SCRIPT = [
  'echo "hostname=$(hostname 2>/dev/null || cat /proc/sys/kernel/hostname 2>/dev/null)"',
  'echo "fqdn=$(hostname -f 2>/dev/null)"',
  'echo "user=$(id -un 2>/dev/null || whoami)"',
  'echo "os=$( (. /etc/os-release 2>/dev/null && printf "%s" "$PRETTY_NAME") || uname -s )"',
  'echo "osVersion=$( (. /etc/os-release 2>/dev/null && printf "%s" "$VERSION_ID") )"',
  'echo "kernel=$(uname -sr 2>/dev/null)"',
  'echo "arch=$(uname -m 2>/dev/null)"',
  'echo "shell=$SHELL"',
  'echo "uptimeSeconds=$(cut -d. -f1 /proc/uptime 2>/dev/null)"',
  'echo "cpuCount=$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null)"',
  'echo "memoryKb=$(grep MemTotal /proc/meminfo 2>/dev/null | tr -dc \'0-9\')"',
  'echo "timezone=$( (cat /etc/timezone 2>/dev/null) || date +%Z 2>/dev/null)"',
  'echo "ips=$( (hostname -I 2>/dev/null || ipconfig getifaddr en0 2>/dev/null) | tr " " "\n" | cut -d/ -f1 | grep -v "^$" | grep -v "^127\." | sort -u | paste -sd, -)"',
].join('\n');

export function posixProbeScript(): string {
  return POSIX_SCRIPT;
}

/** Script for Windows, run through PowerShell. */
const POWERSHELL_SCRIPT = [
  "$ProgressPreference = 'SilentlyContinue'",
  '$os = Get-CimInstance Win32_OperatingSystem',
  '"hostname=$($env:COMPUTERNAME)"',
  '"fqdn=$([System.Net.Dns]::GetHostEntry([string]::Empty).HostName)"',
  '"user=$($env:USERNAME)"',
  '"os=$($os.Caption)"',
  '"osVersion=$($os.Version)"',
  '"kernel=$([System.Environment]::OSVersion.VersionString)"',
  '"arch=$($env:PROCESSOR_ARCHITECTURE)"',
  '"cpuCount=$($env:NUMBER_OF_PROCESSORS)"',
  '"memoryKb=$([int]($os.TotalVisibleMemorySize))"',
  '"uptimeSeconds=$([int]((Get-Date) - $os.LastBootUpTime).TotalSeconds)"',
  '"timezone=$([System.TimeZoneInfo]::Local.Id)"',
  '"shell=Windows PowerShell"',
  '"ips=$(($([System.Net.Dns]::GetHostAddresses($env:COMPUTERNAME) | Where-Object { $_.AddressFamily -eq "InterNetwork" } | ForEach-Object { $_.IPAddressToString })) -join ",")"',
].join('; ');

export function windowsProbeScript(): string {
  return POWERSHELL_SCRIPT;
}

/** Wraps a PowerShell script so it can be passed without any quoting games. */
export function encodePowerShellCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

const STRING_FIELDS = new Set([
  'hostname',
  'fqdn',
  'os',
  'osVersion',
  'kernel',
  'arch',
  'user',
  'shell',
  'timezone',
]);

/** Parses `key=value` lines into `OsInfo`. Unknown keys are dropped. */
export function parseProbeOutput(text: string): OsInfo {
  const info: OsInfo = {};
  let memoryKb: number | undefined;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const index = line.indexOf('=');
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    if (!value) continue;

    if (key === 'ips') {
      info.ips = value
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0 && item !== '127.0.0.1' && item !== '::1');
      continue;
    }
    if (key === 'memoryKb') {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed) && parsed > 0) memoryKb = parsed;
      continue;
    }
    if (key === 'uptimeSeconds' || key === 'cpuCount') {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed)) (info as Record<string, unknown>)[key] = parsed;
      continue;
    }
    if (STRING_FIELDS.has(key) && !(key in info)) {
      (info as Record<string, unknown>)[key] = value;
    }
  }

  if (memoryKb) info.memoryMb = Math.round(memoryKb / 1024);
  info.probedAt = Date.now();
  return info;
}

export function probeLooksValid(info: OsInfo): boolean {
  return Boolean(info.hostname || info.os || info.kernel);
}