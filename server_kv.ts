/// <reference path="./deno_stub.d.ts" />
export {};

/**
 * 五子棋在线对战服务器（Deno Deploy 版，使用 Deno.Kv 全局存储）
 *
 * 为什么用 Deno.Kv：
 *   Deno Deploy 会把不同 WebSocket 连接分配到不同隔离实例，纯内存状态（rooms/matchQueue）
 *   不跨实例共享，导致「快速匹配永远配不上对」「建房后对方加入提示房间不存在」。
 *   本版本把房间状态、匹配队列、定向事件全部存入 Deno.Kv，跨实例共享。
 *
 * 广播机制：
 *   - 对局状态变化：写入 room 状态 key，所有实例通过 kv.watch 感知并广播给本地连接
 *   - 定向事件（悔棋请求/重开请求/聊天等）：写入递增事件 key，目标实例 watch 后转发给本地连接
 *
 * 部署：
 *   1. 打开 https://dash.deno.com
 *   2. 新建项目，入口点填 server_kv.ts
 *   3. 粘贴本文件内容部署，得到域名如 https://xxx.deno.net
 *
 * 协议（WebSocket + JSON，与旧版完全兼容）：
 *   客户端→服务器: hello / create_room / join_room / quick_match / move / undo_req / undo_ack / restart_req / restart_ack / resign / chat
 *   服务器→客户端: hello_ack / room_created / joined / matching / opponent_joined / state(全量广播) / undo_req / undo_rejected / restart_req / restart_rejected / opponent_left / chat / error
 */

const BOARD_SIZE = 15;
const KV = await Deno.openKv();

interface RoomState {
  id: string;
  names: [string, string, string]; // [0] 空, [1] 玩家1, [2] 玩家2；空串=空位
  board: number[];                  // 225
  turn: number;
  history: number[][];              // [r,c][]
  status: "waiting" | "playing" | "over";
  winner: number;
  reason: string;
  last_event: string;
  last_by: number;
  undo_from: number;
}

/** 本实例持有的连接 → 房间/玩家号（每个实例各自维护，用于定向回复和广播） */
const localClients = new Map<WebSocket, { rid: string; pno: number }>();

/* ---------- Kv 工具 ---------- */

function roomKey(rid: string): Deno.KvKey {
  return ["room", rid];
}

async function readRoom(rid: string): Promise<RoomState | null> {
  const res = await KV.get<RoomState>(roomKey(rid));
  return res.value;
}

async function writeRoom(room: RoomState): Promise<boolean> {
  const res = await KV.set(roomKey(room.id), room);
  return res.ok;
}

function newRoom(rid: string, name: string): RoomState {
  return {
    id: rid,
    names: ["", name || "玩家1", ""],
    board: new Array<number>(BOARD_SIZE * BOARD_SIZE).fill(0),
    turn: 1,
    history: [],
    status: "waiting",
    winner: 0,
    reason: "",
    last_event: "create",
    last_by: 0,
    undo_from: 0,
  };
}

function genRoomId(): string {
  let rid = "";
  do {
    rid = String(Math.floor(100000 + Math.random() * 900000));
  } while (false);
  return rid;
}

function stateOf(room: RoomState) {
  return {
    type: "state",
    room: room.id,
    board: room.board,
    turn: room.turn,
    status: room.status,
    winner: room.winner,
    reason: room.reason,
    moves: room.history.length,
    history: room.history,
    last_event: room.last_event,
    last_by: room.last_by,
  };
}

function send(ws: WebSocket, obj: unknown) {
  if (ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(obj)); } catch { /* ignore */ }
  }
}

function err(ws: WebSocket, msg: string) {
  send(ws, { type: "error", msg });
}

function checkWin(board: number[], r: number, c: number, player: number): boolean {
  const dirs = [[0, 1], [1, 0], [1, 1], [1, -1]];
  for (const [dr, dc] of dirs) {
    let cnt = 1;
    for (const s of [1, -1]) {
      let rr = r + dr * s, cc = c + dc * s;
      while (rr >= 0 && rr < BOARD_SIZE && cc >= 0 && cc < BOARD_SIZE && board[rr * BOARD_SIZE + cc] === player) {
        cnt++;
        rr += dr * s; cc += dc * s;
      }
    }
    if (cnt >= 5) return true;
  }
  return false;
}

