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
