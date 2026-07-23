# testdata — the Python↔TypeScript verification mechanism

`build/binformat.py` and `worker/src/binformat.ts` implement the same binary
format, and `testdata/gen/reference_router.py` and `worker/src/router.ts`
implement the same routing. Nothing structural forces them to agree. This
directory is what does.

## Layout

```
gen/
  ridge_world.py       synthetic terrain + graph, fully deterministic
  reference_router.py  naive Dijkstra/A*/snap — optimised for being obviously right
  make_golden.py       writes the two artefacts below
ridge_world/
  graph.bin            written by Python, read by TypeScript  (committed)
  expected.json        the answer key                          (committed)
```

Both artefacts are committed on purpose — they are the contract, not build
output. `.gitignore` excludes `build/cache/` and `build/out/`, not this.

## Regenerating

```bash
python -m testdata.gen.make_golden           # rewrite both files
python -m testdata.gen.make_golden --check   # fail if the committed files are stale
```

`tests/test_golden_files.py` runs `--check` in effect, so a change to the
terrain, the format, or the reference router that is not accompanied by
regenerated goldens fails the Python suite immediately — rather than leaving the
TypeScript suite passing against a stale answer key.

## What Ridge World is shaped to catch

A north–south ridge with a pass notched into it, on a lattice with quadratic
spacing jitter, plus three injected fixtures.

| property | why it is there |
|---|---|
| ridge flanks ~18.6 %, pass ~8 % | a `max_slope` filter reroutes instead of merely trimming edges; at 6 % the ridge becomes a wall and routes are genuinely unreachable |
| pass detour vs direct crossing | `climb_factor` 0→200 trades +31 % distance for −37 % ascent, so the α slider changes the *shape* of the answer |
| 1.2 %/km regional tilt | nearly every edge costs differently forwards and backwards — directed cost over undirected topology is exercised graph-wide, not by one contrived edge |
| **bump spur** (`bump_a`→`bump_b`) | two nodes at *exactly* equal elevation joined by an edge that rises and falls 14 m. Endpoint Δh is 0 while ascent is not — any implementation deriving ascent from endpoints reports 0 and fails |
| **island** (3 nodes) | unreachable routes and effort-field truncation, placed *inside* the bbox so it also tests that snapping can legitimately land on a dead component |
| **47 % empty grid cells** | the ring search must expand across holes; a naive 3×3 probe passes in dense terrain and fails exactly at borders and gaps |
| quadratic spacing jitter | a linear jitter like `(i*37) % 11` has only two distinct consecutive differences, so paths tie constantly and a path assertion tests the tie-break rather than the routing |

## Why costs are compared bit-exactly

`expected.json` costs are asserted with `toBe`, not a tolerance. Every quantity
entering a cost is read from `graph.bin` as f32 and widened to f64, so both
languages sum the *same doubles in the same order* along a path. Ties break on
node id in both. A tolerance would let a genuine divergence hide.

The one thing that is not bit-identical is `sin`/`cos`/`asin`, which no standard
requires to be correctly rounded. That is confined to the A* heuristic, where a
last-ulp difference can only reorder expansions, and to snapping, where the
probes are chosen with an unambiguous nearest node.
