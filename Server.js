// ============================================================
// Socket.IO Game Server — Full Featured — for Unreal Engine 4
// ============================================================
// Covers: rooms, usernames, movement, stance, montages (anims),
// weapon fire, item/weapon switching, aiming, health sync,
// NPC sync, chat, room browser/creation.
// ============================================================

const { Server } = require("socket.io");
const { createServer } = require("http");

const httpServer = createServer();
const io = new Server(httpServer, {
  cors: {
    origin: "*", // restrict in production
  },
});

// ------------------------------------------------------------
// In-memory state
// ------------------------------------------------------------
// players[socketId] = {
//   name, room, x, y, z, rotation,
//   stance, hp, currentWeapon, isAiming
// }
let players = {};

// npcs[room][npcId] = { type, x, y, z, rotation, hp }
let npcs = {};

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------
function getPlayersInRoom(room) {
  const result = {};
  for (const id in players) {
    if (players[id].room === room) result[id] = players[id];
  }
  return result;
}

function getNpcsInRoom(room) {
  return npcs[room] || {};
}

function ensureRoomNpcStore(room) {
  if (!npcs[room]) npcs[room] = {};
}

function clearRoomIfEmpty(room) {
  const stillHasPlayers = Object.values(players).some((p) => p.room === room);
  if (!stillHasPlayers && npcs[room]) {
    delete npcs[room];
    console.log(`[cleanup] room "${room}" emptied — NPCs cleared`);
  }
}

