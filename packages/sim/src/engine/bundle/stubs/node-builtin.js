// Stand-in for Node built-ins that browser code imports conditionally. The game is built for the web with
// `fallback: { crypto: false }` (webpack.config.js), so the browser build has no `crypto` module either.
export default {};