/** 向本实例内属于该房间的所有连接广播（跨实例的对手由其实例 watch 后广播） */
function broadcastLocal(room: RoomState) {
  for (const [ws, info] of localClients) {
    if (info.rid === room.id && ws.readyState === WebSocket.OPEN) {
      send(ws, stateOf(room));
    }
  }
}

/** 向本实例内该房间的「其他玩家」发送定向事件（from 过滤） */
function sendEventLocal(rid: string, evt: any, from: number) {
  for (const [ws, info] of localClients) {
    if (info.rid === rid && info.pno !== from && ws.readyState === WebSocket.OPEN) {
      send(ws, evt);
    }
  }
}

/* ---------- 定向事件通道（跨实例） ---------- */

async function emitEvent(rid: string, evt: any) {
  const seqRes = await KV.get<number>(["room", rid, "seq"]);
  const n = (seqRes.value ?? 0) + 1;
  await KV.set(["room", rid, "evt", n], evt);
  await KV.set(["room", rid, "seq"], n);
}

/** 本实例为每个有连接的房间维护一个事件 watch：收到事件 → 转发给本地该房间的其他连接 */
const eventWatchers = new Map<string, ReadableStreamDefaultReader<Deno.KvEntry<unknown>[]>>();

async function ensureEventWatch(rid: string) {
  if (eventWatchers.has(rid)) return;
  const stream = await KV.watch([{ prefix: ["room", rid, "evt"] }]);
  const reader = stream.getReader();
  eventWatchers.set(rid, reader);
  void (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const entry of value) {
          const evt = entry.value as any;
          if (!evt || typeof evt !== "object" || !evt.type) continue;
          sendEventLocal(rid, evt, evt.from || 0);
        }
      }
    } catch { /* watcher 失效时忽略 */ }
  })();
}

function releaseEventWatch(rid: string) {
  const reader = eventWatchers.get(rid);
  if (reader) {
    try { reader.cancel(); } catch { /* ignore */ }
    eventWatchers.delete(rid);
  }
}

/* ---------- 房间状态 watch（全量状态广播） ---------- */

const stateReader = (await KV.watch([{ prefix: ["room"] }])).getReader();
void (async () => {
  try {
    while (true) {
      const { done, value } = await stateReader.read();
      if (done) break;
      for (const entry of value) {
        const key = entry.key;
        if (key.length < 2 || key[0] !== "room") continue;
        // 只响应房间状态主 key（["room", rid]），跳过 seq/evt 子 key
        if (key.length !== 2) continue;
        const rid = String(key[1]);
        const room = await readRoom(rid);
        if (!room) continue;
        broadcastLocal(room);
      }
    }
  } catch { /* ignore */ }
})();

/* ---------- 匹配队列（Kv 原子读改写） ---------- */

const QKEY = ["qm", "list"];

async function getQueue(): Promise<{ list: string[]; version: Deno.KvVersionstamp | null }> {
  const res = await KV.get<string[]>(QKEY);
  return { list: res.value ?? [], version: res.versionstamp };
}

/** 取出队首 rid（原子）。队列空返回 null */
async function popQueue(): Promise<string | null> {
  for (let i = 0; i < 8; i++) {
    const { list, version } = await getQueue();
    if (list.length === 0) return null;
    const rid = list[0];
    const next = list.slice(1);
    const op = KV.atomic();
    if (version) op.check({ key: QKEY, versionstamp: version });
    else op.check({ key: QKEY, versionstamp: null });
    const res = await op.set(QKEY, next).commit();
    if (res.ok) return rid;
  }
  return null;
}

/** 入队（原子追加）。 */
async function pushQueue(rid: string): Promise<boolean> {
  for (let i = 0; i < 8; i++) {
    const { list, version } = await getQueue();
    if (list.includes(rid)) return true;
    const next = list.concat(rid);
    const op = KV.atomic();
    if (version) op.check({ key: QKEY, versionstamp: version });
    else op.check({ key: QKEY, versionstamp: null });
    const res = await op.set(QKEY, next).commit();
    if (res.ok) return true;
  }
  return false;
}

