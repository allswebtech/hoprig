# Desktop parity: Hoprig's desktop mode against the habits of a desktop

A study of the desktop view of the dashboard (`web/desktop/`). It is not part of the npm package.

**The bar.** Someone who uses a desktop (Windows 11, macOS, GNOME) has nothing to learn. A window moves by its title
bar and resizes from every edge and corner. It snaps to a half or a quarter when dragged to an edge, and with the keys
people know. It maximises and comes back to its place and size, minimises to the bar and comes back, comes to the
front on a click, and cycles with a key. It asks before closing only when something would be lost. The bar shows what
is open and what needs you. Several sessions sit side by side and each keeps working. The layout is there again after
a reload. Touch works. Where a browser cannot do something (a key the computer keeps), there is the nearest thing and
one plain line that says how.

**How this was made.** One row per habit. The column "A real desktop" comes from the public documentation listed at
the bottom ([W1], [W2], [M1], [G1], [G2], all opened for this study). Where no page was opened, the cell says "not
verified". The column "Hoprig's desktop today" is what a real browser showed on the base commit, run by
`tools/desktop-parity-check.mjs`. That check has one check per row, named by the row's Id. It ran on `hoprig demo`:
Chrome headless, 1440 × 900, light theme, seven windows (two App sessions, two Terminal sessions of the stand-in coding
tool, a shell, the Task manager and the Editor). "pNN" names that run's screenshot. Its result was 46 of 62 checks
passing.

**Strict "same".** The same act under another key or in another place counts as "differs". **Not possible:** a browser
page cannot do it. **Priority:** first (missed in the first minutes), second (in the first week), later, never (same,
or not possible). **Size:** small (an hour or two), medium (half a day), large (more).

Rows: 65. Verdicts: same 42, differs 10, missing 9, not possible 4. Priority: first 11, second 8, later 1, never 45.

## Moving and sizing

| Id | A real desktop | Hoprig's desktop today | Verdict | What happens instead | Priority | Size |
|---|---|---|---|---|---|---|
| move | Drag the title bar (all three; GNOME [G1] "grab the titlebar") | Moves exactly as far as the pointer: 150, 60 (p01) | same | | never | small |
| dblclick-max | GNOME: "double-click the titlebar" maximises [G1]; Windows 11 the same (not verified) | Maximises to the work area | same | | never | small |
| dblclick-restore | GNOME: double-click again restores [G1] | Back to its place and size | same | | never | small |
| resize-n | Resize from the top edge, an up-down cursor (not verified) | Resizes, the bottom stays; `ns-resize` | same | | never | small |
| resize-s | Bottom edge (not verified) | Resizes; `ns-resize` | same | | never | small |
| resize-e | Right edge (not verified) | Resizes; `ew-resize` | same | | never | small |
| resize-w | Left edge (not verified) | Resizes, the right edge stays; `ew-resize` | same | | never | small |
| resize-ne | Top right corner (not verified) | Resizes; `nesw-resize` | same | | never | small |
| resize-nw | Top left corner (not verified) | Resizes; `nwse-resize` | same | | never | small |
| resize-se | Bottom right corner (not verified) | Resizes; `nwse-resize` | same | | never | small |
| resize-sw | Bottom left corner (not verified) | Resizes; `nesw-resize` | same | | never | small |
| resize-min | A window has a smallest size (not verified) | Stops at 320 × 200 | same | | never | small |
| escape-drag | Windows: Escape during a move puts the window back (not verified) | The window stays where it was dragged (601, 318 instead of 401, 218) | missing | Escape does nothing during a drag or a resize | second | small |

## Snapping

