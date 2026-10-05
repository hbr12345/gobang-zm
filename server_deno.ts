/**
 * 五子棋在线对战服务器 (Deno 版)
 * 本地运行:  deno run --allow-net --allow-read server_deno.ts
 * 部署到 Deno Deploy: 直接把本文件作为入口部署即可
 * 协议与 Python 版(gobang_server.py)完全一致, 客户端可无缝切换
 */
const BOARD_SIZE = 15;

interface Room {
  id: string;
  players: (WebSocket | null)[]; // index 1/2
  names: string[];
  board: number[][];
  turn: number;
  history: [number, number][];
  status: "waiting" | "playing" | "over";
  winner: number;
  reason: string;
  last_event: string;
  last_by: number;
  undo_from: number;
}

const rooms = new Map<string, Room>();
const matchQueue: WebSocket[] = [];
const clients = new Map<WebSocket, { rid: string; pno: number }>();

function newBoard(): number[][] {
  return Array.from({ length: BOARD_SIZE }, () => new Array(BOARD_SIZE).fill(0));
}

function checkWin(board: number[][], r: number, c: number, player: number): boolean {
  for (const [dr, dc] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
    let cnt = 1;
    for (const s of [1, -1]) {
      let rr = r + dr * s, cc = c + dc * s;
      while (rr >= 0 && rr < BOARD_SIZE && cc >= 0 && cc < BOARD_SIZE && board[rr][cc] === player) {
        cnt++;
        rr += dr * s;
        cc += dc * s;
      }
    }
    if (cnt >= 5) return true;
  }
  return false;
}

function stateOf(room: Room) {
  return {
    type: "state",
    room: room.id,
    board: room.board.flat(),
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

function broadcast(room: Room, msg: unknown) {
  const payload = JSON.stringify(msg);
  for (const ws of room.players) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(payload); } catch { /* ignore */ }
    }
  }
}

function genRoomId(): string {
  let rid = "";
  do { rid = String(Math.floor(100000 + Math.random() * 900000)); } while (rooms.has(rid));
  return rid;
}

function resetRoom(room: Room) {
  room.board = newBoard();
  room.turn = 1;
  room.history = [];
  room.status = "playing";
  room.winner = 0;
  room.reason = "";
  room.last_event = "restart";
  room.last_by = 0;
  room.undo_from = 0;
}

function removeClient(ws: WebSocket) {
  const info = clients.get(ws);
  if (!info) return;
  clients.delete(ws);
  const room = rooms.get(info.rid);
  if (!room) return;
  room.players[info.pno] = null;
  broadcast(room, { type: "opponent_left", player: info.pno });
  if (!room.players.some((w) => w && w.readyState === WebSocket.OPEN)) {
    rooms.delete(info.rid);
  }
}

async function joinRoom(ws: WebSocket, rid: string, name: string): Promise<boolean> {
  const room = rooms.get(rid);
  if (!room) {
    ws.send(JSON.stringify({ type: "error", msg: "房间不存在" }));
    return false;
  }
  const occupied = room.players.filter((w) => w && w.readyState === WebSocket.OPEN).length;
  if (room.status === "playing" && occupied >= 2) {
    ws.send(JSON.stringify({ type: "error", msg: "房间已满" }));
    return false;
  }
  const pno = room.players[1] ? 2 : 1;
  room.players[pno] = ws;
  room.names[pno] = name || `玩家${pno}`;
  clients.set(ws, { rid, pno });
  ws.send(JSON.stringify({
    type: "joined",
    room: rid,
    player: pno,
    opponent: room.names[pno === 1 ? 2 : 1] || "",
  }));
  if (pno === 1) {
    room.status = "waiting";
  } else {
    room.status = "playing";
    room.turn = 1;
    room.last_event = "join";
    room.last_by = 0;
    // 通知房主: 对手已加入(opponent 为新加入玩家的名字)
    const host = room.players[1];
    if (host && host.readyState === WebSocket.OPEN) {
      host.send(JSON.stringify({ type: "opponent_joined", opponent: room.names[2] }));
    }
  }
  broadcast(room, stateOf(room));
  return true;
}

