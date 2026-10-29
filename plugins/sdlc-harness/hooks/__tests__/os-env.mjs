// What the tests keep of the machine's environment beyond PATH. Elsewhere,
// nothing. On Windows, the system's own variables: a process started without
// them can wait on a timeout (the judge's PowerShell lookup took 11 to 23
// seconds a call in CI, against half a second with them). Nothing that steers
// git is kept, so the tests stay hermetic: no GIT_*, HOME, or XDG_*.
export function osEnv() {
  if (process.platform !== 'win32') return {};
  const keep = {};
  for (const [k, v] of Object.entries(process.env)) {
    const K = k.toUpperCase();
    if (K === 'PATH' || K === 'HOME' || K.startsWith('GIT_') || K.startsWith('XDG_')) continue;
    keep[k] = v;
  }
  return keep;
}
