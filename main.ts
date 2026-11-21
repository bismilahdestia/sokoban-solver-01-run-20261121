// sokoban-push-astar: a push-optimal Sokoban solver, written from scratch for
// make.fun's sokoban-solver-01-run-20261121 (MIT, LICENSE beside this file).
//
// Idea. A level is a hallway with 1-4 rooms off it, each room holding 3-4 boxes
// and as many goals, and a box pushed out of a room through its door can never
// come back, so the rooms are independent problems joined only by the player's
// walk: the level's push-optimum is the sum of its rooms' optima. This program
// therefore splits a level into rooms, solves each room on its own, and stitches
// the players' walks together.
//
// Each room is solved by A* over pushes (not steps): a state is the boxes'
// squares plus the player's reachable region (named by its lowest square, so
// two states that differ only in where the player stands inside one region are
// one state). The estimate is the cheapest assignment of boxes to goals, where
// the cost of a box to a goal is its push-distance ignoring the other boxes
// (a reverse breadth-first search from each goal). That estimate never
// overstates the pushes left, so the first solved state A* pops is push-optimal
// for the room. Two prunings keep the search small: a box on a dead square (no
// push, other boxes aside, can ever bring it to a goal) and a box caught in a
// frozen 2x2 block of walls and boxes with a box off its goal. Neither prunes a
// solvable state.
//
// Budgets are counted in states, never read from the clock, so two executions
// write the same bytes. If the optimal search runs out of states, a weighted
// A* (weights 2, then 4) still tries to solve the room with a few extra pushes
// rather than leaving it blank. If a room cannot be solved at all, the level
// gets an empty answer (0 points) and the run moves on to the next instance.
//
// Local run: mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Work budgets, in states created: the run never reads the clock, so both
// graded executions behave alike. A room's optimal search gets the large cap;
// the weighted fallbacks get the small one; the whole run gets the global one.
const ROOM_STATE_CAP = 250_000;
const FALLBACK_STATE_CAP = 150_000;
const GLOBAL_STATE_CAP = 1_500_000;

const DX = [0, 0, -1, 1];
const DY = [-1, 1, 0, 0];
const LETTER = ['u', 'd', 'l', 'r'];
const PUSH_LETTER = ['U', 'D', 'L', 'R'];

interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

interface Room {
  squares: number[];
  boxes: number[];
  goals: number[];
}

interface SearchResult {
  pushes: number;
  moves: string;
  endPlayer: number;
}

/** Every assignment of up to four boxes to goals, as permutations of goal indexes. */
const PERMS: number[][][] = [[], [], [], [], []];
for (let n = 1; n <= 4; n++) {
  const arr = Array.from({ length: n }, (_, i) => i);
  const out: number[][] = [];
  const gen = (k: number): void => {
    if (k === n) {
      out.push(arr.slice());
      return;
    }
    for (let i = k; i < n; i++) {
      const t = arr[k]!;
      arr[k] = arr[i]!;
      arr[i] = t;
      gen(k + 1);
      const u = arr[k]!;
      arr[k] = arr[i]!;
      arr[i] = u;
    }
  };
  gen(0);
  PERMS[n] = out;
}

/** A level in XSB text: its width and height, walls, goals, boxes and player. */
function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  // The outermost frame is wall whatever it shows: nothing leaves the board,
  // and no neighbour lookup below ever wraps a row.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  return { w, h, wall, goals, boxes: boxes.sort((a, b) => a - b), player };
}

/**
 * For each goal, the fewest pushes that bring one box alone (the other boxes
 * aside) from every square to that goal, -1 where no push can. A push moves a
 * box from y to x = y + d when the player can stand at y - d, so walking the
 * search backwards from a goal, a square y reaches x when y and y - d are open.
 */
function pushDistances(wall: Uint8Array, w: number, goals: number[]): Int32Array[] {
  const size = wall.length;
  const out: Int32Array[] = [];
  for (const g of goals) {
    const dist = new Int32Array(size).fill(-1);
    dist[g] = 0;
    const queue = [g];
    for (let qi = 0; qi < queue.length; qi++) {
      const x = queue[qi]!;
      for (let d = 0; d < 4; d++) {
        const y = x - DY[d]! * w - DX[d]!;
        const behind = y - DY[d]! * w - DX[d]!;
        if (wall[y] || wall[behind] || dist[y] >= 0) continue;
        dist[y] = dist[x]! + 1;
        queue.push(y);
      }
    }
    out.push(dist);
  }
  return out;
}

