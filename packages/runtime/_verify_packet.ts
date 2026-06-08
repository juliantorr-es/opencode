const f = require("fs").readFileSync("src/context/packet.ts","utf8")
const lines = f.split("\n")
for (let i = 255; i < 285; i++) console.log((i+1)+": "+lines[i])
