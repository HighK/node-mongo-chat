const mongoose = require("mongoose");

const chatMsg = new mongoose.Schema({    
    room : String,
    uuId : String,
    name : String,
    message : String,
    time : { type: Date, default: Date.now },
    _id: {type: Number, default: 1 }
})

module.exports = mongoose.model("messages", chatMsg);