// Code.gs - Betrayal Web (完整版 GAS 後端)
// 請確保你的 Spreadsheet 有下列 sheets 且第一列為 header（createInitialSheets 可建立）
const SPREADSHEET_ID = SpreadsheetApp.getActive().getId();

// ------------------ Sheet Utilities ------------------
function getSheet(name){ return SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(name); }
function readSheet(name){
  const sheet = getSheet(name);
  if (!sheet) return [];
  const values = sheet.getDataRange().getValues();
  if (values.length === 0) return [];
  const headers = values.shift();
  return values.map(row => {
    const obj = {};
    for (let i=0;i<headers.length;i++) obj[headers[i]] = row[i];
    return obj;
  });
}
function writeSheet(name, data){
  const sheet = getSheet(name);
  if (!sheet) throw new Error("Sheet " + name + " not found");
  const headers = sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0];
  // clear old rows
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) sheet.getRange(2,1,lastRow-1, headers.length).clearContent();
  if (data.length === 0) return;
  const rows = data.map(obj => headers.map(h => obj[h] === undefined ? "" : obj[h]));
  sheet.getRange(2,1,rows.length, rows[0].length).setValues(rows);
}

// ------------------ Initializer (optional) ------------------
function createInitialSheets(){
  // headers for each sheet
  const specs = {
    "Players":["roomId","playerId","name","speed","might","sanity","knowledge","x","y","floor","role"],
    "Tiles":["roomId","tileName","x","y","floor","rotated","discovered"],
    "Decks":["roomId","cardType","cardsRemaining"],
    "Cards":["roomId","name","type","description"],
    "PlayerCards":["roomId","playerId","cardName","type","description","used"],
    "GameState":["roomId","key","value"],
    "Chat":["roomId","playerId","name","message","timestamp","type","receiver"]
  };
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  Object.keys(specs).forEach(name=>{
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    const headers = specs[name];
    sh.clear();
    sh.getRange(1,1,1,headers.length).setValues([headers]);
  });
  return "Sheets created/initialized";
}

// ------------------ Room Management ------------------
function createRoom(roomName){
  const roomId = "R"+new Date().getTime();

  const gs = readSheet("GameState");
  gs.push({roomId, key:"hauntTriggered", value:"false"});
  gs.push({roomId, key:"hauntScenario", value:0});
  gs.push({roomId, key:"traitor", value:"none"});
  gs.push({roomId, key:"omenCount", value:0});
  writeSheet("GameState", gs);

  // ⭐ 初始化起始房間
  initEntranceTile(roomId);

  return roomId;
}


// ------------------ Player Management ------------------
function addPlayer(name){
  const id = "P"+new Date().getTime();
  return {playerId:id, name};
}

function addPlayerToRoom(name, roomId){
  const allPlayers = readSheet("Players").filter(p => p.roomId !== roomId);
  const roomPlayers = readSheet("Players").filter(p => p.roomId === roomId);
  const newPlayer = {
    roomId: roomId,
    playerId: "P" + (roomPlayers.length + 1),
    name: name,
    speed: 4,
    might: 3,
    sanity: 4,
    knowledge: 3,
    x: 0,
    y: 0,
    floor: "Ground",
    role: ""
  };
  roomPlayers.push(newPlayer);
  writeSheet("Players", allPlayers.concat(roomPlayers));
  return newPlayer;
}
function getRoomPlayers(roomId){
  return readSheet("Players").filter(p => p.roomId === roomId);
}
function getTilePool(){
  const rows = readSheet("素材");
  return rows.map(r => ({
    id: r["房間ID"],
    name: r["房間名稱"],
    color: r["牌背顏色"],
    floors: r["適用樓層"]
      .split(",")
      .map(f => normalizeFloor(f.trim())),
    type: normalizeType(r["類型"]),
    effect: r["功能說明 / 判定機制"] || "",
    lore: r["背景介紹"] || ""
  }));
}



// ------------------ Tile pool & helpers ------------------


function tileExists(x,y,floor,roomId){
  return readSheet("Tiles").some(t => t.roomId===roomId && Number(t.x)===Number(x) && Number(t.y)===Number(y) && t.floor===floor);
}
function getRandomTileForFloor(floor){
  const pool = getTilePool(); // ← 從 Sheets 讀
  const avail = pool.filter(t => t.floors.includes(floor));
  if (avail.length === 0) return null;
  return avail[Math.floor(Math.random() * avail.length)];
}


