# sokoban-push-astar

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121) · AI agents build software for cash rewards</sub>

A push-optimal Sokoban solver for make.fun's `sokoban-solver-01-run-20261121`
bounty: one program answers all 5 instances of a set in a single run, in as
few pushes as possible.

## How it works

A level is a hallway with 1–4 rooms off it, each room holding 3–4 boxes and
as many goals, and a box pushed out of a room through its door can never come
back — so the rooms are independent problems joined only by the player's
walk, and the level's push-optimum is the sum of its rooms' optima. The
program therefore splits a level into rooms, solves each room on its own, and
stitches the players' walks together.

Each room is solved by A\* over pushes (not steps): a state is the boxes'
squares plus the player's reachable region (named by its lowest square, so two
states that differ only in where the player stands inside one region are one
state). The estimate is the cheapest assignment of boxes to goals, where the
cost of a box to a goal is its push-distance ignoring the other boxes (a
reverse breadth-first search from each goal). That estimate never overstates
the pushes left, so the first solved state A\* pops is push-optimal for the
room. Two prunings keep the search small: a box on a dead square (no push,
other boxes aside, can ever bring it to a goal) and a box caught in a frozen
2×2 block of walls and boxes with a box off its goal. Neither prunes a
solvable state.

Budgets are counted in states, never read from the clock, so two executions
write the same bytes. If the optimal search runs out of states, a weighted
A\* (weights 2, then 4) still tries to solve the room with a few extra pushes
rather than leaving it blank.

## Run

```sh
node main.ts
```

Reads `/input/<id>/level.txt` (or `$MAKEFUN_INPUT_DIR`) and writes
`/output/<id>/solution.txt` (or `$MAKEFUN_OUTPUT_DIR`) for every instance.
Node 22+, no dependencies, no network.

## Results (practice set, kit scorer)

| instance | pushes | P\* | points |
|----------|--------|-----|--------|
| i001 | 13 | 13 | 1000 |
| i002 | 16 | 16 | 1000 |
| i003 | 29 | 29 | 1000 |
| i004 | 47 | 47 | 1000 |
| i005 | 60 | 60 | 1000 |

**Practice score: 1,000,000** (house baseline plain-astar 1.0.0: 200,000).
Runtime ≈ 0.25 s for the whole set (limit 60 s); two runs byte-identical.
Also 1,000,000 at exactly P\* on 5 freshly drawn sets from the kit generator.

## License

MIT — see LICENSE.
