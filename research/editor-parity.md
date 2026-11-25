# The built-in editor next to VS Code

Made on 18 Nov 2026. The VS Code column comes from VS Code's own documentation, downloaded that day (copies kept
outside the repository); the editor's column from the editor itself in headless Chrome on `hoprig demo` (its own
temporary folders), on a made-up git project `alpha` (JavaScript, CSS, JSON, Python, Markdown, a change, a staged
change, a 2.3 MB log and a PNG), driven by `tools/editor-check.mjs` and `tools/editor-check-flows.mjs`. Every key of
the first table was sent through the DevTools protocol before the fixes and after them.

Sources:

| Key | Page |
|---|---|
| UI | https://code.visualstudio.com/docs/getstarted/userinterface |
| KB | https://code.visualstudio.com/docs/getstarted/keybindings |
| LX | https://code.visualstudio.com/shortcuts/keyboard-shortcuts-linux.pdf (the printable Linux list) |
| CB | https://code.visualstudio.com/docs/editor/codebasics |
| EE | https://code.visualstudio.com/docs/editor/editingevolved |
| CN | https://code.visualstudio.com/docs/editor/codenavigation: answered 404 that day; Go to Symbol and Definition are on EE and LX |
| SC | https://code.visualstudio.com/docs/sourcecontrol/overview |
| TB | https://code.visualstudio.com/docs/terminal/basics |
| ST | https://code.visualstudio.com/docs/getstarted/settings |
| WEB | https://code.visualstudio.com/docs/setup/vscode-web ("Keyboard shortcuts": Ctrl+W, Ctrl+N and Ctrl+Shift+P in the web, and the keys used instead) |
| SRC | VS Code's own source, where a web key is set: src/vs/workbench/contrib/files/browser/fileCommands.ts (New File: Ctrl+Alt+N in the web) |
| CR | Chromium's chrome/browser/ui/browser_command_controller.cc: the commands a browser tab keeps |

Verdicts: same 54, differs 19, missing 41, not possible in a browser 13, hoprig only 6 (133 rows). "Verdict" is what the first
run found; "Done in" is the commit that changed it, "not reached", or the nearest thing for a row a browser cannot do.
58 rows were changed; not reached: K30, T12, E3, E6, E7, G7, G8, TR4, C5, B5, B6, ST4, ST5. "Not proven" marks a row whose result the check could not see.

Estimate (written down with this table, after the first key run, not before it): 133 rows at about 5 minutes
each to try and write (about 11 hours), then the fixes, the rows a VS Code user misses in the first minutes
(priority "first") before the rest. The rows "not reached" are where the time ran out. Sizes: S under an hour, M a few
hours, L a day or more.

