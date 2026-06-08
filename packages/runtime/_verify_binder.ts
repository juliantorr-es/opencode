const f = require("fs").readFileSync("src/campaign/binder.ts","utf8")
const lines = f.split("\n")
for (let i = 358; i < 380; i++) console.log((i+1)+": "+lines[i])
