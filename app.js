require('dotenv').config();
const fs = require('fs');
const mongoose = require('mongoose');
const mysql = require('mysql');
const msg = require("./msg"); // 스키마 불러오기

const configs = {
  mongo: {
    user: process.env.MONGO_USER, //user: 'root',
    pass: process.env.MONGO_PASSWORD, //pass: 'changeme',
    useNewUrlParser: true,
    useUnifiedTopology: true 
  },
  mysql: {
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_SCHEMA,
    connectionLimit: 30,
    charset : 'utf8mb4' // emoji 지원
  },
  mongoUri: process.env.MONGO_URI,
  port: Number(process.env.SOCKET_PORT) || 3000,
  socketIo: {
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
      transports: ["websocket"],
      credentials: true
    }
  }
}
const info = {
  chatDB_connect: false // 몽고DB 커넥션에 따라 DB접근 분기
}

const server = () => { // HTTPS / HTTP 서버 분기
  if (process.env.NODE_ENV === 'production') {
    console.log('Use SSL');
    return require('https').createServer({
      key: fs.readFileSync(process.env.SSL_KEY),
      cert: fs.readFileSync(process.env.SSL_CERT),
      secure:true,
      reconnect: true,
      rejectUnauthorized : false
    }).listen(configs.port)
  }
  console.log('Unuse SSL');
  return require('http').createServer().listen(configs.port, function () {
    console.log('Server On');
  });
}
console.log('[Step 1] Create Http Server');
const io = require('socket.io')(server(), configs.socketIo);
console.log('[Step 2] Attach Socket Io Server');
const connectMongoDB = () => {
  mongoose.connect(configs.mongoUri, configs.mongo, (err) => {
    if (err) { 
      console.error(err);   // throw err;
    }
    else {
      info.chatDB_connect = true;
      console.log('[Step 3] MongoDB Connect');
    }
  });
  mongoose.Promise = global.Promise;
  return mongoose.connection;
}
console.log('MongoDB Connecting');
const MongoDB = connectMongoDB();

const database = mysql.createPool(configs.mysql);
database.getConnection(function (err) {
  if (err) {
    console.error('error connecting: ' + err.stack);
    return;
  }

  console.log('[Step 4] MySQL Connect');
  console.log('connected as id ' + database.threadId);
});

/////////////////////////////////////////////////////////////////////////////////////////////////
const messageQueue = new Array();
const mongoMsgs = new Map();
const userCache = new Map();

const getUser = (userId) => {
  if(userCache.has(userId)) {
    const user = userCache.get(userId);
    return user.url;
  }

  database.query('SELECT xe_files.path, xe_files.filename FROM xe_user, xe_files WHERE xe_user.id = ? AND xe_user.profile_image_id = xe_files.id',
    [userId]
    , (error, results, fields) => {
      if(error) {
        console.log(error);
      }
      if(results.length > 0) {
        userCache.set(userId, {url: '/storage/app/' + results[0].path + '/' + results[0].filename, last_use: new Date()});
      }
    }
  );
  return "";
}

let timer = null;
setInterval(() => {
  if(timer) return;
  const now = new Date();
  const next = new Date(now.getTime());
  next.setDate(next.getDate()+3)
  next.setHours(0,0,0,0);

  timer = setTimeout(() => {
    userCache.clear();
    timer = null;
  },next.getTime() - now.getTime());
}, 1000*60*60*12);