/**
 * The level's rooms: cut the player's row (the hallway) where a box there can
 * reach no goal, and each part of floor left that holds a box is a room. Null
 * when the level is no set of rooms (a box in the hallway, a goal cut off, or
 * a part whose boxes and goals do not match).
 */
function roomsOf(level: Level): Room[] | null {
  const { w, h, wall, goals, boxes, player } = level;
  const dists = pushDistances(wall, w, goals);
  const live = new Uint8Array(w * h);
  for (let s = 0; s < w * h; s++) {
    for (const d of dists) {
      if (d[s] >= 0) {
        live[s] = 1;
        break;
      }
    }
  }
  const row = Math.floor(player / w);
  const cut = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    const i = row * w + x;
    if (!wall[i] && !live[i]) cut[i] = 1;
  }
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(w * h).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < w * h; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      const p = squares[i]!;
      for (let d = 0; d < 4; d++) {
        const q = p + DY[d]! * w + DX[d]!;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [] });
  }
  for (const b of boxes) {
    if (part[b] < 0) return null;
    rooms[part[b]]!.boxes.push(b);
  }
  for (const g of goals) {
    if (part[g] < 0) return null;
    rooms[part[g]]!.goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/** Whether the box just pushed to `t` sits in a frozen 2x2 block. */
function frozenAt(wall: Uint8Array, w: number, occ: Uint8Array, goalMask: Uint8Array, t: number): boolean {
  // The four 2x2 blocks holding t, each named by its top-left square. A box in
  // such a block can move in no direction: along each axis either the square
  // ahead or the square the player must stand on is in the block, a wall or a
  // box. So a block of walls and boxes with a box off its goal is dead.
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    if (a < 0 || (a % w) >= w - 1) continue;
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!((wall[a] || occ[a]) && (wall[b] || occ[b]) && (wall[c] || occ[c]) && (wall[d] || occ[d]))) continue;
    if ((occ[a] && !goalMask[a]) || (occ[b] && !goalMask[b]) || (occ[c] && !goalMask[c]) || (occ[d] && !goalMask[d])) return true;
  }
  return false;
}

