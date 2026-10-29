// Merges the lean prefs into Local State / Preferences of a closed profile.
// Usage: osascript -l JavaScript merge-prefs.js <user-data-dir> <prefs.json>
// JXA ships with macOS, so the packaged app needs no Node.
ObjC.import('Foundation');
function read(path) {
  const text = $.NSString.stringWithContentsOfFileEncodingError(path, $.NSUTF8StringEncoding, null);
  return text.isNil() ? null : ObjC.unwrap(text);
}
function deep(target, source) {
  for (const key of Object.keys(source)) {
    const value = source[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (!target[key] || typeof target[key] !== 'object') target[key] = {};
      deep(target[key], value);
    } else target[key] = value;
  }
}
function merge(path, patch) {
  let data = {};
  try { data = JSON.parse(read(path) || '{}'); } catch (error) {}
  deep(data, patch);
  $(JSON.stringify(data)).writeToFileAtomicallyEncodingError(path, true, $.NSUTF8StringEncoding, null);
}
function run(argv) {
  const prefs = JSON.parse(read(argv[1]));
  merge(argv[0] + '/Local State', prefs.localState);
  merge(argv[0] + '/Default/Preferences', prefs.preferences);
}
