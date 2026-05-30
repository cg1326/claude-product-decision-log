# decision-log

I was in the middle of a long Claude Code session when I realized I'd made about a dozen real product decisions and had no record of any of them. Not just what I built, but why I built it that way, what I decided not to build, and what I pushed to later. The reasoning lived in the conversation and nowhere else.

Git captures what you shipped and PRs capture what changed. Even if you were to capture /summary at the end of each Claude session and transfer it to a Notion doc, it's not immediate nor packaged in a way that clearly segments your thinking (particularly if someone asks you to explain why you decided to build X instead of Y). Also, nothing captures why you went one direction over another, or what you explicitly ruled out. With Claude Code that problem got worse for me, because I started making a week's worth of decisions in a single session. When the session ends, that context is just gone.

So I built decision-log. It hooks into Claude Code and extracts decisions automatically when a session ends. The log writes itself.

<br>

<img width="651" height="670" alt="Screenshot 2026-05-30 at 3 54 17 PM" src="https://github.com/user-attachments/assets/71c554f9-bb60-453d-8645-538af182d164" />


## What it captures

Four things that currently leave no trace:

- **Decided**: a direction chosen over alternatives. *"Chose Postgres over SQLite because we need concurrent writes from multiple workers."*
- **Deferred**: explicitly pushed to later. *"Live collaboration goes in v2. Too much scope to ship now."*
- **Reversed**: a previous call that changed. *"Switched from REST to GraphQL once the mobile client requirements became clear."*
- **Rejected**: considered and permanently ruled out. *"Native app is off the table. Web-only. We don't have the mobile expertise and the use case doesn't justify it."*

Rejected alternatives matter most. They're the decisions that leave the least trace anywhere: no commit, no PR, no ticket, no comment. They're invisible by definition, so six months later when someone asks "why aren't we native?" the answer is locked inside a conversation that no longer exists.

## How it works

```
Claude Code session ends → hook reads transcript → Claude extracts decisions → you confirm each → saved to local SQLite
```

When a session ends, the Stop hook fires. It reads the session transcript, calls the Anthropic API to extract genuine decisions (not implementation steps, not debugging), and prompts you in the terminal:

```
Found 2 decisions in this session. Review each:

--- Decision 1/2 ---
Decision:   Ruled out native app — building web-only
Considered: Native iOS/Android vs progressive web app vs web-only
Rationale:  No mobile expertise on the team; use case doesn't require it
Status:     rejected
Log this decision? (y/n): y

--- Decision 2/2 ---
Decision:   Deferred multi-tenant support to v2
Considered: Building it now vs scoping down to single-tenant for launch
Rationale:  No enterprise customers in pipeline yet; adds significant auth complexity
Status:     deferred
Log this decision? (y/n): y

Saved 2 decisions to users-you-your-project log.
```

You say yes or no for each one, and confirmed decisions go into a local SQLite database at `~/.decision-log/`.

## Web UI

```bash
npm run serve
```

Opens at `http://localhost:3456`. To use a different port:

```bash
DECISION_LOG_PORT=4000 npm run serve
```

The UI shows a timeline of every decision per project, cross-project search, status filters, and a nudge when deferred decisions haven't been revisited in 30 days. You can export any project as Markdown, edit or delete entries from the browser, and restore deleted decisions from Trash.

## Install

```bash
git clone <this repo>
cd decision-log
npm install
npm run build
```

Register the Stop hook in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/decision-log/dist/hooks/stop.js"
          }
        ]
      }
    ]
  }
}
```

Then set your API key:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

Once registered, the hook runs automatically at the end of every Claude Code session. Start the web UI whenever you want to browse your history.

## Scope

decision-log only captures decisions made inside Claude Code sessions. Decisions from meetings, Slack, or other contexts won't appear unless you add them manually through the web UI. If a session is mostly implementation with no real tradeoffs, it exits silently without logging anything.

The tool is local-only (no sync / accounts / cloud storage). 
