/**
 * Electron prefixes every rejected IPC call with the method name
 * ("Error invoking remote method 'report:generate': ApiError: …"), which buries
 * the only part the candidate can act on. Main-process errors are already
 * written as plain sentences; this just uncovers them.
 */
export function cleanError(e) {
  return String(e?.message || e)
    .replace(/^Error invoking remote method '[^']+':\s*/, "")
    .replace(/^(Error|ApiError):\s*/, "");
}