/* ---------- 对局逻辑 ---------- */

async function createRoom(ws: WebSocket, name: string) {
  let rid = genRoomId();
  for (let i = 0; i < 10; i++) {
    if (!(await readRoom(rid))) break;
    rid = genRoomId();
  }
  const room = newRoom(rid, name);
  await writeRoom(room);
  localClients.set(ws, { rid, pno: 1 });
  ensureEventWatch(rid);
  send(ws, { type: "room_created", room: rid, player: 1 });
  send(ws, stateOf(room));
}

async function joinRoom(ws: WebSocket, rid: string, name: string): Promise<boolean> {
  const room = await readRoom(rid);
  if (!room) {
    err(ws, "房间不存在");
    return false;
  }
  const occupied = (room.names[1] !== "" ? 1 : 0) + (room.names[2] !== "" ? 1 : 0);
  if (room.status === "playing" && occupied >= 2) {
    err(ws, "房间已满");
    return false;
  }
  const pno = room.names[1] === "" ? 1 : 2;
  room.names[pno] = name || `玩家${pno}`;
  if (pno === 1) {
    room.status = "waiting";
  } else {
    room.status = "playing";
    room.turn = 1;
    room.last_event = "join";
    room.last_by = 0;
  }
  await writeRoom(room);
  localClients.set(ws, { rid, pno });
  ensureEventWatch(rid);
  send(ws, {
    type: "joined",
    room: rid,
    player: pno,
    opponent: room.names[pno === 1 ? 2 : 1] || "",
  });
  if (pno === 2) {
    // 通知房主：对手已加入（走事件通道，跨实例可靠）
    await emitEvent(rid, { type: "opponent_joined", from: 2, opponent: room.names[2] });
  }
  broadcastLocal(room);
  return true;
}

async function quickMatch(ws: WebSocket, name: string) {
  // 先尝试从队列取一个房间加入
  const rid = await popQueue();
  if (rid) {
    const ok = await joinRoom(ws, rid, name);
    if (ok) return;
  }
  // 无人等待：自己创建房间并入队
  let myRid = genRoomId();
  for (let i = 0; i < 10; i++) {
    if (!(await readRoom(myRid))) break;
    myRid = genRoomId();
  }
  const room = newRoom(myRid, name);
  await writeRoom(room);
  await pushQueue(myRid);
  localClients.set(ws, { rid: myRid, pno: 1 });
  ensureEventWatch(myRid);
  send(ws, { type: "matching", msg: "正在匹配对手..." });
  send(ws, { type: "room_created", room: myRid, player: 1 }); // 兼容客户端：首个匹配者即房主
  send(ws, stateOf(room));
}

