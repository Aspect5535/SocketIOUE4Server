// ============================================================
// Socket.IO Game Server — Full Featured — for Unreal Engine 4
// ============================================================
// Covers: rooms, usernames, movement, stance, montages (anims),
// weapon fire, item/weapon switching, aiming, health sync,
// NPC sync, vehicle sync, wanted/bounty system, chat, room
// browser/creation.
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
//   name, room, x, y, z, pitch, yaw, roll,
//   stance, gait, hp, currentWeapon, isAiming,
//   bounty, lethalAuthorized
// }
let players = {};

// npcs[room][npcId] = { type, x, y, z, pitch, yaw, roll, stance, gait, hp, currentWeapon, isAiming }
let npcs = {};

// vehicles[room][vehicleId] = {
//   type,
//   driverType: "none" | "player" | "npc",
//   driverId: null | socketId | npcId,
//   passengers: [socketId, ...],
//   x, y, z, pitch, yaw, roll,
//   velocity: {x,y,z},
//   rotVelocity: {x,y,z},
//   wheels: [{ velTarget, strength }, ...],
//   hp, brokenWindows: []
// }
let vehicles = {};

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

function getVehiclesInRoom(room) {
  return vehicles[room] || {};
}

function ensureRoomVehicleStore(room) {
  if (!vehicles[room]) vehicles[room] = {};
}

function clearRoomIfEmpty(room) {
  const stillHasPlayers = Object.values(players).some((p) => p.room === room);
  if (!stillHasPlayers) {
    if (npcs[room]) {
      delete npcs[room];
      console.log(`[cleanup] room "${room}" emptied — NPCs cleared`);
    }
    if (vehicles[room]) {
      delete vehicles[room];
      console.log(`[cleanup] room "${room}" emptied — vehicles cleared`);
    }
  }
}

function getWantedTier(bounty) {
  if (bounty <= 0) return "UNFLAGGED";
  if (bounty <= 20) return "NOTICED";
  if (bounty <= 45) return "FLAGGED";
  if (bounty <= 70) return "TARGETED";
  if (bounty <= 90) return "HUNTED";
  return "TERMINATION ORDER";
}

function getLethalAuthorized(bounty) {
  return bounty > 50;
}

