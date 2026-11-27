// The long list of every command, one line each with its words and options: what "hoprig help all" prints. The top
// help (bin/hoprig.mjs) is short, and names the rest; the website's tools page reads its lines from here.
import { profilesDir } from './paths.mjs';

export const HELP_ALL = `Hoprig — Claude Code and OpenCode under several providers, and a dashboard for every computer

  hoprig                      choose a profile, then start Claude Code in this terminal
  hoprig chat [folder]        code in a chat in the dashboard instead: prints its address and opens it
                                 in your browser (set up as your last chat in that folder;
                                 --tool opencode: a chat with OpenCode, where the dashboard offers it)
  hoprig <profile> [args]     start under that profile; args go to Claude Code
                                hoprig api -c            continue the last session of this folder
                                hoprig sub2 --resume ID  continue one session
                                hoprig api -- "fix the tests"  start, and send this as the
                                                         session's first message
  hoprig -c | --resume ...    choose a profile, then continue as asked
  hoprig <profile> --with <name>  also let this session read another project of the workspace
                                 (to read; its file tools cannot write there; this session only;
                                 a project's own "needs" come by themselves)

  hoprig opencode [provider] [args]  start OpenCode instead; -c, --resume ID and -- "first message"
                                 as above. Auto mode, plan usage and Tia's engine are Claude
                                 Code's only

  hoprig auto [args]          start in Auto mode: when a provider reaches its limit, work goes on
                                 under the next one without stopping, and comes back by itself

  When a session stops at a limit or an error, Hoprig offers to continue it on another profile.

  hoprig add [name]           add a profile (a provider: another Claude account, an API key, a proxy)
  hoprig profiles [--json]    list profiles
  hoprig profiles map <name> [on|off] [--yes]
                              a provider's model map (MODELS) for every session and chat on it:
                                 what it would rename, and whether it is on (off at first)
  hoprig rm <name> [--yes]    delete a profile (asks first; --yes: without asking)

  hoprig auto status          Auto mode's settings, each provider's usage and limits
  hoprig auto on | off        make Auto the default way to start (off at first)
  hoprig auto order a b c     the providers Auto mode uses, most preferred first

  hoprig demo                 try the dashboard with sample data (no Claude Code or provider needed)
  hoprig pc setup             make a fresh computer ready for coding (git, Node, tools, GitHub, projects)
  hoprig pc status            what this computer has, what is missing, what needs attention
  hoprig project new <name>   a new project: one folder for rules, AI memory and docs, with its code
                                 repositories under code/, all in git
  hoprig project clone <name> get an existing project with all its code repositories and its AI memory
  hoprig get <name>…          the same, short (the folder is the project's name; --dry-run shows it first);
                                 hoprig get --list: every project of your workspace and which computer has it
  hoprig drop <name>…         take a project off THIS computer safely: it pushes first, then checks, then removes
                                 (--check only says what exists only here; --dry-run shows every step)
  hoprig adopt scan|plan|apply  a computer that already has projects: look in the folders you name, a plan per
                                 project, then a proved copy into the workspace (adopt verify | retire)
  hoprig sessions move <old> <new>  the coding tool's conversations of a folder, copied under its new place
  hoprig sync [<name>]        bring the repositories on this computer (or one project) in step with git
  hoprig project status|sync  the state of a project's repositories; pull and push what is safe
  hoprig project setup <name> what a fresh clone sets up (.env, git hooks, memory link, installs)
  hoprig workspace            the one folder tree for your coding: AI brain, projects, credentials
                                 (workspace status | setup | link | map | restore | sync | set | forget | git |
                                 group | find | tool | mylink | rules | label)
  hoprig tasks                Work: your tasks and what needs you today, kept in a file of the workspace
                                 (tasks today | list | add | edit | done | open | drop | remove | do | runs | plans |
                                 plan | save;
                                 "hoprig tasks help" has the rest)
  hoprig ship status <project>  Go live: put finished task branches together, check them, go live on your yes
                                 (status | together | check | allow | live | back | auto; docs/GO-LIVE.md)

  hoprig setup                install what is missing and set everything up, step by step
  hoprig doctor               check that everything works
  hoprig move-to-user         move Hoprig from root to an ordinary user of this server (--dry-run shows it first)
  hoprig box check | run      a box for commands: no network, not your home, only the folders named
                                 (box run --write DIR -- <command>; docs/BOX.md)
  hoprig field                field reports: what Hoprig's own work showed, kept on this computer
                                 (field show <id> | inbox <folder> | way-round; docs/FIELD-REPORTS.md)
  hoprig claude status        Claude Code's version (also: claude update, claude install <version>)
  hoprig tools                the coding tools: Claude Code, OpenCode (tools install <tool>,
                                 tools update <tool | all>, tools on | off <tool>)
  hoprig update               update Hoprig itself

  hoprig link                 a one-time link and QR code that signs a phone or another browser in
  hoprig public on | off      open this dashboard from anywhere through Cloudflare, no server needed
                                 (public on --temporary | --custom; public status)
  hoprig machines             the other computers this dashboard also shows (add, list, remove)
  hoprig join <ssh target>    connect THIS computer out to another dashboard (for a PC behind a router)
  hoprig pair                 let another computer's dashboard control this one
  hoprig tokens               who may control this computer (list, revoke)

  hoprig skills               skills for you and your projects: suggest, find, review and
                                 add, update (skills suggest | find | add | list | update)
  hoprig addons               optional companions, such as an AI gateway that lets Claude Code use
                                 other providers (addons setup <id>)
  hoprig gateways             the gateways Hoprig knows; gateways add | confirm | remove: one of your own
  hoprig mcp                  Hoprig's tools as an MCP server (for the dashboard's assistant and
                                 for any MCP client, such as your own Claude Code)

  hoprig serve                start the web dashboard
  hoprig passwd               set the dashboard password
  hoprig stop                 stop the dashboard (it stays stopped until hoprig service start)
  hoprig service install      run the dashboard in the background, kept running by itself
  hoprig service restart      start the background dashboard again (after an update)
  hoprig service start | stop start or stop it; hoprig stop is the same stop

  Profiles are files in ${profilesDir()}
`;
