// Rescues three's addons from electron-builder's node_modules pruning.
//
// app-builder-lib keeps a hardcoded list of directory names it strips from the
// top level of every package it copies (NodeModuleCopyHelper.js):
//
//     test, tests, __tests__, powered-test, example, examples, .bin
//
// three ships its addons in `examples/jsm` — GLTFLoader, FBXLoader,
// DRACOLoader, OrbitControls, RoomEnvironment and stats — and the import map in
// index.html points "three/addons/" straight at that directory. So the entire
// folder was silently dropped from the installer.
//
// What that looked like was not a missing-file error. talkinghead.mjs imports
// those six; PanelGrid imports talkinghead; app.js imports PanelGrid. One 404
// anywhere in an ES module graph fails the whole graph, so *no* renderer
// JavaScript ran at all — and because the intro splash is plain HTML and CSS,
// it still drew itself and sat there, frozen mid-animation, with no error
// anywhere and even the click-to-skip handler missing. It looked like a hang.
//
// A `files` pattern cannot fix this on its own: the check in that file requires
// both a matching files pattern *and* a truthy result from this hook before it
// will skip the exclusion. Hence both, in package.json's build config.
//
// Deliberately narrow. Returning true here also skips the extension filters for
// the matched path, so a broad pattern would start dragging .d.ts files and
// test fixtures out of every dependency.
module.exports = function onNodeModuleFile(file) {
  return /[\\/]node_modules[\\/]three[\\/]examples([\\/]|$)/.test(file);
};
