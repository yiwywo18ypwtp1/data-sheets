// better-sqlite3 is a native module built for Node 22+. On older Node it crashes the
// server on the first database read without any error message, so fail early instead.
const major = Number(process.versions.node.split(".")[0]);
if (major < 22) {
  console.error(`\nData Sheets needs Node.js 22 or newer; this terminal uses ${process.version}.`);
  console.error("Run `nvm use` (reads .nvmrc), or `nvm alias default 22` to make it the default.\n");
  process.exit(1);
}
