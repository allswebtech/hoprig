# Mobile apps

- Applies when the "Mobile apps" detail is not "none": then `full`, otherwise `not needed`.
- Light form: none.

The framework is the default stack's (SKILL.md, the stack): Flutter through FVM, with Riverpod and its code
generation, for Android and iOS, unless the owner's defaults name another. Any other framework is a stack change that
goes into the one message with its reason and waits for his ok; then it uses its own equivalents of the commands
below.

1. One app per audience in `code/<folder>-<framework>-<app>` (for example `code/shop-flutter-customer`), each its own
   repository with its own package id. The framework's version pinned in the repository (for example `.fvmrc`).
2. The state library with code generation. Light and dark theme. The same plain-words and same-screen-action rules as
   the web (the ui reference).
3. One public config file (for example `lib/config.dart`) with: a production switch (`isProd`, false in the
   repository), the app's name, and the API's base address: the production `https://<domain>/api/v1` when the switch
   is on, else a development address given at build time (for example `--dart-define=DEV_API_URL=...`) whose default
   is the local server as the Android emulator reaches it (`http://10.0.2.2:3000/api/v1`); the iOS simulator uses
   `localhost`. The file says both in a comment.
4. The apps call only the web project's API, which is versioned (`/api/v1/...`). The rule is in the security
   reference: never break a version that a published app uses.
5. Turning the production switch on is the first step of `STORE_SUBMISSION.md`.
6. No private secrets in the app. Tokens in the platform's secure storage (for example `flutter_secure_storage`).
   Release builds use HTTPS only; plain HTTP only in debug builds, for the local server.
7. An API client with time limits, retries for safe requests, and friendly error and offline states.
8. Smooth: constant widgets, lazily built lists (`ListView.builder`), cached images, rebuilds limited to what changed
   (Riverpod `select`).
9. Accessible: semantics labels, large text support, touch targets of 48 dp.
10. Release builds are obfuscated with the symbols kept apart for crash reports (`--obfuscate
    --split-debug-info=build/symbols`). App icons and splash screens are set.
11. Verify: the analyser with zero issues, deprecations included (`fvm flutter analyze`), the tests
    (`fvm flutter test`), integration tests of the main flows on an emulator or simulator (when none is available,
    say so in the report), a debug build (`fvm flutter build apk --debug`), a store bundle
    (`fvm flutter build appbundle`), the iOS bundle id, and an iOS build without signing
    (`fvm flutter build ios --no-codesign`) when Xcode is installed.
