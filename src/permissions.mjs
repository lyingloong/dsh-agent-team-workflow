/** Shared authorization for the runtime and every privileged executor hop. */
export class PermissionError extends Error {
  constructor(message) { super(message); this.name = 'PermissionError'; this.code = 'permission_denied'; }
}

// An allowlist grants one literal command/argv prefix, never shell composition.
// Conservative across POSIX sh and Windows cmd: expansion, substitution,
// operators, redirection and control characters require an explicit full grant.
function literalWords(command) {
  if (typeof command !== 'string' || !command.trim() || /[\x00-\x1f\x7f&|;<>`$%^!(){}*?\[\]~]/.test(command)) return null;
  const words = [];
  let word = '', quote = null, started = false;
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = null; else word += char;
      started = true;
    } else if (char === '"' || char === "'") { quote = char; started = true; }
    else if (/\s/.test(char)) {
      if (started) { words.push(word); word = ''; started = false; }
    } else { word += char; started = true; }
  }
  if (quote) return null;
  if (started) words.push(word);
  return words.length && words[0] ? words : null;
}

export function requireCommand(grant, command) {
  if (grant?.mode === 'full') return;
  const words = literalWords(command);
  if (grant?.mode === 'allowlist' && words && Array.isArray(grant.allow)) {
    for (const allowed of grant.allow) {
      const prefix = literalWords(allowed);
      if (prefix && prefix.length <= words.length && prefix.every((word, index) => word === words[index])) return;
    }
  }
  throw new PermissionError(`Command is not granted as a single literal command: ${command}`);
}

export function requireHttp(grant, value) {
  let url;
  try { url = new URL(value); } catch { throw new PermissionError(`Invalid HTTP URL: ${value}`); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new PermissionError(`Only HTTP(S) URLs are permitted: ${value}`);
  if (grant?.mode === 'full') return;
  const host = url.host.toLowerCase();
  if (grant?.mode === 'allowlist' && Array.isArray(grant.allow) && grant.allow.some(value => {
    if (typeof value !== 'string') return false;
    const allowed = value.toLowerCase();
    return allowed === host || (allowed.startsWith('*.') && allowed.length > 2 && host.endsWith(allowed.slice(1)));
  })) return;
  throw new PermissionError(`HTTP host is not granted: ${host}`);
}