async function handleGame(ws: WebSocket, msg: any) {
  const info = localClients.get(ws);
  if (!info) return;
  const room = await readRoom(info.rid);
  if (!room) return;
  const pno = info.pno;
  const t = msg.type;

  switch (t) {
    case "move": {
      if (room.status !== "playing") return err(ws, "对局未在进行中");
      if (pno !== room.turn) return err(ws, "还没轮到你");
      const r = msg.r, c = msg.c;
      if (!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || r >= BOARD_SIZE || c < 0 || c >= BOARD_SIZE)
        return err(ws, "落子位置不合法");
      if (room.board[r * BOARD_SIZE + c] !== 0) return err(ws, "该位置已有棋子");
      room.board[r * BOARD_SIZE + c] = pno;
      room.history.push([r, c]);
      room.last_event = "move";
      room.last_by = pno;
      if (checkWin(room.board, r, c, pno)) {
        room.status = "over";
        room.winner = pno;
        room.reason = "five";
      } else if (room.history.length === BOARD_SIZE * BOARD_SIZE) {
        room.status = "over";
        room.winner = 0;
        room.reason = "draw";
      } else {
        room.turn = room.turn === 1 ? 2 : 1;
      }
      await writeRoom(room);
      broadcastLocal(room);
      break;
    }
    case "undo_req": {
      if (room.status !== "playing" || room.history.length === 0) return err(ws, "当前无法悔棋");
      room.undo_from = pno;
      await writeRoom(room);
      await emitEvent(ridOf(info.rid), { type: "undo_req", from: pno });
      break;
    }
    case "undo_ack": {
      if (msg.accept && room.history.length > 0) {
        const last = room.history.pop()!;
        room.board[last[0] * BOARD_SIZE + last[1]] = 0;
        room.turn = room.undo_from;
        room.last_event = "undo";
        room.last_by = room.undo_from;
        await writeRoom(room);
        broadcastLocal(room);
      } else {
        await emitEvent(ridOf(info.rid), { type: "undo_rejected", from: pno });
      }
      break;
    }
    case "resign": {
      if (room.status !== "playing") return;
      room.status = "over";
      room.winner = pno === 1 ? 2 : 1;
      room.reason = "resign";
      room.last_event = "resign";
      room.last_by = pno;
      await writeRoom(room);
      broadcastLocal(room);
      break;
    }
    case "restart_req": {
      if (room.status !== "over") return err(ws, "对局结束后才能重开");
      await emitEvent(ridOf(info.rid), { type: "restart_req", from: pno });
      break;
    }
    case "restart_ack": {
      if (msg.accept) {
        room.board = new Array<number>(BOARD_SIZE * BOARD_SIZE).fill(0);
        room.turn = 1;
        room.history = [];
        room.status = "playing";
        room.winner = 0;
        room.reason = "";
        room.last_event = "restart";
        room.last_by = 0;
        room.undo_from = 0;
        await writeRoom(room);
        broadcastLocal(room);
      } else {
        await emitEvent(ridOf(info.rid), { type: "restart_rejected", from: pno });
      }
      break;
    }
    case "chat": {
      const text = String(msg.text ?? "").slice(0, 200);
      await emitEvent(ridOf(info.rid), { type: "chat", from: pno, text });
      break;
    }
  }
}

function ridOf(rid: string): string {
  return rid;
}

async function removeClient(ws: WebSocket) {
  const info = localClients.get(ws);
  if (!info) return;
  localClients.delete(ws);
  const room = await readRoom(info.rid);
  if (!room) return;
  room.names[info.pno] = "";
  // 房间空了就清理
  const anyPlayer = room.names[1] !== "" || room.names[2] !== "";
  if (!anyPlayer) {
    await KV.delete(roomKey(info.rid));
    releaseEventWatch(info.rid);
    return;
  }
  await writeRoom(room);
  await emitEvent(info.rid, { type: "opponent_left", from: info.pno, player: info.pno });
  // 若本实例内没有该房间连接了，释放事件 watch
  let hasLocal = false;
  for (const [, i] of localClients) {
    if (i.rid === info.rid) { hasLocal = true; break; }
  }
  if (!hasLocal) releaseEventWatch(info.rid);
}

/* ---------- 入口 ---------- */

Deno.serve({ port: 8080 }, (req) => {
  if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Gomoku Online Server (Deno Kv). Connect via WebSocket.", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  const { socket, response } = Deno.upgradeWebSocket(req);
  let name = "";
  socket.onmessage = (ev) => {
    let msg: any;
    try { msg = JSON.parse(String(ev.data)); } catch {
      send(socket, { type: "error", msg: "消息格式错误" });
      return;
    }
    switch (msg.type) {
      case "hello":
        name = String(msg.name ?? "").slice(0, 20);
        send(socket, { type: "hello_ack" });
        break;
      case "create_room":
        void createRoom(socket, name);
        break;
      case "join_room":
        void joinRoom(socket, String(msg.room ?? ""), name);
        break;
      case "quick_match":
        void quickMatch(socket, name || `玩家${Math.floor(100 + Math.random() * 900)}`);
        break;
      default:
        void handleGame(socket, msg);
    }
  };
  socket.onclose = () => void removeClient(socket);
  socket.onerror = () => void removeClient(socket);
  return response;
});

console.log("五子棋在线对战服务器(Kv版)已启动");
