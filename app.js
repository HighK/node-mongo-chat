require('dotenv').config();
const fs = require('fs');
const mongoose = require('mongoose');
const msg = require("./msg"); // 스키마 불러오기
const configs = {
  mongo: {
    user: process.env.MONGO_USER, //user: 'root',
    pass: process.env.MONGO_PASSWORD, //pass: 'changeme',
    useNewUrlParser: true,
    useUnifiedTopology: true 
  },
  mongoUri: process.env.MONGO_URI,
  port: 3001,
  socketIo: {
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    }
  }
}
const info = {
  chatDB_connect: false // 몽고DB 커넥션에 따라 DB접근 분기
}
const server = () => {
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
      console.log('[Step 3] MongoDB Connect');
    }
  });
  mongoose.Promise = global.Promise;
  return mongoose.connection;
}
console.log('MongoDB Connecting');
const database = connectMongoDB();
/////////////////////////////////////////////////////////////////////////////////////////////////
const messageQueue = new Array();
io.sockets.on('connection', (socket) => {
  console.log('New Connect Socket :: ' + socket.id);
  const headers = socket.handshake.headers; // 소켓 헤더
  if(headers.auth) { // 헤더에 auth가 있으면 정보 기입
    socket.auth = headers.auth;
    userMap.set(socket.auth.userId, socket.auth);
  }
  else { // 없으면 Guest 설정
    socket.auth = {
      userId: 'guest-' + new Date().getTime(),
      displayname: 'guest'
    }
  }
  socket.otherRooms = []; // 다른 방 메시지 구독 리스트 [roomId]
  socket.lastMsgByRoom = new Map(); // 룸별로 마지막으로 읽은 메시지 id 저장 (roomId - msgId)
  /**
   * socket에 사용자 계정정보 저장 이벤트 -> complete 이벤트로 반환
   */
  socket.on('setAuth', (data) => { // {displayname, userId}
    if(data.displayname) {
      socket.auth.displayname = data.displayname;
    }
    if(data.userId) {
      socket.auth.userId = data.userId;
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
  if(!info.chatDB_connect) {
    const data = {
      "msgId": new Date().getTime(),
      "roomId": roomId,
      "userId": socket.auth.userId,
      "name": socket.auth.displayname,
      "content": content,
      "time": Date.now(),
    }
    io.to(roomId).emit('msg', {...data, type: "chat"});
    messageQueue.push({...data, type: "chat"});
    return;
  }
  msg.find({room: data.roomId}).then(row => {
    new msg({
      _id: row.length === 0 ? 1 : row[0]._id,
      room: roomId,
      uuId: socket.auth.userId,
      name: socket.auth.displayname,
      content: content,
    })
    .save((error, saveData) => {
      if(error) {
        console.error(error);
        return;
      }
      const data = {
        "msgId": saveData._id,
        "roomId": roomId,
        "userId": socket.auth.userId,
        "name": socket.auth.displayname,
        "content": content,
        "time": Date.now(),
      }
      io.to(roomId).emit('msg', {...data, type: "chat"});
      messageQueue.push({...data, type: "chat"});
    });
  });
}
const getHistory = (socket, roomId, first, lastMsg, count = 40) => {
  if(first) {
    msg.find({room: roomId}).sort({time: -1}).limit(count).then(history => {
      if(Array.isArray(history) && history.length === 0) {
        return;
      }
      const messages = history.map(chat =>
        ({
          "msgId": chat._id,
          "roomId": chat.room,
          "userId": chat.uuId,
          "name":chat.name,
          "content": chat.content,
          "time": chat.time
        })
      )
      socket.emit('history',
        {
          "roomId": roomId,
          "lastMsg": messages[0].time,
          "messages": messages,
          "isFirst": true
        }
      );
    }).catch(err => {console.error(err)});
    return;  
  }
  msg.find({room: roomId}).where('_id').lt(lastMsg).sort({time: -1}).limit(count).then(history => {
    if(Array.isArray(history) && history.length === 0) {
      return;
    }
    const messages = history.map(chat =>
      ({
        "msgId": chat._id,
        "roomId": chat.room,
        "userId": chat.uuId,
        "name": chat.name,
        "content": chat.content,
        "time": chat.time
      })
    ).reverse();
    socket.emit('history',
      {
        "lastMsg": messagese[0].msgId,
        "messages": messages,
        "isFirst": true
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
  socket.broadcast.emit('msg',
    {
      displayname: socket.auth.displayname,
      userId: socket.auth.userId,
      content: content,
      type: 'broadcast'
    }
  );
}
/**
 * [클라이언트] 채팅방 리스트 내에 있는 방 채팅 수신
 */
(function () {
  let lock = false;
  setInterval(() => {
    if(lock) return;
    lock = true;
    const socketMsgs = new Map();
    for(let i=0; messageQueue.length; i++) {
      const message = messageQueue.shift();
      for(const socket of io.sockets.sockets) {
        if(includesArray(socket[1].otherRooms, ['manager', message.roomId])) {
          if(message.msgId > (socket[1].lastMsgByRoom.get(message.roomId) || 0)) {
            if(socketMsgs.has(socket[0])) {
              socketMsgs.get(socket[0]).messages.push(message);
            }
            else {
              socketMsgs.set({socket: socket[1], messages: [message]});
            }
          }
        }
      }
    }
    for(const socketMsg of socketMsgs) {
      socketMsg[1].socket.emit('msg', {content: socketMsg[1].messages, type: 'chats'});
    }
    lock = false;
  }, 2000);
})();