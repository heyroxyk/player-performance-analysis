// The complete, literal list of every file the static/browser control panel loads, as
// [urlPath, repoRelativePath] pairs. Two consumers read this ONE list: src/web/server.js builds
// its static-file Map from it for local dev, and scripts/buildSite.js copies exactly these files
// into the GitHub Pages artifact. A file that loads locally therefore cannot be missing from the
// deployed site, and vice versa -- the two can't drift, because there is only one list.
//
// It stays a hardcoded literal (not a `src/**` glob) for the same reason src/web/server.js's old
// STATIC_FILES map was one: a request pathname is only ever used as a key into this list, never
// joined into a filesystem path, so path traversal is structurally absent here rather than
// sanitized against. Add a static file by adding an entry here -- widening what's servable is a
// one-line, reviewable change, not an accident of a glob matching more than intended.
//
// test/browserModuleGraph.test.js is this list's actual correctness check: it walks the real
// import graph starting from src/web/public/app.js and fails if a reachable module is missing
// from here, or if an entry here doesn't exist on disk.
export const STATIC_ASSETS = [
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/src/web/public/app.js', 'src/web/public/app.js'],
  ['/src/web/public/format.js', 'src/web/public/format.js'],
  ['/src/web/public/styles.css', 'src/web/public/styles.css'],
  ['/src/commands.js', 'src/commands.js'],
  ['/src/goalieCommands.js', 'src/goalieCommands.js'],
  ['/src/median.js', 'src/median.js'],
  ['/src/browserStore.js', 'src/browserStore.js'],
  ['/src/browserCommandDeps.js', 'src/browserCommandDeps.js'],
  ['/src/snapshotBuild.js', 'src/snapshotBuild.js'],
  ['/src/shlClient.js', 'src/shlClient.js'],
  ['/src/portalClient.js', 'src/portalClient.js'],
  ['/src/playerStatus.js', 'src/playerStatus.js'],
  ['/src/pir/pirEngine.js', 'src/pir/pirEngine.js'],
  ['/src/pir/window.js', 'src/pir/window.js'],
  ['/src/pir/components.js', 'src/pir/components.js'],
  ['/src/pir/population.js', 'src/pir/population.js'],
  ['/src/pir/zscore.js', 'src/pir/zscore.js'],
  ['/src/pir/shrink.js', 'src/pir/shrink.js'],
  ['/src/pir/rate60.js', 'src/pir/rate60.js'],
  ['/src/pir/movement.js', 'src/pir/movement.js'],
  ['/src/pir/goalieComponents.js', 'src/pir/goalieComponents.js'],
  ['/src/pir/goalieEngine.js', 'src/pir/goalieEngine.js'],
  ['/src/pir/goalieWindow.js', 'src/pir/goalieWindow.js'],
  ['/src/report/table.js', 'src/report/table.js'],
  ['/src/report/jsonWriter.js', 'src/report/jsonWriter.js'],
  ['/src/report/csvWriter.js', 'src/report/csvWriter.js'],
  ['/src/report/goalieTable.js', 'src/report/goalieTable.js'],
  ['/src/report/goalieCsvWriter.js', 'src/report/goalieCsvWriter.js'],
];

// Content-Type by extension -- the same three types src/web/server.js's old literal map used.
export const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};
