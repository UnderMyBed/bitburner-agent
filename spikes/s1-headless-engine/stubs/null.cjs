// Stand-in for UI-only packages (monaco-editor, monaco-vim). Like the game's Jest NullMock (an empty module),
// but CommonJS so the bundler doesn't check named imports; any property read returns undefined.
module.exports = {};