io.sockets.on('connection', (socket) => {
  console.log('New Connect Socket :: ' + socket.id);
  const headers = socket.handshake.headers; // 소켓 헤더
  if(headers.auth) { // 헤더에 auth가 있으면 정보 기입
    socket.auth = JSON.parse(headers.auth);
    // userMap.set(socket.auth.userId, socket.auth);
  }
  else { // 없으면 Guest 설정
    socket.auth = {
      userId: 'guest-' + new Date().getTime(),
      displayname: 'guest',
      isGuest: true
    }
  }
  console.log(socket.auth);
  socket.otherRooms = []; // 다른 방 메시지 구독 리스트 [roomId]
  socket.lastMsgByRoom = new Map(); // 룸별로 마지막으로 읽은 메시지 id 저장 (roomId - msgId)
  socket.prevMsgByRoom = new Map();
  /**
   * socket에 사용자 계정정보 저장 이벤트 -> complete 이벤트로 반환
   */
  socket.on('setAuth', (data) => { // {displayname, userId}
    if(data.displayname) {
      socket.auth.displayname = data.displayname;
    }
    if(data.userId) {
      socket.auth.userId = data.userId;
      socket.auth.isGuest = false;
    }
    if(data.profileImage) {
      socket.auth.profileImage = data.profileImage;
    }
    socket.emit('complete', {type: 'setAuth', status: true});
  });
  /**
   * 방 입장/나가기 -> complete 이벤트로 반환
   */
  socket.on('leaveRoom', (data) => {
    socket.leave(data.roomId);
    socket.emit('complete', {type: 'leaveRoom', roomId: data.roomId, status: true});
  });
  socket.on('joinRoom', (data) => { // {roomId}
    socket.roomId = data.roomId;
    socket.join(data.roomId);
    socket.emit('complete', {type: 'joinRoom', roomId: data.roomId, status: true});
  });
  /**
   * 클라이언트->클라이언트 메시지 관련 처리 이벤트
   */
  socket.on('message', (data) => { // {content, type[, roomId, msgId]}
    switch(data.type) {
      case 'chat': // 채팅
        sendChat(socket, data.roomId, data.content)
        break;
      case 'remove': // 채팅을 지우는 명령
        remove(data.roomId, data.content);
        break;
      case 'room': // room에 브로드캐스트
        sendRoom(socket, data.roomId, data.content);
        break;
      case 'broadcast': // 모든 소켓에 브로드캐스트
        sendBroadcast(socket, data.content);
        break;
    }
  });
  // 채팅 히스토리
  socket.on('history', (data) => { // {roomId, isFirst, lastMsg, count}
    getHistory(socket, data.roomId, data.isFirst, data.lastMsg, data.count);
  });
  /**
   * 내가 속한 다른 방의 메시지를 수신하기 위한 이벤트
   */
  // 다른 방 메시지 구독(수신)
  socket.on('subscriptionRoom', (data) => { 
    socket.otherRooms = data.rooms;
  });
  // 마지막으로 받은 메시지를 서버에 저장
  socket.on('receive', (data) => {
    if(!data.roomId) return;
    socket.lastMsgByRoom.set(data.roomId, data.msgId);
  })
  /**
   * 미사용
   */
  socket.on('listRoom', () => {
    console.log(io.sockets.adapter.rooms);
    socket.emit('listRoom', io.sockets.adapter.rooms);
  });
  socket.on('listSocket', (data) => {
    // console.log('listSocket', io.sockets.sockets);
  });
  socket.on('disconnect', () => {
    
  });
});
function includesArray(origin, finds) {
  for(let i=0; i<finds.length; i++) {
    if(origin.includes(finds[i])) return true;
  }
  return false;
}
// 채팅
const sendChat = (socket, roomId, content) => {
  console.log(roomId, content);

  if(!socket.auth.isGuest) {
    userCache.set(socket.auth.userId, {url: socket.auth.profileImage, last_use: new Date()});
  }

  if(!info.chatDB_connect) {
    const data = {
      "msgId": new Date().getTime(),
      "roomId": roomId,
      "userId": socket.auth.userId,
      "displayname": socket.auth.displayname,
      "profileImage": userCache.get(socket.auth.userId),
      "content": content,
      "time": Date.now(),
    }
    io.to(roomId).emit('msg', {...data, type: "chat"});
    messageQueue.push({...data, type: "chat"});
    return;
  }

  if(mongoMsgs.has(roomId)) {
    mongoMsgs.get(roomId).push({socket, content, time: new Date()});
  }
  else {
    mongoMsgs.set(roomId, [{socket, content, time: new Date()}]);
  }
}


(() => {
  let roomSize = 0;
  let goal = 0;

  setInterval(() => {
    if(roomSize != goal) return;
    roomSize = 0;
    goal = mongoMsgs.size;
    if(goal === 0) return;

    console.log('process');

    for (const roomMsgs of mongoMsgs) {
      const mongoMsgQueue = roomMsgs[1];
      const roomId = roomMsgs[0];

      msg.find({room: roomId}).sort({msg_id: -1}).limit(1).then(row => {
        const id = row.length === 0 ? 0 : row[0].msg_id;
        const size = mongoMsgQueue.length;
        const msgs = [];
        console.log('find', size, id);

        for(let i=0; i<size; i++) {
          msgs.push({
            msg_id: id+i+1,
            room: roomId,
            uuId: mongoMsgQueue[i].socket.auth.userId,
            displayname: mongoMsgQueue[i].socket.auth.displayname,
            content: mongoMsgQueue[i].content,
            time: mongoMsgQueue[i].time
          });

          const data = {
            msgId: id+i+1,
            roomId: roomId,
            userId: mongoMsgQueue[i].socket.auth.userId,
            profileImage: getUser(mongoMsgQueue[i].socket.auth.userId),
            displayname: mongoMsgQueue[i].socket.auth.displayname,
            content: mongoMsgQueue[i].content,
            time: mongoMsgQueue[i].time,
          }

          io.to(roomId).emit('msg', {...data, type: "chat"});
          messageQueue.push({...data, type: "chat"});
        }

        msg.insertMany(msgs).then((res) => {
          const msgRoom = mongoMsgs.get(roomId);

          if(msgRoom.length - size === 0) {
            mongoMsgs.delete(roomId);
          }
          else {
            mongoMsgs.set(roomId, msgRoom.slice(size));
          }

          console.log('size', ++roomSize, id+size);

          const lastMessage = msgs[size-1];

          if(!lastMessage.content.text) {
            database.query('UPDATE xe_chat_rooms SET last_message_id = ?, last_message_time = ? WHERE id = ? AND last_message_id < ?',
              [lastMessage.msg_id, lastMessage.time, roomId, lastMessage.msg_id],
              (error, results, fields) => {
                if(error) {
                  console.log(error);
                }
              }
            );
          }
          else {
            database.query('UPDATE xe_chat_rooms SET last_message = ?, last_message_id = ?, last_message_time = ? WHERE id = ? AND last_message_id < ?',
              [lastMessage.content.text, lastMessage.msg_id, lastMessage.time, roomId, lastMessage.msg_id],
              (error, results, fields) => {
                if(error) {
                  console.log(error);
                }
              }
            );
          }
        });
      });
    }
  }, 500);
})();