| Id | A real desktop | Hoprig's desktop today | Verdict | What happens instead | Priority | Size |
|---|---|---|---|---|---|---|
| snap-half | Windows 11: drag to the left or right edge "to snap it to that side" [W1] | Takes the left half (p02) | same | | never | small |
| snap-quarter | Windows 11: drag "into a corner to snap it to that quarter" [W1] | Takes the top right quarter | same | | never | small |
| snap-max | GNOME: drag to the top maximises [G1]. Windows 11: the top opens the Snap bar of layouts [W1] | Maximises | same | Same as GNOME. There is no Snap bar of layouts (row snap-layouts) | never | small |
| snap-preview | Windows 11: drag on "until a translucent overlay appears" [W1] | An outline in the accent colour shows the half before the release (p02) | same | | never | small |
| snap-away | GNOME: "drag it away from the edges of the screen" restores it [G1] | Its own size back, held at the same share of the bar (0.64 → 0.67) | same | | never | small |
| max-drag | GNOME: a maximised window dragged away restores [G1] | Its own size back under the pointer | same | | never | small |
| snap-layouts | Windows 11: hover the maximise button or Win+Z for layouts [W1]; macOS: the green button's menu [M1] | No layouts menu. The title bar's menu has the halves and quarters | differs | The title bar's menu (right click, long press) is the nearest thing | later | medium (not reached in this lane) |

## The keys

