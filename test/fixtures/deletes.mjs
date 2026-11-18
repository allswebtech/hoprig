// The delete lines the bypass rule is held to (src/asking.mjs plainDelete), shared by the tests of the rule and of
// each place that answers by it (test/plaindelete.test.mjs, test/chat/opencode-bypass.test.mjs).

// Lines before which Claude Code 2.1.326 stops in bypass mode and that delete the home folder, the disk, the folder it
// runs in or one above it. Each written as the coding tool sends it.
export const STOPPED = [
  "r''m -rf ~", '"r"m -rf ~', 'r\\m -rf ~', 'R=rm; $R -rf ~', 'timeout 5 rm -rf ~', 'stdbuf -o0 rm -rf ~', 'bash -c -- "rm -rf ~"',
  '/usr/bin/env bash -c "rm -rf ~"', 'rm -rf \\\n  ~', 'rm -rf \\\n  /', 'rm -rf ~>/dev/null', 'rm -rf "$DIR"/*>/dev/null', 'timeout 60 rm -rf "$DIR"/*',
  'rm -rf \\\n  "$DIR"/*', 'ionice -c3 rm -rf ~', 'flock /tmp/l rm -rf ~', 'setsid rm -rf ~', 'su -c "rm -rf ~"', 'script -qc "rm -rf ~"', 'rm -rf ~',
  'rm -rf ~/{,.}*', 'rm -rf {~,/tmp/zz-none}', 'function f { rm -rf ~; }; f', 'coproc rm -rf ~', 'rm$IFS-rf$IFS$HOME', 'rm -rf ~/.claude', 'rm -rf "~/"',
  'rm -rf ~/Workspace', 'rm -rf "$DIR"/*', 'rm -rf $(pwd)/node_modules', 'rm -rf "$PWD/dist"',
  // "working directory or its ancestor"
  'rm -rf .', 'rm -rf ..', 'cd .. && rm -rf *', 'rm -rf ~/Workspace/projects',
];

// The ordinary deletes the owner wants to run unasked, from a project folder (`project`, for the absolute ones).
export const ordinary = (PROJECT) => [
  'rm -rf t1/*/*', 'rm -rf dist/*', 'rm -rf node_modules', 'rm -rf build && rm -rf dist/*', 'rm -rf "my dir/cache"', 'rm -rf dist 2>/dev/null || true',
  `rm -rf ${PROJECT}/build`, `rm -rf ${PROJECT}/t1/*/*`, 'rm -rf ./build/*.map', 'rm -f a.txt b.txt; rm -rf c', 'rm -rf dist >/dev/null 2>&1',
  'rm -rf -- -x', 'rm dist -rf', 'rm -rf dist/', 'rm -r -f --verbose out', 'rm -rf tëst/日本/*', "rm -rf 'old build'/*", 'rm -rf .cache/x', 'rm -d empty',
];