io.on("connection", (socket) => {
  console.log(`[connect] ${socket.id}`);

  // Uncomment for verbose debugging of every event received:
  // socket.onAny((eventName, ...args) => console.log(`[received] "${eventName}"`, args));

  // ----------------------------------------------------------
  // JOIN
  // data: { name, room (optional, defaults to "lobby"), x, y, z }
  // ----------------------------------------------------------
  socket.on("playerJoin", (data) => {
    const room = data?.room || "lobby";

    players[socket.id] = {
      name: data?.name || `Player_${socket.id.substring(0, 4)}`,
      room,
      x: data?.x ?? 0,
      y: data?.y ?? 0,
      z: data?.z ?? 0,
      pitch: 0,
      yaw: 0,
      roll: 0,
      stance: "standing",
      hp: 100,
      currentWeapon: "none",
      isAiming: false,
      bounty: 0,
      lethalAuthorized: false,
    };

    ensureRoomNpcStore(room);
    ensureRoomVehicleStore(room);
    socket.join(room);

    socket.emit("init", {
      id: socket.id,
      players: getPlayersInRoom(room),
      npcs: getNpcsInRoom(room),
      vehicles: getVehiclesInRoom(room),
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
    ensureRoomVehicleStore(newRoom);
    socket.join(newRoom);
    player.room = newRoom;
    clearRoomIfEmpty(oldRoom);

    socket.emit("init", {
      id: socket.id,
      players: getPlayersInRoom(newRoom),
      npcs: getNpcsInRoom(newRoom),
      vehicles: getVehiclesInRoom(newRoom),
    });

    socket.to(newRoom).emit("playerJoined", { id: socket.id, ...player });
    console.log(`[room change] ${socket.id}: "${oldRoom}" -> "${newRoom}"`);
  }

  // ----------------------------------------------------------
  // MOVEMENT
  // data: { x, y, z, moveForward, moveRight, pitch, yaw, roll }
  // ----------------------------------------------------------
  socket.on("playerMove", (data) => {
    const player = players[socket.id];
    if (!player) return;

    player.x = data.x;
    player.y = data.y;
    player.z = data.z;
    player.moveForward = data.moveForward;
    player.moveRight = data.moveRight;
    player.pitch = data.pitch;
    player.yaw = data.yaw;
    player.roll = data.roll;

    socket.to(player.room).emit("playerMoved", {
      id: socket.id,
      x: player.x,
      y: player.y,
      z: player.z,
      moveForward: player.moveForward,
      moveRight: player.moveRight,
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

  // ----------------------------------------------------------
  // GAIT
  // data: { gait }
  // ----------------------------------------------------------
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
  // HEALTH / DAMAGE (players)
  // data: { targetId, amount }
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
  // WANTED / BOUNTY SYSTEM
  // ----------------------------------------------------------

  // data: { targetId, amount, reason }
  // targetId lets the host (running witness NPC AI) report bounty against
  // whichever player actually committed the crime — not necessarily the
  // sender of this event.
  socket.on("bountyIncrease", (data) => {
    const target = players[data.targetId];
    if (!target) return;

    target.bounty = Math.max(0, Math.min(100, target.bounty + data.amount));
    target.lethalAuthorized = getLethalAuthorized(target.bounty);

    io.to(data.targetId).emit("bountyUpdate", {
      bounty: target.bounty,
      tier: getWantedTier(target.bounty),
      lethalAuthorized: target.lethalAuthorized,
    });

    io.to(target.room).emit("playerBountyChanged", {
      id: data.targetId,
      bounty: target.bounty,
      tier: getWantedTier(target.bounty),
      lethalAuthorized: target.lethalAuthorized,
    });

    console.log(`[bounty] ${target.name}: ${data.amount >= 0 ? "+" : ""}${data.amount} (${data.reason || "unspecified"}) -> total ${target.bounty} [${getWantedTier(target.bounty)}]`);
  });

  // Fully clears a player's bounty (e.g. paid off at a fixer/hacker NPC)
  socket.on("bountyPayoff", () => {
    const player = players[socket.id];
    if (!player) return;

    player.bounty = 0;
    player.lethalAuthorized = false;

    socket.emit("bountyUpdate", {
      bounty: 0,
      tier: getWantedTier(0),
      lethalAuthorized: false,
    });

    socket.to(player.room).emit("playerBountyChanged", {
      id: socket.id,
      bounty: 0,
      tier: getWantedTier(0),
      lethalAuthorized: false,
    });

    console.log(`[bounty] ${player.name}: paid off, now UNFLAGGED`);
  });

  // Passive decay — bounty slowly drops over time while not actively raised.
  // Runs once per connection at an interval; cleaned up on disconnect below.
  const bountyDecayInterval = setInterval(() => {
    const player = players[socket.id];
    if (!player || player.bounty <= 0) return;

    player.bounty = Math.max(0, player.bounty - 1);
    player.lethalAuthorized = getLethalAuthorized(player.bounty);

    socket.emit("bountyUpdate", {
      bounty: player.bounty,
      tier: getWantedTier(player.bounty),
      lethalAuthorized: player.lethalAuthorized,
    });

    socket.to(player.room).emit("playerBountyChanged", {
      id: socket.id,
      bounty: player.bounty,
      tier: getWantedTier(player.bounty),
      lethalAuthorized: player.lethalAuthorized,
    });
  }, 5000); // -1 every 5 seconds while bounty > 0

  // Broadcasts a committed crime to the room so the host's witness NPCs
  // (which run all NPC AI) can detect and react to it, even when the
  // crime was committed by a non-host client.
  // data: { crimeType, x, y, z, hearingRadius, committedBy }
  socket.on("crimeCommitted", (data) => {
    const player = players[socket.id];
    if (!player) return;

    socket.to(player.room).emit("crimeReported", {
      crimeType: data.crimeType,
      x: data.x,
      y: data.y,
      z: data.z,
      hearingRadius: data.hearingRadius,
      committedBy: data.committedBy,
    });
  });

  // ----------------------------------------------------------
  // NPC SYNC
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

  // data: { npcId, x, y, z, pitch, yaw, roll, stance, gait, currentWeapon }
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
  // VEHICLE SYNC
  // Vehicles are driven by whichever party currently controls
  // them: a player in the driver seat, an NPC (host-driven), or
  // nobody (host still broadcasts idle/parked vehicles so late
  // joiners and physics-relevant state stay in sync).
  // ----------------------------------------------------------

  // data: { vehicleId, type, x, y, z, pitch, yaw, roll, hp }
  socket.on("vehicleSpawn", (data) => {
    const player = players[socket.id];
    if (!player) return;

    ensureRoomVehicleStore(player.room);
    vehicles[player.room][data.vehicleId] = {
      type: data.type || "default",
      driverType: "none",
      driverId: null,
      passengers: [],
      x: data.x, y: data.y, z: data.z,
      pitch: data.pitch || 0, yaw: data.yaw || 0, roll: data.roll || 0,
      velocity: { x: 0, y: 0, z: 0 },
      rotVelocity: { x: 0, y: 0, z: 0 },
      wheels: [],
      hp: data.hp ?? 100,
      brokenWindows: [],
    };

    io.to(player.room).emit("vehicleSpawned", {
      vehicleId: data.vehicleId,
      ...vehicles[player.room][data.vehicleId],
    });
  });

  // data: { vehicleId, seat } — seat: "driver" or "passenger"
  socket.on("vehicleEnter", (data) => {
    const player = players[socket.id];
    if (!player) return;
    const vehicle = vehicles[player.room]?.[data.vehicleId];
    if (!vehicle) return;

    if (data.seat === "driver") {
      if (vehicle.driverType === "player") return; // already taken by a player
      vehicle.driverType = "player";
      vehicle.driverId = socket.id;
    } else {
      if (!vehicle.passengers.includes(socket.id)) {
        vehicle.passengers.push(socket.id);
      }
    }

    io.to(player.room).emit("vehicleEntered", {
      vehicleId: data.vehicleId,
      playerId: socket.id,
      seat: data.seat,
    });
  });

  // data: { vehicleId }
  socket.on("vehicleExit", (data) => {
    const player = players[socket.id];
    if (!player) return;
    const vehicle = vehicles[player.room]?.[data.vehicleId];
    if (!vehicle) return;

    if (vehicle.driverId === socket.id && vehicle.driverType === "player") {
      vehicle.driverType = "none";
      vehicle.driverId = null;
    }
    vehicle.passengers = vehicle.passengers.filter((id) => id !== socket.id);

    io.to(player.room).emit("vehicleExited", {
      vehicleId: data.vehicleId,
      playerId: socket.id,
    });
  });

  // Host assigns an NPC as the driver of a vehicle (e.g. pursuit AI, ambient traffic)
  // data: { vehicleId, npcId }
  socket.on("vehicleNpcEnter", (data) => {
    const player = players[socket.id];
    if (!player) return;
    const vehicle = vehicles[player.room]?.[data.vehicleId];
    if (!vehicle || vehicle.driverType === "player") return; // never override a real player

    vehicle.driverType = "npc";
    vehicle.driverId = data.npcId;

    io.to(player.room).emit("vehicleNpcEntered", {
      vehicleId: data.vehicleId,
      npcId: data.npcId,
    });
  });

  // Host releases an NPC driver (vehicle becomes unowned again)
  // data: { vehicleId }
  socket.on("vehicleNpcExit", (data) => {
    const player = players[socket.id];
    if (!player) return;
    const vehicle = vehicles[player.room]?.[data.vehicleId];
    if (!vehicle || vehicle.driverType !== "npc") return;

    vehicle.driverType = "none";
    vehicle.driverId = null;

    io.to(player.room).emit("vehicleNpcExited", { vehicleId: data.vehicleId });
  });

  // Full transform + physics state sync.
  // Allowed senders: the actual player driver, OR anyone (your host logic
  // decides who actually sends) when the vehicle has no player driver.
  // data: {
  //   vehicleId,
  //   x, y, z, pitch, yaw, roll,
  //   velocity: {x,y,z},
  //   rotVelocity: {x,y,z},
  //   wheels: [{ velTarget, strength }, ...]
  // }
  socket.on("vehicleMove", (data) => {
    const player = players[socket.id];
    if (!player) return;
    const vehicle = vehicles[player.room]?.[data.vehicleId];
    if (!vehicle) return;

    const isActualDriver = vehicle.driverType === "player" && vehicle.driverId === socket.id;
    const isUnownedOrNpc = vehicle.driverType === "none" || vehicle.driverType === "npc";
    if (!isActualDriver && !isUnownedOrNpc) return;

    vehicle.x = data.x;
    vehicle.y = data.y;
    vehicle.z = data.z;
    vehicle.pitch = data.pitch;
    vehicle.yaw = data.yaw;
    vehicle.roll = data.roll;
    if (data.velocity) vehicle.velocity = data.velocity;
    if (data.rotVelocity) vehicle.rotVelocity = data.rotVelocity;
    if (data.wheels) vehicle.wheels = data.wheels;

    socket.to(player.room).emit("vehicleMoved", {
      vehicleId: data.vehicleId,
      x: vehicle.x,
      y: vehicle.y,
      z: vehicle.z,
      pitch: vehicle.pitch,
      yaw: vehicle.yaw,
      roll: vehicle.roll,
      velocity: vehicle.velocity,
      rotVelocity: vehicle.rotVelocity,
      wheels: vehicle.wheels,
    });
  });

  // data: { vehicleId, amount }
  socket.on("vehicleDamage", (data) => {
    const player = players[socket.id];
    if (!player) return;
    const vehicle = vehicles[player.room]?.[data.vehicleId];
    if (!vehicle) return;

    vehicle.hp = Math.max(0, vehicle.hp - data.amount);

    io.to(player.room).emit("vehicleHealthUpdate", {
      vehicleId: data.vehicleId,
      hp: vehicle.hp,
    });

    if (vehicle.hp === 0) {
      io.to(player.room).emit("vehicleDestroyed", {
        vehicleId: data.vehicleId,
        by: socket.id,
      });
    }
  });

  // data: { vehicleId, windowName }
  socket.on("vehicleWindowBreak", (data) => {
    const player = players[socket.id];
    if (!player) return;
    const vehicle = vehicles[player.room]?.[data.vehicleId];
    if (!vehicle) return;

    if (!vehicle.brokenWindows.includes(data.windowName)) {
      vehicle.brokenWindows.push(data.windowName);
    }

    io.to(player.room).emit("vehicleWindowBroke", {
      vehicleId: data.vehicleId,
      windowName: data.windowName,
    });
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

    clearInterval(bountyDecayInterval);

    if (player) {
      // If this player was driving/riding in any vehicle, free up their seat
      const room = vehicles[player.room];
      if (room) {
        for (const vehicleId in room) {
          const vehicle = room[vehicleId];
          if (vehicle.driverType === "player" && vehicle.driverId === socket.id) {
            vehicle.driverType = "none";
            vehicle.driverId = null;
            socket.to(player.room).emit("vehicleExited", { vehicleId, playerId: socket.id });
          }
          if (vehicle.passengers.includes(socket.id)) {
            vehicle.passengers = vehicle.passengers.filter((id) => id !== socket.id);
            socket.to(player.room).emit("vehicleExited", { vehicleId, playerId: socket.id });
          }
        }
      }

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