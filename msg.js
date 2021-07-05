const mongoose = require("mongoose");

const chatMsg = new mongoose.Schema({    
    room : String,
    uuId : String,
    displayname : String,
    content : Object,
    time : { type: Date, default: Date.now },
    // _id: {type: Number, default: 1 },
    msg_id: {type: Number, default: 1 }
})

module.exports = mongoose.model("messages", chatMsg);