io.on("connection", (socket) => {
  console.log(`[connect] ${socket.id}`);

  // Uncomment for verbose debugging of every event received:
  // socket.onAny((eventName, ...args) => console.log(`[received] "${eventName}"`, args));

  // ----------------------------------------------------------
  // JOIN
  // data: { name, room (optional, defaults to "lobby") }
  // ----------------------------------------------------------
  socket.on("playerJoin", (data) => {
    const room = data?.room || "lobby";

    players[socket.id] = {
      name: data?.name || `Player_${socket.id.substring(0, 4)}`,
      room,
      x: 0,
      y: 0,
      z: 0,
      rotation: 0,
      stance: "standing",   // standing | crouching | prone
      hp: 100,
      currentWeapon: "none",
      isAiming: false,
    };

    ensureRoomNpcStore(room);
    socket.join(room);

    socket.emit("init", {
      id: socket.id,
      players: getPlayersInRoom(room),
      npcs: getNpcsInRoom(room),
    });

    socket.to(room).emit("playerJoined", {
      id: socket.id,
      ...players[socket.id],
    });

    console.log(`[join] ${socket.id} -> "${room}" as "${players[socket.id].name}"`);
  });

  // ----------------------------------------------------------
  // ROOM BROWSER
  // ----------------------------------------------------------
  socket.on("getRooms", () => {
    const roomCounts = {};
    for (const id in players) {
      const room = players[id].room;
      roomCounts[room] = (roomCounts[room] || 0) + 1;
    }
    socket.emit("roomList", roomCounts);
  });

  // data: { room }
  socket.on("createRoom", (data) => {
    switchRoom(socket, data.room);
  });

  // data: { room }
  socket.on("changeRoom", (data) => {
    switchRoom(socket, data.room);
  });

  function switchRoom(socket, newRoom) {
    const player = players[socket.id];
    if (!player || !newRoom) return;

    const oldRoom = player.room;
socket.leave(oldRoom);
socket.to(oldRoom).emit("playerLeft", { id: socket.id });

ensureRoomNpcStore(newRoom);
socket.join(newRoom);
player.room = newRoom;
clearRoomIfEmpty(oldRoom);

    socket.emit("init", {
      id: socket.id,
      players: getPlayersInRoom(newRoom),
      npcs: getNpcsInRoom(newRoom),
    });

    socket.to(newRoom).emit("playerJoined", { id: socket.id, ...player });
    console.log(`[room change] ${socket.id}: "${oldRoom}" -> "${newRoom}"`);
  }

  // ----------------------------------------------------------
  // MOVEMENT
  // data: { x, y, z, rotation }
  // ----------------------------------------------------------
socket.on("playerMove", (data) => {
  const player = players[socket.id];
  if (!player) return;

  player.x = data.x;
  player.y = data.y;
  player.z = data.z;
  player.pitch = data.pitch;
  player.yaw = data.yaw;
  player.roll = data.roll;

  socket.to(player.room).emit("playerMoved", {
    id: socket.id,
    x: player.x,
    y: player.y,
    z: player.z,
    pitch: player.pitch,
    yaw: player.yaw,
    roll: player.roll,
  });
});

  // ----------------------------------------------------------
  // STANCE (standing / crouching / prone, etc.)
  // data: { stance }
  // ----------------------------------------------------------
  socket.on("playerStance", (data) => {
    const player = players[socket.id];
    if (!player) return;

    player.stance = data.stance;

    socket.to(player.room).emit("playerStanceChanged", {
      id: socket.id,
      stance: player.stance,
    });
  });

  // ----------------------------------------------------------
  // MONTAGE / ANIMATION EVENTS
  // For one-shot anims (reload, melee, emotes, death anim, etc.)
  // data: { montageName, playRate (optional) }
  // ----------------------------------------------------------
  socket.on("playMontage", (data) => {
    const player = players[socket.id];
    if (!player) return;

    socket.to(player.room).emit("playMontage", {
      id: socket.id,
      montageName: data.montageName,
      playRate: data.playRate || 1.0,
    });
  });

  // ----------------------------------------------------------
  // AIMING
  // data: { isAiming: bool }
  // ----------------------------------------------------------
  socket.on("playerAim", (data) => {
    const player = players[socket.id];
    if (!player) return;

    player.isAiming = !!data.isAiming;

    socket.to(player.room).emit("playerAimChanged", {
      id: socket.id,
      isAiming: player.isAiming,
    });
  });

  // ----------------------------------------------------------
  // WEAPON FIRE
  // Server doesn't validate hit/damage here directly — pair this
  // with a separate "playerDamage" call from the shooter's client
  // (or better: server-authoritative hit detection later).
  // data: { weapon, origin: {x,y,z}, direction: {x,y,z} }
  // ----------------------------------------------------------
  socket.on("weaponFire", (data) => {
    const player = players[socket.id];
    if (!player) return;

    socket.to(player.room).emit("weaponFired", {
      id: socket.id,
      weapon: data.weapon,
      origin: data.origin,
      direction: data.direction,
    });
  });
  
  socket.on("playerGait", (data) => {
  const player = players[socket.id];
  if (!player) return;

  player.gait = data.gait;

  socket.to(player.room).emit("playerGaitChanged", {
    id: socket.id,
    gait: player.gait,
  });
});

  // ----------------------------------------------------------
  // ITEM / WEAPON SWITCHING
  // data: { itemName }
  // ----------------------------------------------------------
  socket.on("itemChange", (data) => {
    const player = players[socket.id];
    if (!player) return;

    player.currentWeapon = data.itemName;

    socket.to(player.room).emit("itemChanged", {
      id: socket.id,
      itemName: player.currentWeapon,
    });
  });

  // ----------------------------------------------------------
  // HEALTH / DAMAGE
  // data: { targetId, amount }
  // Server is authoritative on HP value.
  // ----------------------------------------------------------
  socket.on("playerDamage", (data) => {
    const target = players[data.targetId];
    if (!target) return;

    target.hp = Math.max(0, target.hp - data.amount);

    io.to(target.room).emit("playerHealthUpdate", {
      id: data.targetId,
      hp: target.hp,
    });

    if (target.hp === 0) {
      io.to(target.room).emit("playerDied", {
        id: data.targetId,
        killerId: socket.id,
      });
    }
  });

  // data: { x, y, z }
  socket.on("playerRespawn", (data) => {
    const player = players[socket.id];
    if (!player) return;

    player.hp = 100;
    player.x = data?.x ?? 0;
    player.y = data?.y ?? 0;
    player.z = data?.z ?? 0;

    io.to(player.room).emit("playerRespawned", {
      id: socket.id,
      x: player.x,
      y: player.y,
      z: player.z,
      hp: player.hp,
    });
  });

  // ----------------------------------------------------------
  // CHAT
  // data: { message }
  // ----------------------------------------------------------
  socket.on("chatMessage", (data) => {
    const player = players[socket.id];
    if (!player) return;

    io.to(player.room).emit("chatMessage", {
      id: socket.id,
      name: player.name,
      message: data.message,
      timestamp: Date.now(),
    });
  });

  // ----------------------------------------------------------
  // NPC SYNC
  // One client (e.g. host, or whoever spawned it) drives NPC
  // state and broadcasts updates; everyone else just receives.
  // ----------------------------------------------------------

  // data: { npcId, type, x, y, z, rotation, hp }
  socket.on("npcSpawn", (data) => {
    const player = players[socket.id];
    if (!player) return;

    ensureRoomNpcStore(player.room);
    npcs[player.room][data.npcId] = {
      type: data.type,
      x: data.x,
      y: data.y,
      z: data.z,
      rotation: data.rotation || 0,
      hp: data.hp ?? 100,
    };

    io.to(player.room).emit("npcSpawned", {
      npcId: data.npcId,
      ...npcs[player.room][data.npcId],
    });
  });

  // data: { npcId, x, y, z, rotation }
socket.on("npcMove", (data) => {
  const player = players[socket.id];
  if (!player) return;
  const npc = npcs[player.room]?.[data.npcId];
  if (!npc) return;

  npc.x = data.x;
  npc.y = data.y;
  npc.z = data.z;
  if (data.pitch !== undefined) npc.pitch = data.pitch;
  if (data.yaw !== undefined) npc.yaw = data.yaw;
  if (data.roll !== undefined) npc.roll = data.roll;
  if (data.stance !== undefined) npc.stance = data.stance;
  if (data.gait !== undefined) npc.gait = data.gait;
  if (data.currentWeapon !== undefined) npc.currentWeapon = data.currentWeapon;

  socket.to(player.room).emit("npcMoved", {
    npcId: data.npcId,
    x: npc.x,
    y: npc.y,
    z: npc.z,
    pitch: npc.pitch,
    yaw: npc.yaw,
    roll: npc.roll,
    stance: npc.stance,
    gait: npc.gait,
    currentWeapon: npc.currentWeapon,
  });
});

// data: { npcId, isAiming }
socket.on("npcAim", (data) => {
  const player = players[socket.id];
  if (!player) return;
  const npc = npcs[player.room]?.[data.npcId];
  if (!npc) return;

  npc.isAiming = !!data.isAiming;

  socket.to(player.room).emit("npcAimChanged", {
    npcId: data.npcId,
    isAiming: npc.isAiming,
  });
});

// data: { npcId, weapon, origin: {x,y,z}, direction: {x,y,z} }
socket.on("npcWeaponFire", (data) => {
  const player = players[socket.id];
  if (!player) return;

  socket.to(player.room).emit("npcWeaponFired", {
    npcId: data.npcId,
    weapon: data.weapon,
    origin: data.origin,
    direction: data.direction,
  });
});

  // data: { npcId, amount }
  socket.on("npcDamage", (data) => {
    const player = players[socket.id];
    if (!player) return;
    const npc = npcs[player.room]?.[data.npcId];
    if (!npc) return;

    npc.hp = Math.max(0, npc.hp - data.amount);

    io.to(player.room).emit("npcHealthUpdate", {
      npcId: data.npcId,
      hp: npc.hp,
    });

    if (npc.hp === 0) {
      io.to(player.room).emit("npcDied", { npcId: data.npcId });
      delete npcs[player.room][data.npcId];
    }
  });

  // ----------------------------------------------------------
  // LATENCY CHECK
  // ----------------------------------------------------------
  socket.on("ping", () => {
    socket.emit("pong");
  });

  // ----------------------------------------------------------
  // DISCONNECT
  // ----------------------------------------------------------
  socket.on("disconnect", (reason) => {
    const player = players[socket.id];
    console.log(`[disconnect] ${socket.id} (${reason})`);

    if (player) {
  socket.to(player.room).emit("playerLeft", { id: socket.id });
  const oldRoom = player.room;
  delete players[socket.id];
  clearRoomIfEmpty(oldRoom);
}
  });

  socket.on("error", (err) => {
    console.error(`[socket error] ${socket.id}:`, err);
  });
});

// ------------------------------------------------------------
// Start
// ------------------------------------------------------------
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Socket.IO server running on port ${PORT}`);
});