function handleMessage(ws: WebSocket, msg: any) {
  const info = clients.get(ws);
  const room = info ? rooms.get(info.rid) : undefined;
  const pno = info?.pno ?? 0;
  if (!room || !info) return;
  const t = msg.type;

  switch (t) {
    case "move": {
      if (room.status !== "playing") return err(ws, "对局未在进行中");
      if (pno !== room.turn) return err(ws, "还没轮到你");
      const r = msg.r, c = msg.c;
      if (!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || r >= BOARD_SIZE || c < 0 || c >= BOARD_SIZE)
        return err(ws, "落子位置不合法");
      if (room.board[r][c] !== 0) return err(ws, "该位置已有棋子");
      room.board[r][c] = pno;
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
      broadcast(room, stateOf(room));
      break;
    }
    case "undo_req": {
      if (room.status !== "playing" || room.history.length === 0) return err(ws, "当前无法悔棋");
      room.undo_from = pno;
      broadcast(room, { type: "undo_req", from: pno });
      break;
    }
    case "undo_ack": {
      if (msg.accept && room.history.length > 0) {
        const [r, c] = room.history.pop()!;
        room.board[r][c] = 0;
        room.turn = room.undo_from; // 撤销后轮到请求方
        room.last_event = "undo";
        room.last_by = room.undo_from;
        broadcast(room, stateOf(room));
      } else {
        broadcast(room, { type: "undo_rejected", from: pno });
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
      broadcast(room, stateOf(room));
      break;
    }
    case "restart_req": {
      if (room.status !== "over") return err(ws, "对局结束后才能重开");
      broadcast(room, { type: "restart_req", from: pno });
      break;
    }
    case "restart_ack": {
      if (msg.accept) {
        resetRoom(room);
        broadcast(room, stateOf(room));
      } else {
        broadcast(room, { type: "restart_rejected", from: pno });
      }
      break;
    }
    case "chat": {
      broadcast(room, { type: "chat", from: pno, text: String(msg.text ?? "").slice(0, 200) });
      break;
    }
  }
}

function err(ws: WebSocket, msg: string) {
  ws.send(JSON.stringify({ type: "error", msg }));
}

Deno.serve({ port: 8080 }, (req) => {
  if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Gomoku Online Server (Deno). Connect via WebSocket.", { headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  const { socket, response } = Deno.upgradeWebSocket(req);
  let name = "";
  socket.onmessage = (ev) => {
    let msg: any;
    try { msg = JSON.parse(String(ev.data)); } catch { socket.send(JSON.stringify({ type: "error", msg: "消息格式错误" })); return; }
    switch (msg.type) {
      case "hello":
        name = String(msg.name ?? "").slice(0, 20);
        socket.send(JSON.stringify({ type: "hello_ack" }));
        break;
      case "create_room": {
        const rid = genRoomId();
        const room: Room = {
          id: rid, players: [null, null, null], names: ["", name || "玩家1", ""],
          board: newBoard(), turn: 1, history: [], status: "waiting",
          winner: 0, reason: "", last_event: "", last_by: 0, undo_from: 0,
        };
        room.players[1] = socket;
        rooms.set(rid, room);
        clients.set(socket, { rid, pno: 1 });
        socket.send(JSON.stringify({ type: "room_created", room: rid, player: 1 }));
        socket.send(JSON.stringify(stateOf(room)));
        break;
      }
      case "join_room": {
        const rid = String(msg.room ?? "");
        if (!/^\d{6}$/.test(rid)) {
          socket.send(JSON.stringify({ type: "error", msg: "房间号应为6位数字" }));
          break;
        }
        joinRoom(socket, rid, name);
        break;
      }
      case "quick_match": {
        name = name || `玩家${Math.floor(100 + Math.random() * 900)}`;
        if (matchQueue.length > 0) {
          const other = matchQueue.shift()!;
          // other 入队时已创建房间, 直接加入
          if (other.readyState === WebSocket.OPEN && clients.has(other)) {
            const oi = clients.get(other)!;
            joinRoom(socket, oi.rid, name);
          } else {
            matchQueue.push(socket);
            socket.send(JSON.stringify({ type: "matching", msg: "正在匹配对手..." }));
          }
        } else {
          // 入队并创建房间, 等第二个匹配者加入
          const rid = genRoomId();
          const room: Room = {
            id: rid, players: [null, null, null], names: ["", name, ""],
            board: newBoard(), turn: 1, history: [], status: "waiting",
            winner: 0, reason: "", last_event: "", last_by: 0, undo_from: 0,
          };
          room.players[1] = socket;
          rooms.set(rid, room);
          clients.set(socket, { rid, pno: 1 });
          matchQueue.push(socket);
          socket.send(JSON.stringify({ type: "matching", msg: "正在匹配对手..." }));
          socket.send(JSON.stringify(stateOf(room)));
        }
        break;
      }
      default:
        handleMessage(socket, msg);
    }
  };
  socket.onclose = () => removeClient(socket);
  socket.onerror = () => removeClient(socket);
  return response;
});

console.log("五子棋在线对战服务器(Deno)已启动: ws://localhost:8080");
