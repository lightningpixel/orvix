# Benchmarks

Two numbers matter, not one. Tokens saved is easy to move and easy to fake —
returning nothing at all would score perfectly. The number that keeps it honest
is whether the task still succeeds. A compression that saves 80% and breaks one
task in five is a bad trade, and only measuring both makes that visible.

So there are two arms.

## Synthetic (`--mode synthetic`)

Replays recorded tool results through the real hook scripts and measures the
exact token delta. Free, deterministic, and safe to run on every commit.

Success here is a proxy: for each fixture, an `expect` list names the things the
task needed from that output — a symbol name, an id, a file path. If the
compressed output still contains them, the compression preserved what mattered.
That is a genuine regression guard, but it is *not* evidence about an agent.

```
node benchmarks/run.mjs --mode synthetic
```

## Live (`--mode live`)

Drives real `claude -p` headless sessions over pinned repositories, once with
Orvix installed and once without, and scores success by machine-checkable
assertion — did the named symbol actually get edited, does the project still
build.

This costs API tokens, so it never runs in CI. Run it deliberately, commit the
result, and quote it.

```
node benchmarks/run.mjs --mode live --arm both
```

Results land in `benchmarks/results/`, and the committed files are what the
README figures are taken from.

## A whole session (`npm run session-replay`)

The synthetic arm compares one tool result against its replacement. A session pays for a
result again on every API call that follows it — the whole context is re-sent each time —
until compaction drops it. A saving made on the third turn of a forty-turn session is worth
far more than one made on the thirty-ninth.

`scripts/session-replay.mjs` replays a recorded Claude Code transcript through the real
compression hook, in order, and charges each saving once per later API call up to the next
compaction. The total is set against the input the transcript says the API really received:

```
npm run session-replay -- ~/.claude/projects/<project>/<session>.jsonl --root path/to/project
```

```
api_calls=41 session_input=1830211
tool_results=37 compressed=12
saved_once=18450 saved_cumulative=402377
share_of_session_input=0.220
```

(Illustrative output.) Replay a session recorded *without* Orvix's hooks, against an index of
the code as it was then. The replay runs in a scratch copy of `.orvix/`, so it never disturbs
the session memory of an agent working in the same project. Savings use the 3.5 characters per
token estimate; the session input is the API's own count.

## Reading the output

Both arms print the same shape, one `key=value` record per line:

```
arm=with  tasks=12 succeeded=11 tokens=48213
arm=without tasks=12 succeeded=11 tokens=214877
delta tokens_saved=166664 ratio=0.776 success_delta=0
```

`success_delta` is the one to watch. If it goes negative, the compression is
buying tokens with accuracy, and the guards in `orvix-compress.mjs` are too
loose — that is the signal to tighten `MIN_LINES` or `MAX_RATIO`, or to stop
compressing `Read` by default.