| Id | A real desktop | Hoprig's desktop today | Verdict | What happens instead | Priority | Size |
|---|---|---|---|---|---|---|
| keys-snap | Windows 11: Win+Left and Win+Right snap to a side [W2]; macOS: Fn+Control+arrows take a half [M1] | Alt+Shift+Left a half, then Up its top quarter, Down back where it was | differs | Another modifier: the Windows key and Fn+Control belong to the computer | first | small |
| keys-max | Windows 11: Win+Up maximises [W2]; GNOME: Super+Up [G1] | Alt+Shift+Up maximises, Down restores its place and size | differs | Another modifier, as above | first | small |
| min-key | Windows 11: Win+Down minimises [W2] | Alt+Shift+M; also Alt+Shift+Down from its own place | differs | Another modifier, as above | first | small |
| close-key | Windows 11: Alt+F4 closes the active window [W2]; macOS Cmd+W (not verified) | Alt+Shift+W | not possible | Alt+F4 and Cmd+W close the browser's own window or tab. Alt+Shift+W is the nearest thing | never | small |
| cycle | Windows 11: Alt+Tab, held, "switch between open windows" [W2]; GNOME: Super+Tab, Super+\` [G2]; macOS Cmd+Tab (not verified) | Alt+Shift+\` does nothing; no key cycles the windows | missing | Nothing | first | medium |
| cycle-min | Alt+Tab also reaches a minimised window and brings it back (not verified) | Nothing (no cycle key) | missing | Nothing | first | small |
| system-keys | Alt+Tab, Cmd+Tab and the Windows key are the computer's | The browser never sees them. No line says so, and none says what to use instead | not possible | One plain line is missing: "Alt+Tab belongs to your computer; here it is Alt+Shift+\`." | first | small |
| keys-terminal | A window's keys work whatever app is in it (not verified) | With the keyboard in a terminal window, Alt+Shift+Right did nothing: the terminal took the key | differs | The keys work only with the keyboard on the desktop or in a native app | first | small |
| keys-editor | An editor keeps its own keys | Alt+Shift+Down added a second cursor in the editor; the window stayed | same | The editor takes every Alt+Shift key itself, so W and M do not reach the desktop from it either (not checked on the base) | never | small |
| menu-keys | macOS: Window > Move & Resize lists each act with its key [M1] | The title bar's menu lists the acts with no key (p06) | missing | No key is shown anywhere | second | small |
| settings-keys | The window keys can be changed (Windows, GNOME settings; not verified) | Settings → Appearance has only the desktop's style (p14) | missing | No list of the keys and no choice | second | small |

## The front window and the bar

| Id | A real desktop | Hoprig's desktop today | Verdict | What happens instead | Priority | Size |
|---|---|---|---|---|---|---|
| first-click | A click on a window behind brings it to the front (all three; not verified) | The first press brings it forward and is not passed into its page | same | | never | small |
| bar-front | Windows: the taskbar button of the active window minimises it (not verified) | Minimises it | same | | never | small |
| bar-behind | The taskbar button of a window behind brings it forward (not verified) | Brings it forward | same | | never | small |
| min-bar | Minimised to the bar, back from its button (not verified) | Back in front, at its place and size | same | | never | small |
| focus-after-min | The keyboard stays somewhere useful after a minimise (not verified) | After Alt+Shift+M the keyboard is on the page's body | missing | A keyboard user has to Tab from the top of the page | second | small |
| aria-window | — | Each window is named by its title ("Terminal · shell") | same | | never | small |
| aria-bar-min | A taskbar button's state can be read by a screen reader (not verified) | The bar button says only "pressed" for the front window, nothing for a minimised one | missing | A screen reader cannot tell a minimised window apart | second | small |
| needs-you | Windows: a taskbar button shows when its app needs you (not verified) | The tray's bell counts 3; no window's button has a mark (p01) | missing | The bell lists them, but not on the window that shows the session | first | small |
| ended-bar | — | A shell that ended while its window was minimised: no sign on its button (p09) | missing | It looks the same as a live one | second | small |
| ended-window | — | Brought back, the window says "This session has ended." (p10) | same | | never | small |

## Closing

| Id | A real desktop | Hoprig's desktop today | Verdict | What happens instead | Priority | Size |
|---|---|---|---|---|---|---|
| close-plain | A window with nothing to lose closes at once (not verified) | Closes at once, no question | same | | never | small |
| close-unsaved | An editor asks Save, Don't save, Cancel (not verified) | Asks: Save and close, Close without saving, Cancel (p05) | same | | never | small |
| close-unsaved-drop | "Don't save" closes it | "Close without saving" closes it | same | | never | small |
| close-shell | A terminal window that holds a running shell asks (not verified) | Asks: keep the shell running, end it, or cancel (p04) | same | | never | small |

## Side by side

| Id | A real desktop | Hoprig's desktop today | Verdict | What happens instead | Priority | Size |
|---|---|---|---|---|---|---|
| term-size | A terminal behind or minimised keeps its size (not verified) | 10 rows × 82 columns before and after; 10 rows drawn while minimised | same | | never | small |
| term-scroll | It keeps its scroll place (not verified) | The same first row (389) covered, minimised and back (p03) | same | | never | small |
| chat-place | A chat keeps its place (not verified) | 335 of 670 px before and after a minimise | same | | never | small |

## The layout

| Id | A real desktop | Hoprig's desktop today | Verdict | What happens instead | Priority | Size |
|---|---|---|---|---|---|---|
| reload | Windows come back where they were (not verified) | The same windows in the same places | same | | never | small |
| reload-drag | — | After a reload in the middle of a drag the window is back where the drag began (680, 330), not where it was last shown (480, 180) | differs | What was shown last is lost | second | small |
| reach | No window ends up where it cannot be reached (not verified) | At 1100 × 700 every title bar is inside the work area (p07) | same | | never | small |
| back-1440 | Windows go back to their places when the screen gets larger again (not verified) | Back at 1440 the windows keep the places they were pushed to at 1100 (a Sessions window: y 290 → 202) | differs | The layout of the larger screen is lost | first | small |
| dock-and-back | — | Taskbar to Dock and back: every window in its place (p08) | same | | never | small |
| two-tabs | — | A tab behind does not take the windows another tab opened; its next change would write over them | differs | Two tabs on one desktop each keep their own windows, and the one changed last wins | second | small |
| two-tabs-kept | — | No window was lost in this run (the tab behind had changed nothing) | same | | never | small |

## Touch

| Id | A real desktop | Hoprig's desktop today | Verdict | What happens instead | Priority | Size |
|---|---|---|---|---|---|---|
| touch-size | Windows 11 on a touch screen: bigger targets (not verified) | At 1366 × 1024 with touch the edge grips are 14 px, the corner grips 22 px, the Dock style's buttons 20 px (p11, p12) | differs | Hard to hit with a finger | first | small |
| touch-move | A finger drags the title bar | Moves 100, 80 (p13) | same | | never | small |
| touch-resize | A finger resizes from a corner | Resizes 60, 40 | same | | never | small |
| touch-resize-edge | A finger resizes from an edge | Nothing happened: 0 px | differs | Only the corners work with a finger | first | small |
| touch-menu | A long press opens the menu | Opens it (tools/desktop-check.mjs, part touch) | same | | never | small |

## Looks and screens

| Id | A real desktop | Hoprig's desktop today | Verdict | What happens instead | Priority | Size |
|---|---|---|---|---|---|---|
| grid-1000 | — | Below 1024 px the apps are a grid of pages (p15) | not possible | No windows below 1024 × 600 (kept on purpose) | never | small |
| grid-390 | — | The grid at 390 px with touch, no sideways scroll (p16, p17) | same | | never | small |
| dark-taskbar | Dark colours everywhere | Dark (p18, p20, p21) | same | | never | small |
| dark-dock | Dark colours everywhere | Dark (p19) | same | | never | small |
| several-screens | Windows, macOS and GNOME move windows between screens | One browser window is one screen | not possible | Not in this lane | never | large |

## The keys a window's app needs

Before the desktop took a key, these were checked (the desktop's keys are held with Alt+Shift by default):

- **Code editor** (web/editor/, Monaco): Alt+Shift+Up and Down copy a line (Windows, macOS) or add a cursor (Linux);
  Alt+Shift+Left and Right grow and shrink a selection. So the arrows with the desktop's modifiers stay the editor's
  while the keyboard is in it (row keys-editor). M, W and \` are not Monaco keys with Alt+Shift; they stay the desktop's.
- **A text box or the editor on a Mac**: Option+Shift with an arrow selects by word, and with a letter or \` it types
  a character (W is „, M is Â; macOS reports no AltGraph). So there every key of the desktop's stays with the text box;
  the title bar's menu has every act.
- **A terminal** (a shell, tmux, the coding tool): readline uses Alt with a letter (Alt+B, Alt+F), tmux's keys follow
  its prefix (Ctrl+B), the coding tool uses Shift+Tab and Alt+M (without Shift). None uses Alt+Shift with an arrow,
  M or W (bash's readline maps Alt+Shift+M and W to their lower-case keys only). One default key is taken from a
  shell: Alt+Shift+\` sends Alt+~, readline's complete-username (`bind -p` shows `"\e~": complete-username`). The
  desktop takes these keys there (row keys-terminal); anyone who needs Alt+~ in a shell: Settings → Appearance →
  Desktop keys → Ctrl+Alt or Off.
- **The computer**: Alt+Tab, Cmd+Tab, the Windows key, Alt+F4 and Cmd+W never reach a page. Their nearest things are
  Alt+Shift+\` and Alt+Shift+W, and Settings says so in one line.

## After this lane

The same check (`tools/desktop-parity-check.mjs`), run on the lane's head: 63 of 63 checks pass (the row two-tabs-open
was added). Each row that differed or was missing above, and what it does now:

| Id | Now | Test |
|---|---|---|
| escape-drag | Escape during a move or a resize puts the window back, also with the keyboard in a window's page | browser check |
| keys-snap, keys-max, min-key | The same keys, held with Alt+Shift, Ctrl+Alt (Settings) or none; the key is shown in the menu | windows.test.mjs, browser check |
| cycle, cycle-min | Alt+Shift+\` goes to the window used before; held, each press goes on; a minimised one comes back last. Differs on GNOME: its default switch-group-backward is Shift+Alt+Above_Tab [G3], so there the key never reaches the page; "Next window" in the title bar's menu goes on, and Settings says so on Linux | windows.test.mjs (order, the Settings line), browser check |
| keys-gnome-ctrl-alt | With Ctrl+Alt chosen, GNOME's default switch-to-workspace-left/right/up/down is Ctrl+Alt with an arrow [G3]: there the snap, maximise and restore keys switch workspaces instead; only Ctrl+Alt+M, W and \` reach the desktop, and Settings says so on Linux (not run in a real GNOME session; read from the shipped defaults) | windows.test.mjs (the Settings line) |
| system-keys | Settings → Appearance: "Alt+Tab belongs to your computer; here it is Alt+Shift+\`." On a Mac: "Cmd+Tab belongs to your computer; here it is Option+Shift+\`.", and every key is written with Option. Differs on GNOME, where Alt+Shift+\` is the computer's too [G3]: on Linux Settings adds that "Next window" in the title bar's menu goes on there | windows.test.mjs, browser check |
| keys-terminal | The keys work with the keyboard in a terminal window (so Alt+Shift+\` is not readline's Alt+~, complete-username, there: Ctrl+Alt or Off gives it back); the editor keeps the arrows, a text box keeps every key on a Mac | windows.test.mjs, browser check |
| keys-way-out | F6 in a window's page (a terminal or the editor, which keep Tab) takes the keyboard to its title bar, also with the keys off; Settings says so under the choice. On a Mac, Settings says Fn+F6: by default a Mac keyboard's top row sends the system's keys (brightness, sound) and F6 only with Fn held (read from macOS's default, not tried on a real Mac). The cost: F6 no longer reaches a program in a terminal window (htop's Sort by, mc's Move); every other key does | windows.test.mjs (the Settings line), browser check (terminal-way-out) |
| menu-key | The context-menu key (or Shift+F10) on a title bar's button opens the window menu with every act, also with the keys off, so the quarters, "Next window" and Reload are reached by the keyboard alone | browser check |
| menu-keys | The title bar's menu shows each act with its key, and has "Next window"; a quarter has no key of its own, so its hint is the two presses that reach it ("Alt+Shift+← ↑") | windows.test.mjs, browser check |
| settings-keys | One list of the keys and one choice: Alt+Shift, Ctrl+Alt, Off (on a Mac: Option+Shift, Ctrl+Option, Off) | windows.test.mjs, browser check (settings-keys, settings-keys-mac) |
| focus-after-min | After a minimise by the keyboard (its key, Enter on the title bar's Minimise, Enter or Space on the front window's bar button or dock item), the keyboard is on its bar button. Enter on a tray button (the colours) leaves the keyboard on it when the bars are drawn again | browser check (focus-after-min-enter, focus-after-min-space, focus-after-theme) |
| aria-bar-min | A bar button is named "…, minimised", "…, needs you", "…, session ended"; the front window's button is pressed (aria-pressed), so "in front" is not said twice. A menu item's key is its aria-keyshortcuts, and the drawn key is hidden from a screen reader | windows.test.mjs, browser check |
| needs-you | A bar button (and a dock item) carries the tray's bell while its session needs you | browser check |
| ended-bar | A session that ended while its window was minimised shows "ended" on its button: a shell that left the list, and a coding session whose program ended (its terminal stays as a shell, which the window then shows). That second mark is a notice: once the window is in front, the shell left in it is a shell that runs, and the mark goes | windows.test.mjs, browser check (ended-bar, ended-coding, ended-coding-seen) |
| reload-drag | A reload in the middle of a drag keeps the place last shown | browser check |
| back-1440 | A window's own rect is kept; a smaller area shows it fitted; back at 1440 the layout is the same | windows.test.mjs, browser check |
| two-tabs | A tab behind takes another tab's layout and writes none over it; a tab in view takes it on its next use, and before it keeps a change of its own (a page that moved on in a window, the tab closed), so neither tab's change is lost. What a tab changed itself since it last kept a window (its place, minimised or not, its page) stays when it takes the other tab's layout; the window its keyboard is in stays in front, also when the other tab closed or minimised it; a tab nobody uses does not change while someone looks at it | windows.test.mjs, browser check (two-tabs-both, two-tabs-moved-on, two-tabs-both-move, two-tabs-drag, two-tabs-closed-in-use) |
| touch-size, touch-resize-edge | On a touch screen every grip and title-bar button is at least 24 px; a finger resizes from an edge; the title-bar buttons lie above the grips that reach into the window, so a tap near the top of Close closes it | browser check (touch-buttons, touch-close-corner) |

Not reached in this lane: snap-layouts (a layouts menu on the maximise button), several-screens.

## Sources

- [W1] Windows 11, "Snap your windows": https://support.microsoft.com/en-us/windows/snap-your-windows-885a9b1e-a983-a3b1-16cd-c531795e6241
- [W2] Windows, "Keyboard shortcuts in Windows": https://support.microsoft.com/en-us/windows/keyboard-shortcuts-in-windows-dcc61a57-8ff0-cffe-9796-cb9706c75eec
- [M1] macOS, "Tile windows on Mac" (the shortcuts and the green button): https://support.apple.com/guide/mac-help/tile-windows-mchl9674d0b0/mac
- [G1] GNOME, "Maximize and unmaximize a window": https://help.gnome.org/users/gnome-help/stable/shell-windows-maximize.html.en
- [G2] GNOME, "Useful keyboard shortcuts": https://help.gnome.org/users/gnome-help/stable/shell-keyboard-shortcuts.html.en
- [G3] GNOME's window-manager key schema, `org.gnome.desktop.wm.keybindings` (gsettings-desktop-schemas 50.0), its
  defaults for `switch-group-backward` and `switch-to-workspace-left`, `-right`, `-up`, `-down`
