const f = require("fs").readFileSync("src/campaign/binder.ts","utf8")
const lines = f.split("\n")
for (let i = 268; i < 330; i++) console.log((i+1)+": "+lines[i])