/** The squares the player reaches from `from` around walls and boxes, and the lowest of them. */
function regionLow(
  seen: Int32Array,
  stamp: number,
  wall: Uint8Array,
  occ: Uint8Array,
  from: number,
  stack: Int32Array,
  w: number,
): number {
  let n = 0;
  let low = from;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n]!;
    if (p < low) low = p;
    for (let d = 0; d < 4; d++) {
      const q = p + DY[d]! * w + DX[d]!;
      if (!wall[q] && !occ[q] && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

/** The shortest walk from `from` to `to` around walls and boxes, in lower LURD letters. */
function walkTo(wall: Uint8Array, w: number, occ: Uint8Array, from: number, to: number): string {
  if (from === to) return '';
  const size = wall.length;
  const prev = new Int32Array(size).fill(-1);
  const how = new Int8Array(size).fill(-1);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (let d = 0; d < 4; d++) {
      const q = p + DY[d]! * w + DX[d]!;
      if (wall[q] || occ[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = d;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: the push square is out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = LETTER[how[p]!]! + s;
  return s;
}

/** A binary heap on [estimate, pushes, sequence, state], smallest first. */
type HeapEntry = [number, number, number, number];
function heapLess(a: HeapEntry, b: HeapEntry): boolean {
  return (
    a[0] < b[0] ||
    (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] < b[2])))
  );
}
function heapPush(heap: HeapEntry[], e: HeapEntry): void {
  let i = heap.length;
  heap.push(e);
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (!heapLess(heap[i]!, heap[p]!)) break;
    const t = heap[i]!;
    heap[i] = heap[p]!;
    heap[p] = t;
    i = p;
  }
}
function heapPop(heap: HeapEntry[]): HeapEntry {
  const top = heap[0]!;
  const last = heap.pop()!;
  if (heap.length > 0) {
    heap[0] = last;
    for (let i = 0; ; ) {
      let c = 2 * i + 1;
      if (c >= heap.length) break;
      if (c + 1 < heap.length && heapLess(heap[c + 1]!, heap[c]!)) c++;
      if (!heapLess(heap[c]!, heap[i]!)) break;
      const t = heap[i]!;
      heap[i] = heap[c]!;
      heap[c] = t;
      i = c;
    }
  }
  return top;
}

/**
 * One push-search over a board: walls, goals, boxes and the player's square.
 * Weight 1 is plain A* and so push-optimal; a larger weight trades pushes for
 * speed. Returns the solution, or null with a reason: 'cap' when a state
 * budget ran out, 'dead' when no solution exists under the prunings.
 */
function astar(
  wall: Uint8Array,
  w: number,
  h: number,
  goals: number[],
  boxes0: number[],
  player0: number,
  weight: number,
  cap: number,
  budget: { used: number },
): { status: 'solved'; result: SearchResult } | { status: 'cap' | 'dead' } {
  const size = w * h;
  const n = boxes0.length;
  const goalMask = new Uint8Array(size);
  for (const g of goals) goalMask[g] = 1;
  const dists = pushDistances(wall, w, goals);
  const live = new Uint8Array(size);
  for (let s = 0; s < size; s++) {
    for (let gi = 0; gi < n; gi++) {
      if (dists[gi]![s] >= 0) {
        live[s] = 1;
        break;
      }
    }
  }
  for (const b of boxes0) if (!live[b]) return { status: 'dead' };
  const solved = (bs: number[]): boolean => bs.every((b) => goalMask[b]);
  if (solved(boxes0)) return { status: 'solved', result: { pushes: 0, moves: '', endPlayer: player0 } };

  const occ = new Uint8Array(size);
  for (const b of boxes0) occ[b] = 1;
  for (const b of boxes0) if (frozenAt(wall, w, occ, goalMask, b)) return { status: 'dead' };
  for (const b of boxes0) occ[b] = 0;

  // The cheapest assignment of boxes to goals at their push-distances. With
  // more than four boxes, the sum of each box's nearest goal instead: weaker,
  // but still never over the pushes left.
  const heuristic = (bs: number[]): number => {
    if (n <= 4) {
      let best = Infinity;
      for (const perm of PERMS[n]!) {
        let s = 0;
        for (let i = 0; i < n; i++) {
          const d = dists[perm[i]!]![bs[i]!]!;
          if (d < 0) {
            s = Infinity;
            break;
          }
          s += d;
        }
        if (s < best) best = s;
      }
      return best;
    }
    let s = 0;
    for (const b of bs) {
      let m = Infinity;
      for (let gi = 0; gi < n; gi++) {
        const d = dists[gi]![b]!;
        if (d >= 0 && d < m) m = d;
      }
      if (m === Infinity) return Infinity;
      s += m;
    }
    return s;
  };

  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  const keyOf = (bs: number[], low: number): string => `${low}|${bs.join(',')}`;

  const sBoxes: number[][] = [boxes0.slice()];
  const sPlayer: number[] = [player0];
  const sG: number[] = [0];
  const sParent: number[] = [-1];
  const sFrom: number[] = [-1];
  const sTo: number[] = [-1];
  const sDir: number[] = [-1];
  const sLow: number[] = [];
  const sKey: string[] = [];
  const best = new Map<string, number>();
  for (const b of boxes0) occ[b] = 1;
  sLow[0] = regionLow(seen, ++stamp, wall, occ, player0, stack, w);
  for (const b of boxes0) occ[b] = 0;
  sKey[0] = keyOf(boxes0, sLow[0]!);
  best.set(sKey[0]!, 0);
  const h0 = heuristic(boxes0);
  if (h0 === Infinity) return { status: 'dead' };
  let seq = 0;
  const heap: HeapEntry[] = [];
  heapPush(heap, [h0, 0, seq++, 0]);
  budget.used++;
  let created = 1;

  while (heap.length > 0) {
    const [, g, , s] = heapPop(heap);
    if (g !== sG[s] || best.get(sKey[s]!) !== g) continue;
    const bs = sBoxes[s]!;
    if (solved(bs)) {
      // Walk the pushes back to the start, then play them forward.
      const path: number[] = [];
      for (let t = s; t > 0; t = sParent[t]!) path.push(t);
      path.reverse();
      let player = player0;
      let boxes = boxes0.slice();
      let moves = '';
      for (const t of path) {
        const from = sFrom[t]!;
        const to = sTo[t]!;
        const d = sDir[t]!;
        for (const b of boxes) occ[b] = 1;
        moves += walkTo(wall, w, occ, player, from - DY[d]! * w - DX[d]!);
        for (const b of boxes) occ[b] = 0;
        moves += PUSH_LETTER[d]!;
        player = from;
        const i = boxes.indexOf(from);
        boxes[i] = to;
        boxes.sort((a, b) => a - b);
      }
      return { status: 'solved', result: { pushes: path.length, moves, endPlayer: player } };
    }
    if (created >= cap || budget.used >= GLOBAL_STATE_CAP) return { status: 'cap' };
    for (const b of bs) occ[b] = 1;
    // The player's region from here: which squares it can stand on to push.
    regionLow(seen, ++stamp, wall, occ, sPlayer[s]!, stack, w);
    const here = stamp;
    for (let bi = 0; bi < n; bi++) {
      const b = bs[bi]!;
      for (let d = 0; d < 4; d++) {
        const t = b + DY[d]! * w + DX[d]!;
        if (wall[t] || occ[t] || !live[t]) continue;
        const behind = b - DY[d]! * w - DX[d]!;
        if (seen[behind] !== here) continue;
        const nb = bs.slice();
        nb[bi] = t;
        nb.sort((a, b2) => a - b2);
        occ[b] = 0;
        occ[t] = 1;
        const frozen = frozenAt(wall, w, occ, goalMask, t);
        let low2 = -1;
        if (!frozen) low2 = regionLow(mark, ++stamp, wall, occ, b, stack, w);
        occ[t] = 0;
        occ[b] = 1;
        if (frozen) continue;
        const hh = heuristic(nb);
        if (hh === Infinity) continue;
        const key = keyOf(nb, low2);
        const g2 = g + 1;
        const prev = best.get(key);
        if (prev !== undefined && prev <= g2) continue;
        if (created >= cap || budget.used >= GLOBAL_STATE_CAP) return { status: 'cap' };
        best.set(key, g2);
        const idx = sBoxes.length;
        sBoxes.push(nb);
        sPlayer.push(b);
        sG.push(g2);
        sParent.push(s);
        sFrom.push(b);
        sTo.push(t);
        sDir.push(d);
        sLow.push(low2);
        sKey.push(key);
        heapPush(heap, [g2 + weight * hh, g2, seq++, idx]);
        created++;
        budget.used++;
      }
    }
    for (const b of bs) occ[b] = 0;
  }
  return { status: 'dead' };
}

/** A room's push-optimal solution if one fits the budgets, else a weighted try. */
function solveSub(
  wall: Uint8Array,
  w: number,
  h: number,
  goals: number[],
  boxes: number[],
  player: number,
  budget: { used: number },
): SearchResult | null {
  for (const weight of [1, 2, 4]) {
    const cap = weight === 1 ? ROOM_STATE_CAP : FALLBACK_STATE_CAP;
    const r = astar(wall, w, h, goals, boxes, player, weight, cap, budget);
    if (r.status === 'solved') return r.result;
    if (r.status === 'dead') return null;
    if (budget.used >= GLOBAL_STATE_CAP) return null;
  }
  return null;
}

/** The player's moves for one level, or '' when a room will not solve. */
function solveLevel(text: string, budget: { used: number }): string {
  const level = parseLevel(text);
  if (level.boxes.length === 0) return '';
  const rooms = roomsOf(level);
  if (rooms === null || rooms.length === 0) {
    const r = solveSub(level.wall, level.w, level.h, level.goals, level.boxes, level.player, budget);
    return r ? r.moves : '';
  }
  let player = level.player;
  let moves = '';
  const done = new Set<Room>();
  for (const room of rooms) {
    // The other rooms' boxes stand as walls (on their goals once done); the
    // player walks on from where the last room left it.
    const wall2 = level.wall.slice();
    for (const other of rooms) {
      if (other === room) continue;
      const src = done.has(other) ? other.goals : other.boxes;
      for (const b of src) wall2[b] = 1;
    }
    const r = solveSub(wall2, level.w, level.h, room.goals, room.boxes, player, budget);
    if (!r) return '';
    moves += r.moves;
    player = r.endPlayer;
    done.add(room);
  }
  return moves;
}

const budget = { used: 0 };
for (const id of readdirSync(INPUT_DIR).sort()) {
  const moves = solveLevel(readFileSync(join(INPUT_DIR, id, 'level.txt'), 'utf8'), budget);
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'solution.txt'), `${moves}\n`);
}
