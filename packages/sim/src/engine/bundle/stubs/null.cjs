// Stand-in for UI-only packages (monaco-editor, monaco-vim), like the game's Jest NullMock. CommonJS, so the bundler
// doesn't check named imports; every property read returns undefined.
module.exports = {};
