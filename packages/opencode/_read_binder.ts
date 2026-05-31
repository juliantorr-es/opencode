const f = require("fs").readFileSync("src/campaign/binder.ts","utf8")
const lines = f.split("\n")
// getBinder area: around line 340-420
for (let i = 330; i < 500; i++) console.log((i+1)+": "+lines[i])