The editor component is monaco-editor 0.58.0 (MIT licence, copyright Microsoft Corporation; the package carries
LICENSE and ThirdPartyNotices.txt). Nothing of it was changed: its files are served as installed, with their own
header comments (for example /vendor/monaco/0.58.0/vs/loader.js begins with its copyright and "Released under the
MIT license"). Nothing sends a file's content outside the dashboard: Monaco is loaded from the dashboard's own
files, formatting is Monaco's own, the terminal is the dashboard's own shell route, and the content security
policy is as it was.


## Keys and chords

Each key was sent through the DevTools protocol (`Input.dispatchKeyEvent`) on a fresh editor page, with app.js open and the cursor in it, before the fixes and after them (tools/editor-check.mjs). "Taken" means something called preventDefault on it; "none reached the page" means Chrome kept it before the page saw it. The keys are VS Code's Linux keys (LX, KB).

| Id | VS Code | Hoprig's editor today | Verdict | Why | Priority | Size | Done in |
|---|---|---|---|---|---|---|---|
| K1 | Save: Ctrl+S (LX) | before: saved, the dot went. after: the same | same |  | first | - | - |
| K2 | Save All: Ctrl+K S (KB) | before: both strokes taken, nothing saved. after: saved | missing | no command behind the chord | first | S | 84368c2 |
| K3 | Quick Open: Ctrl+P (LX) | before: Go to file opened. after: the same; with no text the open files come first | same |  | first | - | - |
| K4 | Show All Commands: Ctrl+Shift+P (LX) | before: Monaco's palette with the code editor's commands only. after: also every command of the page, with its key | differs | the page's commands (save all, close, terminal ...) were not in it | first | M | 84368c2 |
| K5 | Show All Commands: F1 (LX, WEB: the key VS Code for the Web gives where Firefox keeps Ctrl+Shift+P) | before and after: the palette opened | same |  | first | - | - |
| K6 | Find: Ctrl+F (LX) | before and after: the find box opened | same |  | first | - | - |
| K7 | Replace: Ctrl+H (LX) | before and after: find and replace opened | same |  | first | - | - |
| K8 | Find next: F3 (LX) | before and after: the next match selected | same |  | first | - | - |
| K9 | Find in Files: Ctrl+Shift+F (LX) | before and after: Search shown | same |  | first | - | - |
| K10 | Replace in Files: Ctrl+Shift+H (LX) | before: not taken, nothing. after: Search with its Replace box | missing | no replace across files at all | first | L | cd8f866, 84368c2 |
| K11 | Go to Line: Ctrl+G (LX) | before and after: Monaco's ":" box | same |  | first | - | - |
| K12 | Go to Symbol in Editor: Ctrl+Shift+O (LX) | before and after: Monaco's "@" box | same |  | first | - | - |
| K13 | Show all Symbols: Ctrl+T (LX) | before and after: none reached the page (Chrome opens a new tab, CR) | not possible in a browser | Chrome keeps Ctrl+T; symbols across files also need a language server | never | - | nearest: Ctrl+Shift+O in the file; the line names Ctrl+T |
| K14 | Add Selection to Next Find Match: Ctrl+D (LX) | before and after: 2 cursors | same |  | first | - | - |
| K15 | Select all occurrences: Ctrl+Shift+L (LX) | before and after: every match selected | same |  | first | - | - |
| K16 | Insert cursor below: Shift+Alt+Down (CB, Linux) | before and after: 2 cursors | same |  | first | - | - |
| K17 | Insert cursor below, Windows key Ctrl+Alt+Down (CB) | before and after: nothing (not taken) | same | VS Code on Linux uses Shift+Alt+Down (K16) | - | - | - |
| K18 | Move line down: Alt+Down (LX) | before and after: the line moved | same |  | first | - | - |
| K19 | Copy line down: Ctrl+Shift+Alt+Down (Linux, Monaco's Linux binding) | before and after: one line more | same |  | first | - | - |
| K20 | Copy line down, Windows key Shift+Alt+Down | before and after: a cursor below (the Linux meaning, K16) | same | as VS Code on Linux | - | - | - |
| K21 | Delete line: Ctrl+Shift+K (LX) | before and after: one line less | same |  | first | - | - |
| K22 | Toggle line comment: Ctrl+/ (LX) | before and after: commented | same |  | first | - | - |
| K23 | Toggle block comment: Ctrl+Shift+A (LX) | before and after: commented | same |  | first | - | - |
| K24 | Format document: Ctrl+Shift+I (LX) | before: JSON formatted; in Python nothing was said. after: JSON formatted; in Python "No formatter for this language in the browser editor ..." | differs | Monaco formats JSON, CSS, HTML, JavaScript and TypeScript only; no program of the project is started | second | S | 84368c2 |
| K25 | Format document, Windows key Shift+Alt+F | before and after: nothing | same | VS Code on Linux uses Ctrl+Shift+I (K24) | - | - | - |
| K26 | Format selection: Ctrl+K Ctrl+F (LX) | before and after: the selection formatted (JSON) | same |  | second | - | - |
| K27 | Undo: Ctrl+Z (KB) | before and after: the edit undone | same |  | first | - | - |
| K28 | Redo: Ctrl+Shift+Z (KB, Linux) | before and after: the edit again | same |  | first | - | - |
| K29 | Redo: Ctrl+Y (KB) | before and after: the edit again | same |  | first | - | - |
| K30 | Split editor: Ctrl+\ (LX) | before and after: nothing (not taken) | missing | one editor group only | second | L | not reached |
| K31 | Close editor: Ctrl+W (LX) | not sent: Chrome closes its tab (the first run lost its page to it) | not possible in a browser | Chrome keeps Ctrl+W; VS Code for the Web says the same (WEB) | first | S | 84368c2: nearest Ctrl+Shift+Alt+N, the line in the palette and in Keyboard shortcuts |
| K32 | Close editor, VS Code for the Web: Ctrl+Shift+Alt+N (WEB) | before: nothing. after: the tab closed | missing |  | first | S | 84368c2 |
| K33 | Close All: Ctrl+K Ctrl+W (LX) | not sent: its second stroke is Ctrl+W | not possible in a browser | Chrome keeps Ctrl+W | second | S | 84368c2: nearest Ctrl+K W, and the tab menu |
| K34 | Reopen closed editor: Ctrl+Shift+T (LX) | before: reached the page, nothing. after: reopened README.md. In a real Chrome tab the browser reopens its own closed tab (CR: IDC_RESTORE_TAB) | not possible in a browser | kept by a browser tab; works where it reaches the page (the dashboard installed as an app) | second | S | 84368c2: nearest Ctrl+K Shift+T |
| K35 | Open next editor: Ctrl+PageDown (LX) | before and after: none reached the page | not possible in a browser | Chrome keeps it (next tab) | second | S | 84368c2: nearest Ctrl+K PageDown |
| K36 | Open previous editor: Ctrl+PageUp (LX) | before and after: none reached the page | not possible in a browser | Chrome keeps it | second | S | 84368c2: nearest Ctrl+K PageUp |
| K37 | Next editor in group: Ctrl+K Ctrl+PageDown (LX) | before and after: Ctrl+K taken, the second stroke never arrived | not possible in a browser | Chrome keeps Ctrl+PageDown also as a second stroke | second | S | 84368c2: Ctrl+K PageDown |
| K38 | Open next (recent): Ctrl+Tab (LX) | before and after: none reached the page | not possible in a browser | Chrome keeps it | second | - | nearest: Ctrl+P lists the open files first; Ctrl+K PageDown |
| K39 | Zoom in: Ctrl+= (LX) | before and after: not taken; the browser zooms the whole page | same | the browser's zoom does what VS Code's window zoom does | - | - | - |
| K40 | Zoom out: Ctrl+- (LX) | as K39 | same | as K39 | - | - | - |
| K41 | Toggle Side Bar: Ctrl+B (LX) | before: not taken, nothing. after: the side bar hid and came back | missing |  | first | S | 84368c2 |
| K42 | Toggle Panel: Ctrl+J (KB) | before: not taken (in a real Chrome tab: its Downloads page). after: the panel opened | missing | no panel | first | M | 84368c2 |
| K43 | Toggle Terminal: Ctrl+` (LX, TB) | before: not taken, nothing. after: the panel opened with a terminal | missing | no terminal in the editor | first | M | 84368c2 |
| K44 | New File: Ctrl+N (LX) | before and after: none reached the page (Chrome: a new window) | not possible in a browser | Chrome keeps it; VS Code for the Web gives Ctrl+Alt+N (WEB, SRC fileCommands.ts) | second | S | 84368c2: Ctrl+Alt+N |
| K45 | New Untitled Text File, VS Code for the Web: Ctrl+Alt+N (WEB; fileCommands.ts: workbench.action.files.newUntitledFile, an empty editor at once) | before: nothing. after: the New file sheet asks for the name first, then the file is made and opened | differs | there are no untitled editors here (a file is made on disk only with a name); the palette's "File: New File..." is the Explorer's New File | second | S | 84368c2; review fix (the verdict) |
| K46 | Show Explorer: Ctrl+Shift+E (LX) | before and after: Explorer shown | same |  | first | - | - |
| K47 | Show Source Control: Ctrl+Shift+G (LX) | before and after: Source Control shown | same |  | first | - | - |
| K48 | Copy path of active file: Ctrl+K P (LX); Ctrl+Alt+C, and Ctrl+K Ctrl+Alt+C in the editor (fileCommands.ts) | before: both strokes taken, nothing. after: the full path copied, said in a toast; Ctrl+Alt+C and Ctrl+K Ctrl+Alt+C too since the review fix; Ctrl+Alt+C only outside the code and text boxes (VS Code's !editorFocus), and a key with AltGr always types its letter | missing |  | second | S | 84368c2; review fix |
| K49 | Reveal active file in Explorer: Ctrl+K R (LX; electron fileActions.contribution.ts: revealActiveFileInWindows, the system's file manager, Open Containing Folder on Linux) | before: nothing. after: the Explorer row of src/app.js has the keyboard | differs | VS Code's Ctrl+K R opens the system file manager; a browser cannot, so it reveals the row in the Explorer (VS Code's Reveal Active File in Explorer View has no key) | second | S | 84368c2; review fix (the verdict) |
| K50 | Keep preview editor open: Ctrl+K Enter (LX) | before: nothing. after: the preview tab kept (no longer italic) | missing |  | second | S | 84368c2 |
| K51 | User Settings: Ctrl+, (LX) | before: not taken, nothing. after: Settings -> Editor opens (the page leaves the editor; unsaved changes are asked about) | missing | VS Code opens Settings as a tab beside the files; here it is the dashboard's Settings page | second | S | 84368c2 (differs: a page, not a tab) |
| K52 | Toggle word wrap: Alt+Z (LX), for the file in view only (toggleWordWrap.ts: a transient state on the model, the editor.wordWrap setting unchanged) | before: nothing. after: word wrap on for the open file; Settings -> Editor's Word Wrap stays as it was (before the review fix Alt+Z changed that setting for every file); in a Changes or compare tab Alt+Z wraps those changes, as VS Code's toggle does in a diff | missing |  | second | S | 84368c2; review fix |
| K53 | Toggle Tab moves focus: Ctrl+M (LX) | before and after: taken by the code editor; the check could not read the mode | same | Monaco's own command; its effect not proven by the check | second | - | not proven |
| K54 | Close find widget: Escape (CB) | after: the find box closed (the first run did not look for it) | same |  | first | - | - |
| K55 | Jump to matching bracket: Ctrl+Shift+\ (LX) | before and after: the cursor went to the bracket | same |  | later | - | - |
| K56 | Select current line: Ctrl+L (LX) | before and after: the line selected | same |  | second | - | - |
| K57 | Trigger suggestion: Ctrl+Space (LX) | before and after: taken by the code editor; the check did not look for the list | differs | suggestions from the file and, for JavaScript and TypeScript, Monaco's own worker; no language server | never | - | not proven |
| K58 | Rename symbol: F2 (LX) | before and after: taken by the code editor; nothing seen | differs | one file at a time, no language server | never | - | not proven |
| K59 | Go to definition: F12 (LX) | before and after: taken by the code editor; nothing seen | differs | one file at a time, no language server | never | - | not proven |
| K60 | Insert cursor: Alt+Click (LX) | not sent (a mouse gesture) | same | Monaco's own | first | - | not proven |
| K61 | Undo history across a save (CB) | not sent across a save | same | a save keeps the model and its undo stack (tabs.js); the check did not send it | first | - | not proven |
| K62 | Markdown: Open Preview, Ctrl+Shift+V (LX) | review run: nothing, the key not taken | missing | no Markdown preview in the editor | later | M | not reached |
| K63 | Markdown: Open Preview to the Side, Ctrl+K V (LX) | review run: both strokes taken, nothing shown | missing | as K62 | later | M | not reached |
| K64 | Search: Toggle Search Details, Ctrl+Shift+J (CB) | before: nothing, not taken. after: Search shown with its files to include and leave out | missing |  | second | S | review fix |
| K65 | Go Back, Ctrl+Alt+- (LX) | review run: nothing, not taken | missing | no list of places visited | later | M | not reached |
| K66 | Explorer: filter while the tree has the keyboard, Ctrl+Alt+F (UI, Advanced tree navigation) | review run: nothing | missing | Ctrl+P finds a file by name | later | M | not reached |
| K67 | Focus First Editor Group, Ctrl+1 (LX) | before: nothing, not taken. after: the editor has the keyboard (from the tree too) | missing |  | first | S | review fix |
| K68 | Open previous (recent), Ctrl+Shift+Tab (LX) | none reached the page | not possible in a browser | Chrome keeps it (previous tab, CR) | second | S | the one line names it (W2); nearest Ctrl+K PageUp |
| K69 | Ctrl+Enter, Ctrl+Shift+Enter (insert a line below, above), Ctrl+] and Ctrl+[ (indent, outdent), Ctrl+U (cursor undo), Shift+Alt+Right (expand selection), Ctrl+K Ctrl+0 (fold all) (LX) | review run: each worked, Monaco's own | same |  | second | - | - |

## Which keys the browser keeps

What the first run showed, and what the editor does now. A key Chrome keeps never reaches a page in a browser tab; installed as an app (the browser's Install) the page gets every key, and then VS Code's own key works too.

| Id | VS Code | Hoprig's editor today | Verdict | Why | Priority | Size | Done in |
|---|---|---|---|---|---|---|---|
| W1 | Ctrl+W, Ctrl+K Ctrl+W | Chrome closed its tab (the check lost its page to it) | not possible in a browser | CR: IDC_CLOSE_TAB is a reserved command | first | S | 84368c2: Ctrl+Shift+Alt+N (WEB), Ctrl+K W |
| W2 | Ctrl+N, Ctrl+T, Ctrl+Tab, Ctrl+Shift+Tab, Ctrl+PageDown, Ctrl+PageUp | none reached the page, also through the DevTools protocol | not possible in a browser | CR: new window, new tab, tab switching | first | S | 84368c2: Ctrl+Alt+N (WEB), Ctrl+K PageDown/PageUp |
| W3 | Ctrl+Shift+T | reached the page through DevTools; a real tab reopens the browser's own tab | not possible in a browser | CR: IDC_RESTORE_TAB | second | S | 84368c2: Ctrl+K Shift+T |
| W4 | The one plain line | before: nothing said anywhere. after: each such command's palette entry says "(a browser tab keeps Ctrl+W)"; Keyboard shortcuts (Ctrl+K Ctrl+S, and in the editor's menu) opens with one line naming them all; the README says the same | missing | decided: where the person meets the gap, never a popup that comes back | first | S | 84368c2, 641f920 |

## Tabs

Tried with the mouse and the keys in the browser (tools/editor-check-flows.mjs) unless the row says otherwise.

| Id | VS Code | Hoprig's editor today | Verdict | Why | Priority | Size | Done in |
|---|---|---|---|---|---|---|---|
| T1 | Preview tab in italics, replaced by the next file opened from a list (UI) | before and after: italic, replaced; after: its tooltip says it is a preview | same |  | first | - | - |
| T2 | Dirty dot where the close button is (UI) | before and after: the dot, the x on hover | same |  | first | - | - |
| T3 | Close with the x and with a middle click (UI) | before: both close. after: a middle press no longer starts the browser's scrolling | same |  | first | S | 84368c2 |
| T4 | Tab context menu: Close, Close Others, Close to the Right, Close Saved, Close All (UI) | before: no menu (a right click did nothing). after: the menu with VS Code's words and keys; Close Others left one tab | missing |  | first | M | 84368c2 |
| T5 | Pin (sticky tabs: first, never closed by Close All; a middle click and the Close Editor key leave a pinned tab open: workbench.editor.preventPinnedEditorClose, default keyboardAndMouse) (UI) | before: none. after: Pin in the menu and Ctrl+K Shift+Enter; a pin icon instead of the x; Close All, a middle click and Ctrl+Shift+Alt+N (Ctrl+W in an installed app) leave it; the pin button (Unpin) and the menu's Close close it | missing | unit tests (commands.test.mjs); the middle click and the key in the browser (tools/editor-review-check.mjs) | second | S | 84368c2; review fix |
| T6 | Copy Path, Copy Relative Path in the tab menu (UI) | before: none. after: both, with keys | missing |  | second | S | 84368c2 |
| T7 | Reveal in Explorer View (UI; no default key) | before: none. after: in the menu (it no longer names Ctrl+K R there, VS Code's key for the system file manager); Ctrl+K R does the same | differs | as K49 | second | S | 84368c2; review fix |
| T8 | Reorder tabs by drag (UI) | before: none. after: drag a tab onto another, with a mouse; a finger's drag moves nothing (a browser sends drag events for a mouse only) | missing | the order rule has a unit test; the drag itself was not driven in the browser; on touch the tab's menu (a long press) has Close, Pin and the rest, no reorder | second | S | 84368c2 (drag not proven in the browser) |
| T9 | Reopen closed editor (LX) | before: none. after: Ctrl+K Shift+T reopened it with its place | missing |  | second | S | 84368c2 |
| T10 | Next and previous tab (LX) | before: none. after: Ctrl+K PageDown and PageUp | missing | Chrome keeps Ctrl+PageDown and Ctrl+PageUp | second | S | 84368c2 |
| T13 | A badge on the Explorer's icon with the number of unsaved files (CB, Save / Auto Save) | before: none (a dot on the tab only). after: the count on the Explorer's icon, and on the phone bar's Files | missing | | first | S | review fix |
| T11 | Keep open: double click, Ctrl+K Enter (LX) | before: the double click only. after: both | differs |  | second | S | 84368c2 |
| T12 | Editor groups (split) (UI) | none | missing | one group | second | L | not reached |

## The file tree (Explorer)

| Id | VS Code | Hoprig's editor today | Verdict | Why | Priority | Size | Done in |
|---|---|---|---|---|---|---|---|
| E1 | New File, New Folder (UI) | before and after: the panel's buttons and the folder menu; after also Ctrl+Alt+N | same |  | first | - | - |
| E2 | Rename with F2, the name up to its last dot selected (UI; explorerViewer.ts) | before: F2 asked for the new name with nothing selected (typing added to the name). after: the name without its extension is selected, a folder's whole name | differs | | first | S | review fix |
| E3 | Delete with a confirmation (Delete key) (UI) | before and after: Delete asks, then deletes from the disk | differs | VS Code moves it to the trash; here it is deleted (Files has a trash, the editor does not use it yet) | later | M | not reached |
| E4 | Drag to move (UI) | before: none. after: onto a folder or the tree's empty end, with a mouse; never into itself. On touch a drag moves nothing: Cut, then Paste on the folder, in the row's menu (a long press or ...) moves it | missing | the rule has a unit test; the drag itself was not driven in the browser; the move uses the existing rename route | second | M | 09a2516 (drag not proven in the browser) |
| E5 | Cut and paste to move (Ctrl+X, Ctrl+V) (UI) | before: none. after: notes.txt cut and pasted on src moved there on disk | missing |  | second | S | 09a2516 |
| E6 | Copy and paste of files (a copy) (UI) | none | missing | needs a copy route under the folder rules | second | M | not reached |
| E7 | Context menu (UI) | before and after: a right click, the menu key, Shift+F10 or the row's ... open a sheet with the items | differs | a sheet in the page's style, not a menu at the pointer | later | S | not reached |
| E8 | Reveal the active file (LX Ctrl+K R) | before: none. after: the row gets the keyboard | differs | as K49: VS Code's Ctrl+K R opens the system file manager; here the row in the Explorer | second | S | 84368c2; review fix (the verdict) |
| E9 | Collapse Folders in Explorer (UI) | before: the button "Close every folder". after: VS Code's name | same |  | later | S | 09a2516 |
| E10 | Keyboard in the tree (UI): arrows, Home, End, Enter, Space, F2, Delete, Shift+F10 | before and after: all of them | same |  | first | - | - |
| E11 | Copy Path and Copy Relative Path in the tree menu (UI) | before: "Copy the path" (relative only). after: both, in VS Code's words | differs |  | second | S | 09a2516 |

## Search across files

| Id | VS Code | Hoprig's editor today | Verdict | Why | Priority | Size | Done in |
|---|---|---|---|---|---|---|---|
| S1 | Match Case, Match Whole Word, Use Regular Expression; Alt+C, Alt+W, Alt+R (UI) | before: the three switches, no keys. after: the keys too (not sent in the browser) | differs |  | second | S | cd8f866 (keys not proven in the browser) |
| S2 | Files to include and exclude (UI) | before and after: behind the ... button | same |  | second | - | - |
| S3 | Replace across files with a preview and Replace All (UI) | before: none. after: the Replace box under the search box, each result shows what goes struck through and what comes; Replace All asks once and replaces | missing |  | first | L | cd8f866 |
| S4 | An open file: the replace is an edit of its tab, undone with Ctrl+Z (UI) | after: app.js changed in its tab, marked unsaved, not on disk; Ctrl+Z took it back | missing | decided: an open file's undo takes the replace back | first | S | cd8f866 |
| S5 | A file changed on disk meanwhile is skipped and named | after: written over the version it was read at; a refused save is skipped and named in the toast | hoprig only | the save's own check; not driven in the browser (the works review tries it) | first | S | cd8f866 (skip not proven in the browser) |
| S6 | Binary files and big files are not written | after: logo.png and a 2.3 MB log stayed as they were | differs | Search reads no file over 1 MB, so such a file is neither found nor replaced | later | - | - |
| S7 | Results by file, folded per file, a press opens the line (UI) | before and after: so | same |  | first | - | - |
| S8 | Replace All key: Ctrl+Alt+Enter (UI) | after: in the Replace box (not sent in the browser) | missing |  | second | S | cd8f866 (not proven in the browser) |
| S9 | Replace in one file (the file row's Replace All) (CB: "replace all in one file") | none: a result row only opens the file | missing | the nearest thing: Files to include with that file's name, then Replace All | second | M | not reached |
| S10 | Replace a single change (a match row's Replace) (CB: "replace a single change") | none | missing | the nearest thing: open the file from the row and use Ctrl+H there | second | M | not reached |

## Source Control

Seen in the dark 1440 px screenshot and tried by hand in the browser.

| Id | VS Code | Hoprig's editor today | Verdict | Why | Priority | Size | Done in |
|---|---|---|---|---|---|---|---|
| G1 | Changes and Staged Changes with counts (SC) | before and after: both groups with counts | same |  | first | - | - |
| G2 | Stage, unstage, per file and all (SC) | before and after: so | same |  | first | - | - |
| G3 | Commit with Ctrl+Enter in the message box (SC) | before and after: so (the box says it) | same |  | first | - | - |
| G4 | The diff of a change (SC) | before and after: a press opens it side by side | same |  | first | - | - |
| G5 | Discard with a confirmation (SC) | before and after: asks, naming the files | same |  | first | - | - |
| G6 | The count on the Source Control icon (SC; git's repository.ts: merge + staged + changes, untracked with git.countBadge 'all') | before: one per file, so a file staged and changed again counted once. after: every entry of the groups, as VS Code counts | same | the check's project has no file both staged and changed; the rule has a unit test | first | S | review fix |
| G7 | The branch in the status bar; a click picks a branch (UI) | before and after: the branch; a click opens Source Control | differs | no branch change from the editor | later | M | not reached |
| G8 | Sync, push, pull (SC) | none | missing |  | later | M | not reached |

## The editor's terminal

| Id | VS Code | Hoprig's editor today | Verdict | Why | Priority | Size | Done in |
|---|---|---|---|---|---|---|---|
| TR1 | Ctrl+` shows the terminal in the panel, in the folder (TB) | before: none. after: the dashboard's own terminal, `pwd` printed the opened folder | missing | decided: the existing shell route (POST /api/shells, same folder rules), no new way to run a command | first | M | 84368c2 |
| TR2 | Ctrl+` inside the terminal hides it again (TB) | after: so | missing |  | first | S | 84368c2 |
| TR3 | Kill the terminal (TB) | after: the bin button ends the shell (not driven in the browser) | missing |  | second | S | 84368c2 (not proven in the browser) |
| TR4 | Several terminals, Ctrl+Shift+` (TB) | one per folder | missing |  | second | M | not reached |
| TR5 | The terminal stays after a reload (TB: persistent sessions) | after: kept per folder in the browser tab; hiding it keeps the shell (not driven across a reload) | same |  | second | S | 84368c2 (not proven in the browser) |
| TR6 | Where there is no terminal | after: the panel says "No terminal here: <why>." in one line (not driven: the check's dashboard has terminals) | hoprig only | decided: one line | second | S | 84368c2 (not proven in the browser) |

## Copy and paste

The check's Chrome runs headless, without a system clipboard to read back; what goes through the clipboard itself is not proven here.

| Id | VS Code | Hoprig's editor today | Verdict | Why | Priority | Size | Done in |
|---|---|---|---|---|---|---|---|
| C1 | Editor to the system clipboard, Ctrl+C, Ctrl+X; a line with no selection (CB) | Monaco's own copy; not read back | same |  | first | - | not proven |
| C2 | The system clipboard to the editor, Ctrl+V; from another program (CB) | the browser's own paste into Monaco; not sent | same |  | first | - | not proven |
| C3 | Copy and Paste in the editor's context menu (CB) | Monaco's menu has Copy; its Paste needs the browser's clipboard permission | not possible in a browser | a page reads the clipboard only with a permission (WEB says VS Code asks for it too) | second | S | nearest: Ctrl+V; the one plain line not reached |
| C4 | Copy Path, Copy Relative Path (UI) | after: Ctrl+K P copied the full path (the toast said so); the menus have both | missing |  | second | S | 84368c2, 09a2516 |
| C5 | Files in the tree: copy and paste (UI) | cut and paste to move only (E5) | missing |  | second | M | not reached |

## The status bar

| Id | VS Code | Hoprig's editor today | Verdict | Why | Priority | Size | Done in |
|---|---|---|---|---|---|---|---|
| B1 | Ln, Col; a click goes to a line (UI) | before and after: so | same |  | first | - | - |
| B2 | Selection count, "(6 selected)", "N selections (M characters selected)" (UI; editorStatus.ts) | before: none. after: "Ln 1, Col 7 (6 selected)"; with several cursors "2 selections (6 characters selected)" (before the review fix: "Ln 2, Col 10 (2 selections)") | missing |  | first | S | 84368c2; review fix |
| B3 | Indentation "Spaces: 2", or "Tab Size: 2" for a file indented with tabs; a click changes it (UI) | before: "Spaces: 2" also for a file indented with tabs (where Tab types a tab). after: a click picks 2, 4 or 8; a file indented with tabs shows "Tab Size: 2" | differs | the click picks a size only: no "Indent Using Tabs" or "Convert Indentation" | second | S | 84368c2; review fix |
| B4 | Encoding (UI) | before: none. after: "UTF-8" (another encoding opens as a binary file) | missing | no reopen with another encoding | later | S | 84368c2 |
| B5 | Line ending LF/CRLF, a click changes it (UI) | before and after: shown, kept as the file has it, no click | differs |  | later | S | not reached |
| B6 | Language, a click changes it (Ctrl+K M) (UI) | before and after: shown, no click | differs |  | later | S | not reached |
| B7 | The branch (UI) | before and after: shown (G7) | same |  | first | - | - |
| B8 | Problems, notifications (UI) | none | missing | no language server | never | - | - |

## Settings that carry over

| Id | VS Code | Hoprig's editor today | Verdict | Why | Priority | Size | Done in |
|---|---|---|---|---|---|---|---|
| ST1 | editor.fontSize "Font Size" (ST) | before: "Text size". after: "Font Size" | differs |  | second | S | 641f920 |
| ST2 | editor.tabSize "Tab Size" (ST) | before: "Tab size". after: "Tab Size" | differs |  | second | S | 641f920 |
| ST3 | editor.wordWrap "Word Wrap" (ST) | before: "Word wrap". after: "Word Wrap"; Alt+Z too | differs |  | second | S | 641f920 |
| ST4 | The project's .editorconfig and the editor keys of .vscode/settings.json (ST) | not read | missing | decided: read for display and typing only, nothing that runs | second | M | not reached |
| ST5 | What VS Code has and the editor does not (ST): Insert Spaces, Detect Indentation, Rulers, Render Whitespace, Minimap, Line Numbers, Font Family, Cursor Style, Auto Save, Format On Save, Trim Trailing Whitespace, Insert Final Newline, Files: Exclude, Settings Sync | none of them | missing |  | later | L | not reached |
| ST6 | Keyboard Shortcuts (Ctrl+K Ctrl+S), keys can be changed (KB) | before: none. after: the list, read only | differs | keys cannot be changed here | later | S | 84368c2 |

## A phone's width and touch

Seen in the 390 px screenshots with touch, light and dark.

| Id | VS Code | Hoprig's editor today | Verdict | Why | Priority | Size | Done in |
|---|---|---|---|---|---|---|---|
| P1 | VS Code has no phone layout (UI) | before and after: one pane at a time, switched from a bar at the bottom | hoprig only |  | - | - | - |
| P2 | A long press as the right click | after: a long press on a tab opened its menu (the tree's rows already had it) | hoprig only |  | second | S | 84368c2 |
| P3 | The kit's tap size | before and after: tabs, tree rows, menus and buttons at the tap size | hoprig only |  | - | - | - |
| P4 | A phone's on-screen keyboard in the code editor | not proven on a real device (the README says so) | hoprig only |  | - | - | not proven |
