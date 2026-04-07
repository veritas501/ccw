const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "")
}