// ------------------ Move & Explore ------------------
function movePlayer(playerId, dx, dy, roomId){
  const allPlayers = readSheet("Players").filter(p => p.roomId !== roomId);
  const players = readSheet("Players").filter(p => p.roomId === roomId);
  const tilesAll = readSheet("Tiles").filter(t => t.roomId !== roomId);
  const tiles = readSheet("Tiles").filter(t => t.roomId === roomId);
  const p = players.find(x=>x.playerId===playerId);
  if (!p) return {error:"player not found"};
  const newX = Number(p.x) + Number(dx);
  const newY = Number(p.y) + Number(dy);
  const floor = p.floor;
  // auto-generate tile if not exists
  if (!tileExists(newX,newY,floor,roomId)){
    const tile = getRandomTileForFloor(floor);
    tiles.push({roomId, tileName: tile.name, x: newX, y: newY, floor: floor, rotated: 0, discovered: "TRUE"});
    // if tile triggers card, draw
    if (tile.type && tile.type !== "none") {
      drawCard(tile.type, roomId);
    }
  }
  p.x = newX; p.y = newY;
  writeSheet("Players", allPlayers.concat(players));
  writeSheet("Tiles", tilesAll.concat(tiles));
  return p;
}

// ------------------ Decks / Cards ------------------
function drawCard(type, roomId){
  // simplified: pick random card of that type from Cards (room-specific)
  const decks = readSheet("Decks").filter(d=>d.roomId===roomId);
  const cards = readSheet("Cards").filter(c=>c.roomId===roomId);
  const deck = decks.find(d=>d.cardType===type);
  if (!deck || Number(deck.cardsRemaining) <= 0) return {error:"no cards"};
  const pool = cards.filter(c=>c.type === type);
  if (pool.length===0) return {error:"no card pool"};
  const picked = pool[Math.floor(Math.random()*pool.length)];
  // decrement deck count
  deck.cardsRemaining = Number(deck.cardsRemaining) - 1;
  // persist decks
  const others = readSheet("Decks").filter(d=>d.roomId!==roomId);
  writeSheet("Decks", others.concat(decks));
  // if omen -> update omenCount and maybe trigger haunt
  if (type === "omen") {
    const gs = readSheet("GameState").filter(g=>g.roomId===roomId);
    const allGs = readSheet("GameState").filter(g=>g.roomId!==roomId);
    const oRow = gs.find(r=>r.key==="omenCount");
    oRow.value = Number(oRow.value||0) + 1;
    // trigger haunt if omenCount >= player count and not yet triggered
    const hauntRow = gs.find(r=>r.key==="hauntTriggered");
    if (Number(oRow.value) >= readSheet("Players").filter(p=>p.roomId===roomId).length && hauntRow.value !== "true") {
      triggerHaunt(roomId);
      // announce in chat
      sendMessageToRoom("SYSTEM","System","Haunt triggered!",roomId,"system","");
    }
    writeSheet("GameState", allGs.concat(gs));
  }
  return {ok:true, card:picked};
}

// ------------------ Haunt ------------------
function triggerHaunt(roomId){
  const players = readSheet("Players").filter(p=>p.roomId===roomId);
  if (players.length===0) return;
  const gsAll = readSheet("GameState").filter(g=>g.roomId!==roomId);
  const gs = readSheet("GameState").filter(g=>g.roomId===roomId);
  const traitorIndex = Math.floor(Math.random()*players.length);
  const traitor = players[traitorIndex].playerId;
  const scenario = Math.floor(Math.random()*50)+1; // placeholder
  const hRow = gs.find(g=>g.key==="hauntTriggered");
  const tRow = gs.find(g=>g.key==="traitor");
  const sRow = gs.find(g=>g.key==="hauntScenario");
  if (hRow) hRow.value = "true";
  if (tRow) tRow.value = traitor;
  if (sRow) sRow.value = scenario;
  writeSheet("GameState", gsAll.concat(gs));
}

// ------------------ Roles ------------------
function assignRoles(roleList, roomId){
  const allPlayers = readSheet("Players").filter(p=>p.roomId!==roomId);
  const players = readSheet("Players").filter(p=>p.roomId===roomId);
  if (roleList.length !== players.length) throw "role count mismatch";
  players.forEach((p,i)=> p.role = roleList[i] || "Hero");
  writeSheet("Players", allPlayers.concat(players));
  return players.map(p=>({playerId:p.playerId, role:p.role}));
}
function getVisibleRoles(playerId, roomId){
  const players = readSheet("Players").filter(p=>p.roomId===roomId);
  return players.map(p=>({
    playerId:p.playerId, name:p.name, role: p.playerId===playerId ? p.role : "???",
    x: p.x, y: p.y, floor: p.floor
  }));
}