const getHistory = (socket, roomId, first, lastMsg, count = 40) => {
  if(!roomId) return;

  if(first) {
    msg.find({room: roomId}).sort({msg_id: -1}).limit(count)
    .then(history => {
      if(Array.isArray(history) && history.length === 0) {
        return;
      }
      const messages = history.map(chat =>
        ({
          "msgId": chat.msg_id,
          "roomId": chat.room,
          "userId": chat.uuId,
          "displayname":chat.displayname,
          "content": chat.content,
          "profileImage": getUser(chat.uuId) || "",
          "time": chat.time
        })
      );
      
      socket.emit('history',
        {
          "roomId": roomId,
          "messages": messages,
          "isFirst": true
        }
      );
    }).catch(err => {console.error(err)});
    return;  
  }
  msg.find({room: roomId}).where('msg_id').lt(lastMsg).sort({msg_id: -1}).limit(count)
  .then(history => {
    if(Array.isArray(history) && history.length === 0) {
      return;
    }
    const messages = history.map(chat =>
      ({
        "msgId": chat.msg_id,
        "roomId": chat.room,
        "userId": chat.uuId,
        "displayname": chat.displayname,
        "content": chat.content,
        "time": chat.time
      })
    );
    socket.emit('history',
      {
        "messages": messages,
        "isFirst": false,
        "roomId": roomId
      }
    );
  }).catch(err => {console.error(err)});
}
// 채팅 지우기
const remove = async (roomId, msgId) => {
  if(!info.chatDB_connect) {
    io.to(roomId).emit('msg', {type: 'remove', msgId});
    return;
  }
  await msg.findByIdAndUpdate(msgId, {$set: {content: '삭제된 메시지입니다.', type: 'text'}});
  io.to(roomId).emit('msg', {type: 'remove', msgId});
}
// 룸 브로드캐스트
const sendRoom = (socket, roomId, content) => {
  io.to(roomId).emit('msg',
    {
      displayname: socket.auth.displayname,
      userId: socket.auth.userId,
      content: content,
      type: 'room'
    }
  );
}
// 소켓 브로드캐스트
const sendBroadcast = (socket, content) => {
  io.emit('msg',
    {
      displayname: socket.auth.displayname,
      userId: socket.auth.userId,
      content: content,
      type: 'broadcast'
    }
  );
}


(() => {
  let lock = false;
  setInterval(() => {
    if(lock) return;
    lock = true;

    for(const socket of io.sockets.sockets) {
      if(socket[1].auth.isGuest) continue;
      for(const roomMsg of socket[1].lastMsgByRoom) {
        if(socket[1].prevMsgByRoom.get(roomMsg[0]) === roomMsg[1]) continue;

        database.query('UPDATE `xe_chat_room_user` SET `last_message_id` = ? WHERE `chat_room_id` = ? AND `user_id` = ?',
          [roomMsg[1], roomMsg[0], socket[1].auth.userId]
          , (error, results, fields) => {
            if(error) {
              console.log(error);
            }
            socket[1].prevMsgByRoom.set(roomMsg[0], roomMsg[1]);
          }
        );
      }
    }
    lock = false;
  }, 500);
})();

/**
 * [클라이언트] 채팅방 리스트 내에 있는 방 채팅 수신
 */
(() => {
  let lock = false;
  setInterval(() => {
    if(lock) return;
    lock = true;
    const socketMsgs = new Map();
    for(let i=0; messageQueue.length; i++) {
      const message = messageQueue.shift();
      for(const socket of io.sockets.sockets) {
        if(socket[1].otherRooms && includesArray(socket[1].otherRooms, ['manager', message.roomId])) {
          if(message.msgId > (socket[1].lastMsgByRoom.get(message.roomId) || 0)) {
            if(socketMsgs.has(socket[0])) {
              socketMsgs.get(socket[0]).messages.push(message);
            }
            else {
              socketMsgs.set(socket[0], {socket: socket[1], messages: [message]});
            }
          }
        }
      }
    }
    for(const socketMsg of socketMsgs) {
      socketMsg[1].socket.emit('msg', {content: socketMsg[1].messages, type: 'chats'});
    }
    lock = false;
  }, 1000);
})();