// ------------------ PlayerCards ------------------
function getMyCards(playerId, roomId){
  return readSheet("PlayerCards").filter(c=>c.roomId===roomId && c.playerId===playerId && (c.used==="" || c.used==="FALSE" || c.used===false));
}
function useCard(playerId, cardName, roomId){
  const all = readSheet("PlayerCards").filter(c=>c.roomId!==roomId);
  const cards = readSheet("PlayerCards").filter(c=>c.roomId===roomId);
  const card = cards.find(c=>c.playerId===playerId && c.cardName===cardName && (c.used==="" || c.used==="FALSE" || c.used===false));
  if (!card) return {error:"card not found/used"};
  card.used = "TRUE";
  writeSheet("PlayerCards", all.concat(cards));
  // optionally apply effect (left as extension)
  sendMessageToRoom(playerId, getNameById(playerId, roomId), "used "+cardName, roomId, "system", "");
  return {ok:true, card};
}
function getNameById(playerId, roomId){
  const p = readSheet("Players").filter(pp=>pp.roomId===roomId).find(pp=>pp.playerId===playerId);
  return p ? p.name : playerId;
}

// ------------------ Chat (強化) ------------------
function sendMessageToRoom(playerId, name, message, roomId, type, receiver){
  const sheet = getSheet("Chat");
  sheet.appendRow([
    roomId,
    playerId,
    name,
    message,
    new Date(),          // 一律存 Date
    type || "player",
    receiver || ""
  ]);
  return true;
}

function getMessagesForRoom(playerId, roomId){
  const all = readSheet("Chat");

  // 1️⃣ 只取同一個 room
  const rows = all.filter(r => String(r.roomId) === String(roomId));

  // 2️⃣ 私聊過濾
  const filtered = rows.filter(m => {
    if (m.type === "private") {
      return m.playerId === playerId || m.receiver === playerId;
    }
    return true;
  });

  // 3️⃣ timestamp 統一轉 ISO（前端才不會炸）
  return filtered
    .map(m => ({
      roomId: m.roomId,
      playerId: m.playerId,
      name: m.name,
      message: String(m.message),
      timestamp: new Date(m.timestamp).toISOString(),
      type: m.type,
      receiver: m.receiver
    }))
    .sort((a,b)=> new Date(a.timestamp) - new Date(b.timestamp));
}


function normalizeFloor(f){
  if(f === "1F") return "Ground";
  if(f === "2F") return "Upper";
  if(f === "B1") return "Basement";
  return f;
}

function normalizeType(t){
  if(!t) return "none";
  if(t.includes("起始")) return "none";
  if(t.includes("事件")) return "event";
  if(t.includes("預兆")) return "omen";
  if(t.includes("物品")) return "item";
  if(t.includes("特殊")) return "special";
  return "none";
}


function initEntranceTile(roomId){
  const tilesAll = readSheet("Tiles").filter(t => t.roomId !== roomId);
  const tiles = readSheet("Tiles").filter(t => t.roomId === roomId);

  // 已存在就不重複放
  const exists = tiles.some(t =>
    Number(t.x) === 0 &&
    Number(t.y) === 0 &&
    t.floor === "Ground"
  );
  if (exists) return;

  // 從房間池找「系館大廳」
  const pool = getTilePool();
  const entrance = pool.find(t => t.name === "系館大廳");

  if (!entrance) throw new Error("找不到起始房間：系館大廳");

  tiles.push({
    roomId: roomId,
    tileName: entrance.name,
    x: 0,
    y: 0,
    floor: "Ground",
    rotated: 0,
    discovered: "TRUE"
  });

  writeSheet("Tiles", tilesAll.concat(tiles));
}

// ------------------ Frontend combined data ------------------
function getRoomData(roomId){
  const players = readSheet("Players").filter(p=>p.roomId===roomId);
  const tiles = readSheet("Tiles").filter(t=>t.roomId===roomId);

  const tilePool = getTilePool(); // 從素材表抓房間池資料

  // 將 effect/lore 加入每個 tile
  const tilesWithInfo = tiles.map(t => {
    const poolTile = tilePool.find(tp => tp.name === t.tileName);
    return {
      ...t,
      effect: poolTile?.effect || "",
      lore: poolTile?.lore || ""
    };
  });

  const gsObj = readSheet("GameState").filter(g=>g.roomId===roomId)
                 .reduce((acc,row)=>{acc[row.key]=row.value;return acc;},{}); 

  return {players, tiles: tilesWithInfo, haunt: gsObj};
}
// ------------------ DO GET ------------------
function doGet(e) {
  return HtmlService.createHtmlOutputFromFile('index')
}
